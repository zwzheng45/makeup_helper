# syntax=docker/dockerfile:1.7
FROM python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app

FROM base AS models
COPY models.json download_models.py ./
RUN python download_models.py models.json /models

FROM base AS application
RUN useradd --uid 1000 --create-home mirror
COPY --from=models --chown=1000:1000 /models/ /models/
COPY --chown=1000:1000 models.json engine.py scheduler.py server.py benchmark.py ./
ENV TTS_THREADS=4 TTS_MODEL_DIR=/models HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
EXPOSE 8000
HEALTHCHECK --interval=5s --timeout=3s --start-period=90s --retries=6 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2).read()"
CMD ["python", "server.py"]

FROM application AS cpu
COPY requirements.lock ./
RUN --mount=type=cache,target=/root/.cache/pip pip install --require-hashes -r requirements.lock
ENV TTS_DEVICE=cpu ONNX_PROVIDER=CPUExecutionProvider
USER 1000:1000

FROM cpu AS test
COPY --chown=1000:1000 tests/ ./tests/
CMD ["python", "-m", "unittest", "discover", "-s", "tests", "-v"]

FROM application AS runtime
COPY requirements-gpu.lock ./
# The complete GPU lock deliberately replaces Kokoro's hard-coded dependency
# on the CPU ORT distribution. Installing both would overwrite the same module.
RUN --mount=type=cache,target=/root/.cache/pip pip install --no-deps --require-hashes -r requirements-gpu.lock
ENV TTS_DEVICE=cuda ONNX_PROVIDER=CUDAExecutionProvider NVIDIA_VISIBLE_DEVICES=all NVIDIA_DRIVER_CAPABILITIES=compute,utility
ENV LD_LIBRARY_PATH=/usr/local/lib/python3.12/site-packages/nvidia/cublas/lib:/usr/local/lib/python3.12/site-packages/nvidia/cudnn/lib:/usr/local/lib/python3.12/site-packages/nvidia/cuda_runtime/lib:/usr/local/lib/python3.12/site-packages/nvidia/cuda_nvrtc/lib:/usr/local/lib/python3.12/site-packages/nvidia/cufft/lib:/usr/local/lib/python3.12/site-packages/nvidia/curand/lib:/usr/local/lib/python3.12/site-packages/nvidia/nvjitlink/lib:/usr/local/nvidia/lib:/usr/local/nvidia/lib64
USER 1000:1000
