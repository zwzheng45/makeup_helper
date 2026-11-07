# Local speech service

This internal Docker service uses `kokoro-onnx==0.6.1`, full-precision Kokoro-82M v1.0, and the fixed English `af_heart` voice at speed 1.0. ONNX Runtime executes the model on an NVIDIA GPU. The service returns mono 24 kHz PCM16LE without a WAV header; it uses neither a cloud TTS API nor the operating system's speech synthesis.

## Build and startup

The production Compose stack builds this image automatically. The model stage downloads the exact files in `models.json`, checks their length and SHA256, and copies them into the final image. Docker caches that stage independently of Python application changes. Python dependencies, including transitive wheels, are pinned with hashes in `requirements-gpu.lock` for Linux amd64 and CPython 3.12. The GPU lock deliberately replaces Kokoro's declared CPU ONNX Runtime dependency with the GPU distribution; installing both would overwrite the same Python module.

Runtime performs no downloads. It verifies the model files, creates one CUDA ONNX session, loads the voice, and synthesizes a short warmup phrase before listening on port 8000. Startup checks the session's selected provider and profiles warmup to verify that convolution or matrix multiplication actually executes on CUDA. It fails instead of silently falling back to CPU; ONNX Runtime can still place normal shape or control operations on CPU. `/healthz` becomes available only after this succeeds. Compose gives the non-root container a read-only filesystem and an internal network without published ports. `/tmp` is a small executable tmpfs because the phonemizer copies its bundled espeak shared library there before loading it.

The default reserves one NVIDIA GPU, limits the ONNX CUDA memory arena to 4 GiB, and allows four host-side inference threads, four CPU cores, and 2 GiB host RAM. The arena limit is not a limit on all CUDA library/device memory. Python HTTP handling remains separate from inference, so readiness and disconnect detection continue while synthesis runs. Docker needs a compatible NVIDIA driver and NVIDIA Container Toolkit.

