import http.client
import json
import queue
import select
import socket
import threading
import time
import unittest

from engine import MAX_PHRASE, phrases
from scheduler import BusyError, Scheduler
from server import SpeechServer

PCM = b"\x01\x00\xff\xff" * 1200


class ControlledEngine:
    def __init__(self, fail=False):
        self.entered = threading.Event()
        self.release = threading.Event()
        self.calls = []
        self.fail = fail

    def chunks(self, text):
        self.calls.append(text)
        self.entered.set()
        if not self.release.wait(3):
            raise RuntimeError("Test release timed out")
        if self.fail:
            raise RuntimeError("Synthetic inference failure")
        yield PCM


def wait_for(predicate, timeout=2):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("Condition did not become true")


class SchedulerTests(unittest.TestCase):
    def setUp(self):
        self.engine = ControlledEngine()
        self.scheduler = Scheduler(self.engine)

    def tearDown(self):
        self.engine.release.set()
        self.scheduler.close()

    def test_running_cancellation_keeps_slot_until_inference_returns(self):
        first = self.scheduler.submit("first")
        self.assertTrue(self.engine.entered.wait(1))
        self.scheduler.cancel(first)
        second = self.scheduler.submit("second")
        with self.assertRaises(BusyError):
            self.scheduler.submit("third")
        self.assertIsNone(second.started_at)
        self.assertFalse(first.done.is_set())
        self.engine.release.set()
        self.assertTrue(second.done.wait(1))
        self.assertTrue(first.output.empty())
        self.assertEqual(second.output.get_nowait(), PCM)
        self.assertEqual(self.engine.calls, ["first", "second"])

    def test_canceling_waiter_frees_only_waiting_slot(self):
        self.scheduler.submit("first")
        self.assertTrue(self.engine.entered.wait(1))
        waiter = self.scheduler.submit("canceled")
        self.scheduler.cancel(waiter)
        replacement = self.scheduler.submit("replacement")
        self.assertTrue(waiter.done.is_set())
        self.engine.release.set()
        self.assertTrue(replacement.done.wait(1))
        self.assertEqual(self.engine.calls, ["first", "replacement"])

    def test_canceling_backpressure_stops_producing(self):
        class ManyChunks:
            def chunks(self, _):
                for _ in range(1000):
                    yield PCM
        scheduler = Scheduler(ManyChunks())
        try:
            job = scheduler.submit("bounded")
            wait_for(lambda: job.output.full())
            scheduler.cancel(job)
            self.assertTrue(job.done.wait(1))
            self.assertLessEqual(job.output.qsize(), 2)
        finally:
            scheduler.close()

    def test_phrase_split_keeps_words_and_bounds_work(self):
        text = "Start here. " + "small amount of blush " * 60
        parts = list(phrases(text))
        self.assertEqual(" ".join(parts).split(), text.split())
        self.assertTrue(all(0 < len(part) <= MAX_PHRASE for part in parts))


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.engine = ControlledEngine()
        self.scheduler = Scheduler(self.engine)
        self.server = SpeechServer(("127.0.0.1", 0), self.scheduler)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()
        self.port = self.server.server_address[1]

    def tearDown(self):
        self.engine.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.scheduler.close()
        self.thread.join(1)

    def request(self, body, content_type="application/json"):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request("POST", "/synthesize", body=body, headers={"Content-Type": content_type})
        return connection, connection.getresponse()

    def raw_request(self):
        connection = socket.create_connection(("127.0.0.1", self.port), timeout=2)
        body = json.dumps({"text": "A synthetic test."}).encode()
        connection.sendall(b"POST /synthesize HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body)
        return connection

    def test_health_is_responsive_while_worker_is_busy(self):
        self.scheduler.submit("busy")
        self.assertTrue(self.engine.entered.wait(1))
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=1)
        connection.request("GET", "/healthz")
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.read())["running"], 1)
        connection.close()

    def test_pcm_contract_has_no_wav_header(self):
        self.engine.release.set()
        connection, response = self.request(json.dumps({"text": "Hello."}))
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader("Content-Type"), "audio/pcm; rate=24000; channels=1")
        self.assertEqual(response.getheader("X-PCM-Format"), "s16le")
        self.assertEqual(response.read(), PCM)
        connection.close()

    def test_no_success_headers_before_first_audio_and_failures_are_http_errors(self):
        self.engine.fail = True
        connection = self.raw_request()
        self.assertTrue(self.engine.entered.wait(1))
        self.assertFalse(select.select([connection], [], [], 0.05)[0])
        self.engine.release.set()
        data = connection.recv(4096)
        self.assertTrue(data.startswith(b"HTTP/1.1 500"))
        connection.close()

    def test_disconnected_client_does_not_release_active_inference_slot(self):
        connection = self.raw_request()
        self.assertTrue(self.engine.entered.wait(1))
        running = self.scheduler.running
        connection.close()
        wait_for(lambda: running.canceled.is_set())
        self.scheduler.submit("next")
        with self.assertRaises(BusyError):
            self.scheduler.submit("too many")
        self.assertFalse(running.done.is_set())

    def test_full_queue_returns_503_without_executing_extra_text(self):
        self.scheduler.submit("first")
        self.assertTrue(self.engine.entered.wait(1))
        self.scheduler.submit("second")
        connection, response = self.request(json.dumps({"text": "rejected"}))
        self.assertEqual(response.status, 503)
        self.assertEqual(json.loads(response.read())["error"], "TTS_BUSY")
        self.assertEqual(self.engine.calls, ["first"])
        connection.close()

    def test_failed_stream_is_truncated_not_reported_as_complete(self):
        class PartialFailure:
            def chunks(self, _):
                yield PCM
                raise RuntimeError("Synthetic mid-stream failure")
        self.scheduler.engine = PartialFailure()
        connection, response = self.request(json.dumps({"text": "Hello."}))
        self.assertEqual(response.status, 200)
        with self.assertRaises(http.client.IncompleteRead):
            response.read()
        connection.close()

    def test_final_chunk_arriving_between_timeout_and_done_is_not_lost(self):
        class CompletionRaceQueue(queue.Queue):
            def __init__(self, done):
                super().__init__(maxsize=2)
                self.done = done
                self.once = True

            def get(self, block=True, timeout=None):
                if timeout is not None and self.once:
                    self.once = False
                    # Reproduce the precise race: the timed read reports empty,
                    # while final PCM and completion become visible together.
                    if not self.done.wait(1):
                        raise AssertionError("Worker did not finish")
                    raise queue.Empty()
                return super().get(block=block, timeout=timeout)

        original_submit = self.scheduler.submit

        def submit(text):
            job = original_submit(text)
            job.output = CompletionRaceQueue(job.done)
            self.engine.release.set()
            return job

        self.scheduler.submit = submit
        connection, response = self.request(json.dumps({"text": "Final chunk."}))
        self.assertEqual(response.status, 200)
        self.assertEqual(response.read(), PCM)
        connection.close()

    def test_invalid_inputs_are_rejected_before_inference(self):
        for body in ["broken", "[]", '{}', '{"text":""}', '{"text":1}', '{"text":"hello","voice":"other"}', json.dumps({"text": "x" * 1001})]:
            with self.subTest(body=body[:50]):
                connection, response = self.request(body)
                self.assertEqual(response.status, 400)
                response.read()
                connection.close()
        connection, response = self.request("hello", "text/plain")
        self.assertEqual(response.status, 415)
        connection.close()
        self.assertEqual(self.engine.calls, [])

    def test_waiting_timeout_cancels_queued_request(self):
        self.server.queue_timeout = 0.05
        self.scheduler.submit("first")
        self.assertTrue(self.engine.entered.wait(1))
        connection, response = self.request(json.dumps({"text": "waiter"}))
        self.assertEqual(response.status, 503)
        response.read()
        connection.close()
        wait_for(lambda: self.scheduler.snapshot()["waiting"] == 0)
        self.assertEqual(self.engine.calls, ["first"])


if __name__ == "__main__":
    unittest.main()
