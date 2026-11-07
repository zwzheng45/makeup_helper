"""Build-time asset fetcher. Runtime never imports this module."""
import hashlib
import json
from pathlib import Path
import sys
import urllib.request


def download(manifest_path: str, destination: str) -> None:
    target = Path(destination)
    target.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(Path(manifest_path).read_text())
    for item in manifest["files"]:
        path = target / item["name"]
        temporary = path.with_suffix(path.suffix + ".part")
        digest = hashlib.sha256()
        size = 0
        request = urllib.request.Request(item["url"], headers={"User-Agent": "Mirror-TTS-build"})
        try:
            with urllib.request.urlopen(request, timeout=120) as response, temporary.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    digest.update(chunk)
                    size += len(chunk)
                    output.write(chunk)
            if size != item["bytes"] or digest.hexdigest() != item["sha256"]:
                raise RuntimeError(f"Asset integrity check failed: {item['name']}")
            temporary.replace(path)
            print(f"Verified {item['name']}: {size} bytes", flush=True)
        finally:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    download(sys.argv[1], sys.argv[2])
