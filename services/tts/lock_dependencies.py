"""Regenerate the Linux amd64/Python 3.12 wheel lock inside Docker only."""
from email.parser import BytesParser
import argparse
import hashlib
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile


parser = argparse.ArgumentParser()
parser.add_argument("--gpu", action="store_true")
args = parser.parse_args()

with tempfile.TemporaryDirectory() as directory:
    download = [sys.executable, "-m", "pip", "download", "--only-binary=:all:", "--dest", directory]
    if args.gpu:
        # Kokoro declares the CPU wheel by distribution name even though both
        # ORT variants expose the same module. Resolve its other dependencies
        # from the complete CPU lock and install only the GPU variant later.
        baseline = [line.split(" --hash=")[0] for line in Path("requirements.lock").read_text().splitlines() if line and not line.startswith(("#", "onnxruntime=="))]
        constraints = Path(directory) / "constraints.txt"
        constraints.write_text("\n".join(baseline))
        subprocess.run(download + ["--no-deps", *baseline], check=True)
        subprocess.run(download + ["-c", str(constraints), "onnxruntime-gpu==1.20.2", "nvidia-cuda-runtime-cu12==12.6.77", "nvidia-cuda-nvrtc-cu12==12.6.77", "nvidia-cublas-cu12==12.6.4.1", "nvidia-cudnn-cu12==9.10.2.21", "nvidia-cufft-cu12==11.2.6.59", "nvidia-curand-cu12==10.3.7.77", "nvidia-nvjitlink-cu12==12.6.85"], check=True)
    else:
        subprocess.run(download + ["kokoro-onnx==0.6.1"], check=True)
    requirements = []
    for path in Path(directory).glob("*.whl"):
        with zipfile.ZipFile(path) as wheel:
            metadata_path = next(name for name in wheel.namelist() if name.endswith(".dist-info/METADATA"))
            metadata = BytesParser().parsebytes(wheel.read(metadata_path))
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        requirements.append(f"{metadata['Name']}=={metadata['Version']} --hash=sha256:{digest}")
    Path("requirements-gpu.lock" if args.gpu else "requirements.lock").write_text("# Linux amd64, CPython 3.12. Generated with lock_dependencies.py in Docker.\n" + "\n".join(sorted(requirements, key=str.lower)) + "\n")
