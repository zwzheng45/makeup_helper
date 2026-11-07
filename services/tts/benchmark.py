"""Measure the running sidecar with fixed, synthetic grooming instructions."""
import argparse
from array import array
import json
from pathlib import Path
import statistics
import time
import urllib.request
import wave

SAMPLES = {
    "short": "Keep your face in view.",
    "eight_words": "Keep your head still and face the camera.",
    "medium": "Apply a small amount of blush to your left cheek, then tell me when you are ready.",
    "two_sentences": "Keep your face in view and take a moment to find a comfortable position. Apply a small amount of blush to your left cheek, then tell me when you are ready for the next step.",
}

NOVEL_SAMPLES = {
    "novel_01": "Turn slightly toward the light so I can see both cheeks.",
    "novel_02": "Hold the brush gently and blend upward along your cheekbone.",
    "novel_03": "Your left eyebrow looks even, so leave that side as it is.",
    "novel_04": "Move the mirror a little closer before checking the lower edge.",
    "novel_05": "There is a small patch near your chin that needs blending.",
    "novel_06": "Put the razor down before adjusting the camera with your hand.",
    "novel_07": "Use your fingertips to smooth the hair above your right ear.",
    "novel_08": "The lipstick is slightly darker on your upper lip than below.",
    "novel_09": "Take your time and tell me when you want the next instruction.",
    "novel_10": "Keep your eyes closed while gently patting the powder into place.",
}


def measure(base_url: str, text: str):
    request = urllib.request.Request(base_url.rstrip("/") + "/synthesize", data=json.dumps({"text": text}).encode(), headers={"Content-Type": "application/json"})
    started = time.perf_counter()
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.headers.get("X-PCM-Format") != "s16le" or "rate=24000" not in response.headers.get("Content-Type", ""):
            raise RuntimeError("Unexpected PCM format")
        first = response.read(4800)
        first_ms = (time.perf_counter() - started) * 1000
        pcm = first + response.read()
    total_ms = (time.perf_counter() - started) * 1000
    if not pcm or len(pcm) % 2:
        raise RuntimeError("Invalid PCM response")
    duration = len(pcm) / 48000
    samples = array("h", pcm)
    nonzero = next((index for index, value in enumerate(samples) if value != 0), len(samples))
    signal = next((index for index, value in enumerate(samples) if abs(value) >= 32), len(samples))
    return {
        "first_pcm_ms": round(first_ms, 1), "total_ms": round(total_ms, 1),
        "audio_seconds": round(duration, 3), "rtf": round(total_ms / 1000 / duration, 3),
        "leading_zero_ms": round(nonzero / 24, 2),
        "leading_below_threshold_ms": round(signal / 24, 2),
        "threshold_abs_pcm16": 32,
    }, pcm


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--samples", nargs="+", choices=SAMPLES, default=list(SAMPLES))
    parser.add_argument("--novel", action="store_true", help="Measure ten different short instructions once each to exercise new input shapes")
    parser.add_argument("--output-dir", help="Explicitly save the fixed synthetic samples as WAV files")
    args = parser.parse_args()
    if not 1 <= args.repeats <= 30:
        parser.error("repeats must be between 1 and 30")
    repeats = 1 if args.novel else args.repeats
    selected = NOVEL_SAMPLES if args.novel else {name: SAMPLES[name] for name in args.samples}
    report = {"voice": "af_heart", "sample_rate": 24000, "repeats": repeats, "novel_inputs": args.novel, "samples": {}}
    for name, text in selected.items():
        runs = []
        for index in range(repeats):
            timing, pcm = measure(args.base_url, text)
            runs.append(timing)
            if index == 0 and args.output_dir:
                destination = Path(args.output_dir)
                destination.mkdir(parents=True, exist_ok=True)
                with wave.open(str(destination / f"{name}.wav"), "wb") as output:
                    output.setnchannels(1)
                    output.setsampwidth(2)
                    output.setframerate(24000)
                    output.writeframes(pcm)
        report["samples"][name] = {"words": len(text.split()), "first_pcm_median_ms": round(statistics.median(run["first_pcm_ms"] for run in runs), 1), "first_pcm_max_ms": max(run["first_pcm_ms"] for run in runs), "runs": runs}
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
