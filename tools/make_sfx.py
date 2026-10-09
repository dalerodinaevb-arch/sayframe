#!/usr/bin/env python3
"""Собирает звуки раздела «Звуки» (Sayframe/sfx/*.wav).

Все звуки синтезированы здесь же из шума и синусоид — своих, без чужих сэмплов, поэтому их можно
свободно использовать в любых роликах. Запуск: python3 tools/make_sfx.py (результат всегда одинаковый).
"""
import pathlib
import wave

import numpy as np

RATE = 44100
OUT = pathlib.Path(__file__).resolve().parent.parent / "Sayframe" / "sfx"
rng = np.random.default_rng(20261009)


def t_of(sec):
    return np.arange(int(RATE * sec)) / RATE


def env(n, attack, release, curve=2.0):
    """Огибающая: быстрый подъём, плавный спад."""
    e = np.ones(n)
    a = max(1, int(RATE * attack))
    r = max(1, int(RATE * release))
    e[:a] = np.linspace(0, 1, a) ** 0.5
    e[-r:] *= np.linspace(1, 0, r) ** curve
    return e


def lowpass(x, cutoff):
    """Однополюсный фильтр; cutoff может меняться во времени (массив)."""
    cutoff = np.broadcast_to(np.asarray(cutoff, dtype=float), x.shape)
    a = np.exp(-2 * np.pi * cutoff / RATE)
    y = np.empty_like(x)
    prev = 0.0
    for i in range(len(x)):
        prev = (1 - a[i]) * x[i] + a[i] * prev
        y[i] = prev
    return y


def highpass(x, cutoff):
    return x - lowpass(x, cutoff)


def norm(x, peak=0.85):
    m = np.max(np.abs(x)) or 1.0
    return x / m * peak


def whoosh(sec=0.9, lo=300, hi=3500):
    t = t_of(sec)
    n = len(t)
    noise = rng.standard_normal(n)
    sweep = lo * (hi / lo) ** np.sin(np.pi * t / sec)       # вверх и обратно
    band = highpass(lowpass(noise, sweep), sweep * 0.25)
    shape = np.sin(np.pi * t / sec) ** 2
    return norm(band * shape)


def swish():
    return whoosh(0.35, 800, 6000)


def pop():
    t = t_of(0.18)
    f = 900 * np.exp(-t * 28) + 220
    x = np.sin(2 * np.pi * np.cumsum(f) / RATE) * np.exp(-t * 30)
    return norm(x)


def click():
    t = t_of(0.06)
    x = rng.standard_normal(len(t)) * np.exp(-t * 180) + 0.6 * np.sin(2 * np.pi * 2400 * t) * np.exp(-t * 120)
    return norm(highpass(x, 1500))


def ding():
    t = t_of(1.4)
    x = sum(a * np.sin(2 * np.pi * f * t) * np.exp(-t * d)
            for f, a, d in ((1318.5, 1.0, 3.0), (2637, 0.35, 5.0), (3951, 0.15, 7.0), (1975.5, 0.2, 4.0)))
    return norm(x * env(len(t), 0.003, 0.3))


def riser():
    t = t_of(2.0)
    n = len(t)
    f = 120 * (16 ** (t / t[-1]))
    tone = np.sin(2 * np.pi * np.cumsum(f) / RATE) + 0.5 * np.sin(2 * np.pi * np.cumsum(f * 1.5) / RATE)
    noise = highpass(rng.standard_normal(n), 400 + 6000 * (t / t[-1]) ** 2)
    grow = (t / t[-1]) ** 2.2
    return norm((0.6 * tone + 0.5 * noise) * grow * env(n, 0.05, 0.03))


def impact():
    t = t_of(1.6)
    n = len(t)
    boom = np.sin(2 * np.pi * np.cumsum(55 + 90 * np.exp(-t * 12)) / RATE) * np.exp(-t * 3.2)
    crack = lowpass(rng.standard_normal(n), 2500) * np.exp(-t * 18)
    return norm(np.tanh(2.2 * (boom + 0.7 * crack)))


def glitch():
    sec = 0.7
    n = int(RATE * sec)
    x = np.zeros(n)
    pos = 0
    while pos < n:
        seg = int(RATE * rng.uniform(0.015, 0.06))
        kind = rng.integers(0, 3)
        tt = np.arange(seg) / RATE
        if kind == 0:
            s = np.sign(np.sin(2 * np.pi * rng.uniform(200, 1800) * tt))
        elif kind == 1:
            s = rng.standard_normal(seg)
        else:
            s = np.zeros(seg)
        x[pos:pos + seg] = s[:max(0, min(seg, n - pos))] * rng.uniform(0.3, 1.0)
        pos += seg
    return norm(lowpass(x, 7000) * env(n, 0.002, 0.05))


def typing():
    sec = 1.2
    n = int(RATE * sec)
    x = np.zeros(n)
    t = 0.04
    while t < sec - 0.08:
        c = click() * rng.uniform(0.4, 0.9)
        i = int(t * RATE)
        x[i:i + len(c)] += c[:n - i]
        t += rng.uniform(0.07, 0.14)
    return norm(x)


def bubble():
    t = t_of(0.25)
    f = 400 + 1400 * (t / t[-1]) ** 1.5
    x = np.sin(2 * np.pi * np.cumsum(f) / RATE) * np.sin(np.pi * t / t[-1]) ** 1.5
    return norm(x)


def swipe_up():
    return whoosh(0.5, 500, 9000)


def notify():
    out = []
    for f, sec in ((880, 0.12), (1318.5, 0.35)):
        t = t_of(sec)
        out.append((np.sin(2 * np.pi * f * t) + 0.3 * np.sin(4 * np.pi * f * t)) * env(len(t), 0.004, sec * 0.8))
    return norm(np.concatenate(out))


SOUNDS = {
    "whoosh": whoosh, "swish": swish, "swipe-up": swipe_up, "pop": pop, "click": click, "bubble": bubble,
    "ding": ding, "notify": notify, "riser": riser, "impact": impact, "glitch": glitch, "typing": typing,
}


def save(name, x):
    data = (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()
    with wave.open(str(OUT / (name + ".wav")), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(data)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for name, fn in SOUNDS.items():
        save(name, fn())
        print(name)
