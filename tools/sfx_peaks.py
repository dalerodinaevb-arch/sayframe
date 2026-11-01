#!/usr/bin/env python3
"""Waveform thumbnails for the Sounds library: Sayframe/sfx/peaks.json.

For every sfx/*.wav: its length in seconds and 48 peak levels (0..100, loudest = 100),
which the panel draws as the card's waveform. Run again after adding or changing a sound.
"""
import json, os, struct, wave

BINS = 48
HERE = os.path.dirname(os.path.abspath(__file__))
SFX = os.path.join(HERE, "..", "Sayframe", "sfx")


def peaks(path):
    with wave.open(path) as w:
        n, ch, width, rate = w.getnframes(), w.getnchannels(), w.getsampwidth(), w.getframerate()
        raw = w.readframes(n)
    if width != 2:
        raise SystemExit(path + ": only 16-bit WAV")
    samples = struct.unpack("<%dh" % (n * ch), raw)
    out = []
    for b in range(BINS):
        lo, hi = b * n // BINS, max(b * n // BINS + 1, (b + 1) * n // BINS)
        out.append(max(abs(samples[i * ch + c]) for i in range(lo, min(hi, n)) for c in range(ch)) if lo < n else 0)
    top = max(out) or 1
    return {"dur": round(n / rate, 3), "p": [round(v * 100 / top) for v in out]}


def main():
    data = {}
    for name in sorted(os.listdir(SFX)):
        if name.endswith(".wav"):
            data[name[:-4]] = peaks(os.path.join(SFX, name))
    with open(os.path.join(SFX, "peaks.json"), "w") as f:
        json.dump(data, f, separators=(",", ":"))
        f.write("\n")
    print("peaks for", len(data), "sounds")


if __name__ == "__main__":
    main()