The image pins `onnxruntime-gpu==1.20.2`, CUDA 12.6 runtime libraries, and `nvidia-cudnn-cu12==9.10.2.21` to retain Tesla V100/Volta support. The [ORT 1.20.2 build](https://github.com/microsoft/onnxruntime/blob/v1.20.2/tools/ci_build/github/linux/build_linux_python_package.sh) includes compute capability 7.0, and the [cuDNN 9.10.2 matrix](https://docs.nvidia.com/deeplearning/cudnn/backend/v9.10.2/reference/support-matrix.html) includes Volta with CUDA 12.6. [cuDNN 9.11 drops Volta](https://docs.nvidia.com/deeplearning/cudnn/backend/v9.11.0/release-notes.html), so dependency updates must preserve this compatibility deliberately. Full-precision model weights are unchanged; no quantization or alternate model is used.

## API

`POST /synthesize`, with `Content-Type: application/json`:

```json
{"text":"Keep your face in view."}
```

Only the `text` property is accepted. It must contain 1–1000 characters. Long input is separated into bounded phrases; no voice selection or voice cloning is exposed.

A successful response has `Content-Type: audio/pcm; rate=24000; channels=1`, `X-PCM-Format: s16le`, and HTTP chunked transfer. Success headers are sent only after the first nonempty PCM chunk exists. Invalid input returns 400, incorrect content type returns 415, and a full queue or expired waiting slot returns 503. An inference failure before audio returns 500; failure after headers closes an incomplete chunked response so callers detect truncation.

One worker performs inference, with one additional waiting request. Waiting is limited to two seconds and a request to twenty seconds. Disconnecting removes queued work immediately and marks running work canceled. The current ONNX invocation is allowed to finish; its slot is never released early. Subsequent output and synthesis phrases from that canceled job are discarded. Output buffering is bounded to two 100 ms PCM chunks in addition to the current phrase's bounded synthesis buffer.

`GET /healthz` returns readiness and running/waiting counts. A busy service remains healthy. Request text and generated audio are not logged or stored.

## Container tests

```sh
docker build --platform linux/amd64 --target test -t mirror:tts-test -f services/tts/Dockerfile services/tts
docker run --rm --network none --read-only --tmpfs /tmp:size=32m mirror:tts-test
```

The test target uses the separate CPU dependency lock, requires no GPU, and does not load the real model. Its controlled engine verifies PCM framing, errors before and after headers, admission limits, disconnect handling, queue timeout, cancellation while inference is still executing, and the final-chunk/completion race. The production `runtime` target always requires CUDA.

## Real-model benchmark

The benchmark uses only fixed synthetic grooming instructions. It measures first PCM arrival, total transfer time, output duration, real-time factor, leading exact zeros, and the time until a sample reaches an absolute PCM16 amplitude of 32. That sample threshold is a diagnostic, not an audibility guarantee. Browser buffering and physical speaker latency are outside this service benchmark.

```sh
docker build --platform linux/amd64 --target runtime -t mirror:tts-local -f services/tts/Dockerfile services/tts
docker run -d --init --name mirror-tts-benchmark --gpus all --network none --cpus 4 --memory 2g \
  --read-only --tmpfs /tmp:exec,size=32m,uid=1000,gid=1000,mode=0700 mirror:tts-local
docker logs mirror-tts-benchmark
# Run after the ready event appears in the log.
docker exec mirror-tts-benchmark python benchmark.py --repeats 5
# Exercise ten different short instructions once each after model warmup.
docker exec mirror-tts-benchmark python benchmark.py --novel
docker stop mirror-tts-benchmark
docker rm mirror-tts-benchmark
```

To save the fixed synthetic samples explicitly, add `--output-dir /tmp/tts` to the benchmark command. Export that tmpfs directory while the container is running with `docker exec mirror-tts-benchmark tar -C /tmp/tts -cf - . | tar -C artifacts/tts -xf -`, after creating the destination directory. Nothing is saved by default.

Run benchmarks while other builds and benchmarks are idle. Do not infer a 500 ms target pass from a single short phrase. To reproduce the CPU baseline only, build the `cpu` target with a separate image tag and omit `--gpus all`; this is not a fallback used by deployment.

### Measured service timing

On 2026-11-07, the Docker GPU image ran offline on a Tesla V100-SXM2-32GB with driver 580.178.04, a four-core CPU quota, and a 2 GiB host-memory limit. Model startup and warmup took 2.09 seconds. Its warmup profile recorded 3,976 CUDA node executions, including 544 convolution or matrix-multiply executions. Host memory was approximately 650 MiB and GPU memory approximately 1.1 GiB during the short benchmark.

| Synthetic input | GPU first PCM median / maximum, 5 requests | Leading samples below amplitude 32 | CPU first PCM median, earlier 4-thread baseline |
| --- | --- | --- | --- |
| 5 words | 76.3 / 138.3 ms | 67 ms | 418.7 ms |
| 8 words | 67.7 / 78.5 ms | 52 ms | Not measured |
| 17 words | 134.0 / 139.3 ms | 45 ms | 1,026.5 ms |
| 35 words, two sentences | 129.6 / 130.8 ms | 31 ms | 1,009.2 ms |

Ten different 10–12-word instructions, each synthesized only once after warmup, produced first PCM in 96.5–134.6 ms (median 110.6 ms). They had another 26–66 ms of low-amplitude opening audio. A separate restart check, with the 17-word instruction as the first request after startup warmup, returned first PCM in 197.8 ms. Exact nonzero samples appeared almost immediately because the generated waveform contains very quiet noise; first-nonzero timing alone would understate the audible onset. These samples pass a 500 ms service-only first-PCM target on this hardware, without establishing end-to-end browser or Gemini latency. No leading-audio trimming was applied. The CPU and GPU runs use the same FP32 model and voice but different compatible ONNX Runtime builds, so this is a deployment comparison rather than an isolated execution-provider experiment.

Explicitly saved synthetic WAV examples and timing JSON are under the ignored `artifacts/tts/gpu/` directory after the benchmark. They contain no user recording. Measurements of real speakers, echo cancellation, and listening quality remain separate device checks.

## Dependency updates

To regenerate the wheel locks, run `lock_dependencies.py` using the pinned Python image from the Dockerfile with this directory mounted as `/app`; add `--gpu` for `requirements-gpu.lock`. Review the resulting locks. Model updates require changing the release URLs, exact lengths, and SHA256 values in `models.json`, followed by a rebuild and real-model benchmark.
