"""One actual inference worker and one waiting slot, including cancellation."""
from collections import deque
from dataclasses import dataclass, field
import queue
import threading
import time


class BusyError(Exception):
    pass


@dataclass(eq=False)
class Job:
    text: str
    speed: float = 1.0
    created_at: float = field(default_factory=time.monotonic)
    started_at: float | None = None
    output: queue.Queue = field(default_factory=lambda: queue.Queue(maxsize=2))
    canceled: threading.Event = field(default_factory=threading.Event)
    done: threading.Event = field(default_factory=threading.Event)
    error: str | None = None


class Scheduler:
    def __init__(self, engine):
        self.engine = engine
        self.condition = threading.Condition()
        self.pending = deque()
        self.running = None
        self.closed = False
        self.worker = threading.Thread(target=self._work, name="kokoro-inference", daemon=True)
        self.worker.start()

    def submit(self, text: str, speed: float = 1.0) -> Job:
        with self.condition:
            # The first pending item reserves the execution slot if the worker
            # has not picked it up yet. Only one additional item may wait.
            if self.closed or len(self.pending) + (self.running is not None) >= 2:
                raise BusyError()
            job = Job(text, speed)
            self.pending.append(job)
            self.condition.notify_all()
            return job

    def cancel(self, job: Job):
        job.canceled.set()
        with self.condition:
            if job in self.pending:
                self.pending.remove(job)
                job.done.set()
            # Never clear self.running here: ONNX may still be executing.
            self.condition.notify_all()

    def snapshot(self):
        with self.condition:
            reserved = len(self.pending) + (self.running is not None)
            return {"ready": not self.closed and self.worker.is_alive(), "running": int(reserved > 0), "waiting": max(0, reserved - 1)}

    def _work(self):
        while True:
            with self.condition:
                self.condition.wait_for(lambda: self.closed or self.pending)
                if self.closed:
                    return
                job = self.pending.popleft()
                self.running = job
                job.started_at = time.monotonic()
            try:
                iterator = iter(self.engine.chunks(job.text, job.speed))
                while not job.canceled.is_set():
                    try:
                        chunk = next(iterator)
                    except StopIteration:
                        break
                    if not chunk or len(chunk) % 2:
                        raise RuntimeError("INVALID_PCM_CHUNK")
                    while not job.canceled.is_set():
                        try:
                            job.output.put(chunk, timeout=0.05)
                            break
                        except queue.Full:
                            continue
            except Exception:
                job.error = "SYNTHESIS_FAILED"
            finally:
                job.done.set()
                with self.condition:
                    self.running = None
                    self.condition.notify_all()

    def close(self):
        with self.condition:
            self.closed = True
            for job in self.pending:
                job.canceled.set()
                job.done.set()
            self.pending.clear()
            if self.running:
                self.running.canceled.set()
            self.condition.notify_all()
        self.worker.join(timeout=2)
