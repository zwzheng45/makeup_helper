"""Internal-only HTTP PCM service. No credentials, recordings, or text logs."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import queue
import select
import socket
import time

from engine import KokoroEngine, MAX_TEXT, SAMPLE_RATE, SPEEDS
from scheduler import BusyError, Scheduler


class SpeechServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, scheduler, queue_timeout=2.0, request_timeout=20.0):
        self.scheduler = scheduler
        self.queue_timeout = queue_timeout
        self.request_timeout = request_timeout
        super().__init__(address, SpeechHandler)


class SpeechHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "MirrorTTS"

    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, *_):
        pass

    def json_response(self, status, body):
        encoded = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        if status == 503:
            self.send_header("Retry-After", "1")
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(encoded)
        self.close_connection = True

    def do_GET(self):
        if self.path != "/healthz":
            self.json_response(404, {"error": "NOT_FOUND"})
            return
        state = self.server.scheduler.snapshot()
        self.json_response(200 if state["ready"] else 503, {"status": "ok" if state["ready"] else "unavailable", **state})

    def disconnected(self):
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            return bool(readable) and self.connection.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) == b""
        except (OSError, ValueError):
            return True

    def do_POST(self):
        if self.path != "/synthesize":
            self.json_response(404, {"error": "NOT_FOUND"})
            return
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            self.json_response(415, {"error": "JSON_REQUIRED"})
            return
        if self.headers.get("Transfer-Encoding"):
            self.json_response(400, {"error": "CONTENT_LENGTH_REQUIRED"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 8192:
                self.json_response(413, {"error": "INVALID_BODY_SIZE"})
                return
            raw = self.rfile.read(length)
            if len(raw) != length:
                return
            body = json.loads(raw)
            if not isinstance(body, dict) or "text" not in body or not set(body) <= {"text", "speed"} or not isinstance(body["text"], str):
                raise ValueError()
            # Only the offered speeds are accepted; bool is an int subclass and NaN never matches.
            speed = body.get("speed", 1.0)
            if isinstance(speed, bool) or not isinstance(speed, (int, float)) or float(speed) not in SPEEDS:
                raise ValueError()
            text = body["text"].strip()
            if not text or len(text) > MAX_TEXT or any(ord(char) < 32 and char not in "\t\n\r" for char in text):
                raise ValueError()
        except (ValueError, UnicodeError, TimeoutError):
            self.json_response(400, {"error": "INVALID_TEXT"})
            return
        try:
            job = self.server.scheduler.submit(text, float(speed))
        except BusyError:
            self.json_response(503, {"error": "TTS_BUSY"})
            return
        headers_sent = False
        try:
            while True:
                if self.disconnected():
                    return
                elapsed = time.monotonic() - job.created_at
                if (job.started_at is None and elapsed > self.server.queue_timeout) or elapsed > self.server.request_timeout:
                    if not headers_sent:
                        self.json_response(503 if job.started_at is None else 504, {"error": "TTS_TIMEOUT"})
                    return
                try:
                    chunk = job.output.get(timeout=0.025)
                except queue.Empty:
                    if not job.done.is_set():
                        continue
                    # The worker may enqueue its final chunk between get()'s
                    # timeout and observing done. Drain again after done is
                    # visible, when no further producer writes are possible.
                    try:
                        chunk = job.output.get_nowait()
                    except queue.Empty:
                        if job.error:
                            if not headers_sent:
                                self.json_response(500, {"error": job.error})
                            return
                        if not headers_sent:
                            self.json_response(500, {"error": "EMPTY_AUDIO"})
                        else:
                            self.wfile.write(b"0\r\n\r\n")
                            self.wfile.flush()
                        return
                if not headers_sent:
                    self.send_response(200)
                    self.send_header("Content-Type", f"audio/pcm; rate={SAMPLE_RATE}; channels=1")
                    self.send_header("X-PCM-Format", "s16le")
                    self.send_header("Transfer-Encoding", "chunked")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    headers_sent = True
                self.wfile.write(f"{len(chunk):x}\r\n".encode() + chunk + b"\r\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            pass
        finally:
            self.server.scheduler.cancel(job)
            # An inference failure after headers deliberately omits the final
            # chunk marker, so clients detect truncation instead of success.
            self.close_connection = True


def main():
    started = time.monotonic()
    threads = int(os.environ.get("TTS_THREADS", "4"))
    if not 1 <= threads <= 16:
        raise ValueError("TTS_THREADS must be between 1 and 16")
    engine = KokoroEngine(os.environ.get("TTS_MODEL_DIR", "/models"), "/app/models.json", threads)
    engine.warm()
    scheduler = Scheduler(engine)
    server = SpeechServer(("0.0.0.0", 8000), scheduler)
    print(json.dumps({"event": "ready", "warmup_ms": round((time.monotonic() - started) * 1000), "threads": threads, "voice": "af_heart", "sample_rate": SAMPLE_RATE, "provider": engine.provider, **engine.warmup_profile}), flush=True)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
        scheduler.close()


if __name__ == "__main__":
    main()
