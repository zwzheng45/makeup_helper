"""Offline Kokoro inference. The HTTP layer receives only PCM16LE bytes."""
import hashlib
import json
import os
from pathlib import Path
import re

SAMPLE_RATE = 24_000
CHUNK_SAMPLES = 2_400
MAX_TEXT = 1_000
MAX_PHRASE = 240


def phrases(text: str):
    """Keep synthesis bounded without dropping any supplied words."""
    for sentence in re.split(r"(?<=[.!?])\s+", " ".join(text.split())):
        while len(sentence) > MAX_PHRASE:
            boundary = sentence.rfind(" ", 0, MAX_PHRASE + 1)
            boundary = boundary if boundary > 0 else MAX_PHRASE
            yield sentence[:boundary]
            sentence = sentence[boundary:].lstrip()
        if sentence:
            yield sentence


class KokoroEngine:
    def __init__(self, model_dir: str, manifest_path: str, threads: int = 4):
        device = os.environ.get("TTS_DEVICE", "cpu")
        if device not in {"cpu", "cuda"}:
            raise RuntimeError("INVALID_TTS_DEVICE")
        if device == "cuda":
            # Detect a missing Docker GPU reservation before loading ORT's
            # native CUDA provider, which can crash during driver discovery.
            import ctypes
            try:
                driver = ctypes.CDLL("libcuda.so.1")
                count = ctypes.c_int()
                if driver.cuInit(0) != 0 or driver.cuDeviceGetCount(ctypes.byref(count)) != 0 or count.value < 1:
                    raise RuntimeError("CUDA_DEVICE_UNAVAILABLE")
            except OSError as error:
                raise RuntimeError("CUDA_DRIVER_UNAVAILABLE_CHECK_DOCKER_GPU_RESERVATION") from error
        import numpy as np
        import onnxruntime as ort
        from kokoro_onnx import Kokoro

        ort.disable_telemetry_events()
        self.np = np
        root = Path(model_dir)
        manifest = json.loads(Path(manifest_path).read_text())
        for item in manifest["files"]:
            path = root / item["name"]
            with path.open("rb") as source:
                digest = hashlib.file_digest(source, "sha256").hexdigest()
            if path.stat().st_size != item["bytes"] or digest != item["sha256"]:
                raise RuntimeError("MODEL_INTEGRITY_ERROR")
        options = ort.SessionOptions()
        options.intra_op_num_threads = threads
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        self.provider = "CUDAExecutionProvider" if device == "cuda" else "CPUExecutionProvider"
        if self.provider not in ort.get_available_providers():
            raise RuntimeError("REQUESTED_TTS_PROVIDER_UNAVAILABLE")
        if device == "cuda":
            options.enable_profiling = True
            options.profile_file_prefix = "/tmp/tts-onnx-profile"
        provider = (self.provider, {"device_id": "0", "gpu_mem_limit": str(4 * 1024**3), "arena_extend_strategy": "kSameAsRequested", "cudnn_conv_algo_search": "HEURISTIC", "use_tf32": "0"}) if device == "cuda" else self.provider
        session = ort.InferenceSession(str(root / "kokoro-v1.0.onnx"), sess_options=options, providers=[provider])
        if not session.get_providers() or session.get_providers()[0] != self.provider:
            raise RuntimeError("TTS_PROVIDER_FALLBACK_REJECTED")
        session.disable_fallback()
        self.session = session
        self.warmup_profile = {}
        self.model = Kokoro.from_session(session, str(root / "voices-v1.0.bin"))
        self.voice = manifest["voice"]
        self.model.get_voice_style(self.voice)

    def chunks(self, text: str):
        total_samples = 0
        for phrase in phrases(text):
            audio, rate = self.model.create(phrase, voice=self.voice, speed=1.0, lang="en-us")
            samples = self.np.asarray(audio, dtype=self.np.float32).reshape(-1)
            total_samples += len(samples)
            if rate != SAMPLE_RATE or not len(samples) or not self.np.isfinite(samples).all() or total_samples > SAMPLE_RATE * 90:
                raise RuntimeError("INVALID_SYNTHESIZED_AUDIO")
            pcm = (self.np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()
            for offset in range(0, len(pcm), CHUNK_SAMPLES * 2):
                yield pcm[offset:offset + CHUNK_SAMPLES * 2]

    def warm(self):
        pcm = b"".join(self.chunks("Your mirror is ready. Take your time."))
        if not pcm or not any(pcm):
            raise RuntimeError("WARMUP_FAILED")
        if self.provider == "CUDAExecutionProvider":
            profile_path = Path(self.session.end_profiling())
            try:
                events = json.loads(profile_path.read_text())
                kernels = [event.get("args", {}) for event in events if event.get("cat") == "Node" and event.get("args", {}).get("provider")]
                cuda_kernels = [event for event in kernels if event["provider"] == "CUDAExecutionProvider"]
                cuda_compute = [event for event in cuda_kernels if any(op in event.get("op_name", "") for op in ("Conv", "MatMul", "Gemm"))]
                if not cuda_compute:
                    raise RuntimeError("CUDA_COMPUTE_NOT_VERIFIED")
                self.warmup_profile = {"cuda_nodes": len(cuda_kernels), "cuda_compute_nodes": len(cuda_compute), "cpu_nodes": sum(event["provider"] == "CPUExecutionProvider" for event in kernels)}
            finally:
                profile_path.unlink(missing_ok=True)
