#!/usr/bin/env python3
"""Собирает звуки раздела «Звуки» (Sayframe/sfx/*.wav) и их список (Sayframe/sfx/list.json).

Все звуки синтезированы здесь же из шума, синусоид и простых фильтров — своих, без чужих сэмплов,
поэтому их можно свободно использовать в любых роликах. Запуск: python3 tools/make_sfx.py
(результат всегда одинаковый: у каждого звука своё зерно случайности).
"""
import json
import pathlib
import wave
import zlib

import numpy as np
from scipy import signal

RATE = 44100
OUT = pathlib.Path(__file__).resolve().parent.parent / "Sayframe" / "sfx"
rng = np.random.default_rng(1)


# ------------------------------------------------------------------ building blocks

def t_of(sec):
    return np.arange(int(RATE * sec)) / RATE


def noise(sec):
    return rng.standard_normal(int(RATE * sec))


def env(n, attack, release, curve=2.0):
    """Огибающая: подъём за attack, спад за release (секунды)."""
    e = np.ones(n)
    a = max(1, min(n, int(RATE * attack)))
    r = max(1, min(n, int(RATE * release)))
    e[:a] = np.linspace(0, 1, a) ** 0.5
    e[-r:] *= np.linspace(1, 0, r) ** curve
    return e


def decay(n, rate):
    return np.exp(-np.arange(n) / RATE * rate)


def lp(x, f, order=2):
    b, a = signal.butter(order, min(0.99, f / (RATE / 2)), "low")
    return signal.lfilter(b, a, x)


def hp(x, f, order=2):
    b, a = signal.butter(order, min(0.99, f / (RATE / 2)), "high")
    return signal.lfilter(b, a, x)


def bp(x, lo, hi, order=2):
    b, a = signal.butter(order, [lo / (RATE / 2), min(0.99, hi / (RATE / 2))], "band")
    return signal.lfilter(b, a, x)


def sweep_filter(x, f0, f1, shape=None, q=1.5):
    """Полосовой фильтр, частота которого едет от f0 к f1 (по кривой shape 0..1)."""
    n = len(x)
    shape = np.linspace(0, 1, n) if shape is None else shape
    freqs = f0 * (f1 / f0) ** shape
    y = np.zeros(n)
    block = 256
    zi = None
    for s in range(0, n, block):
        f = float(freqs[min(n - 1, s + block // 2)])
        lo, hi = max(30, f / q), min(RATE / 2 * 0.98, f * q)
        b, a = signal.butter(2, [lo / (RATE / 2), hi / (RATE / 2)], "band")
        if zi is None:
            zi = signal.lfilter_zi(b, a) * 0
        y[s:s + block], zi = signal.lfilter(b, a, x[s:s + block], zi=zi)
    return y


def tone(freq, sec, kind="sine"):
    """Тон; freq — число или массив частот по времени (глиссандо)."""
    n = int(RATE * sec)
    f = np.broadcast_to(np.asarray(freq, dtype=float), (n,))
    ph = 2 * np.pi * np.cumsum(f) / RATE
    if kind == "square":
        return np.sign(np.sin(ph))
    if kind == "saw":
        return 2 * ((ph / (2 * np.pi)) % 1) - 1
    if kind == "tri":
        return 2 * np.abs(2 * ((ph / (2 * np.pi)) % 1) - 1) - 1
    return np.sin(ph)


def glide(f0, f1, sec, curve=1.0):
    t = np.linspace(0, 1, int(RATE * sec)) ** curve
    return f0 * (f1 / f0) ** t


def reverb(x, sec=0.8, mix=0.3, bright=6000):
    ir = lp(noise(sec), bright) * decay(int(RATE * sec), 6 / sec)
    wet = signal.fftconvolve(x, ir)[: len(x) + int(RATE * sec)]
    dry = np.concatenate([x, np.zeros(len(wet) - len(x))])
    return dry + mix * wet / (np.max(np.abs(wet)) or 1) * np.max(np.abs(x))


def cat(*parts):
    return np.concatenate(parts)


def mix(*parts):
    n = max(len(p) for p in parts)
    out = np.zeros(n)
    for p in parts:
        out[: len(p)] += p
    return out


def pad(x, sec):
    return cat(np.zeros(int(RATE * sec)), x)


def norm(x, peak=0.85):
    x = x - np.mean(x)
    m = np.max(np.abs(x)) or 1.0
    y = x / m * peak
    f = min(len(y), int(RATE * 0.004))
    y[-f:] *= np.linspace(1, 0, f)
    return y


# ------------------------------------------------------------------ sounds

def whoosh(sec=0.9, lo=300, hi=3500, peak=0.5, q=1.6):
    n = int(RATE * sec)
    x = np.linspace(0, 1, n)
    shape = np.where(x < peak, x / peak, 1 - (x - peak) / (1 - peak))
    band = sweep_filter(noise(sec), lo, hi, shape, q)
    amp = np.where(x < peak, (x / peak) ** 2, ((1 - x) / (1 - peak)) ** 1.5)
    return norm(band * amp)


def swoosh_reverse(sec=1.2):
    n = int(RATE * sec)
    x = np.linspace(0, 1, n)
    return norm(sweep_filter(noise(sec), 200, 6000, x ** 2, 1.4) * x ** 3)


def double_whoosh():
    return norm(mix(whoosh(0.45, 400, 4500), pad(whoosh(0.5, 500, 5000), 0.28)))


def swipe(sec, up=True):
    n = int(RATE * sec)
    x = np.linspace(0, 1, n)
    shape = x if up else 1 - x
    return norm(sweep_filter(noise(sec), 600, 9000, shape, 1.8) * np.sin(np.pi * x) ** 1.2)


def zip_sound(sec=0.35, up=True):
    f = glide(300, 1600, sec) if up else glide(1600, 300, sec)
    buzz = tone(f, sec, "saw") * (0.5 + 0.5 * np.sign(np.sin(2 * np.pi * 60 * t_of(sec))))
    return norm(bp(buzz + 0.3 * noise(sec), 400, 6000) * env(int(RATE * sec), 0.01, 0.05))


def pop(f0=900, f1=220, sec=0.18, rate=30):
    t = t_of(sec)
    f = f0 * np.exp(-t * 28) + f1
    return norm(np.sin(2 * np.pi * np.cumsum(f) / RATE) * np.exp(-t * rate))


def click(sec=0.06, f=2400, rate=180):
    t = t_of(sec)
    x = noise(sec) * np.exp(-t * rate) + 0.6 * np.sin(2 * np.pi * f * t) * np.exp(-t * rate * 0.66)
    return norm(hp(x, 1500))


def tick(f=4000):
    t = t_of(0.03)
    return norm(np.sin(2 * np.pi * f * t) * np.exp(-t * 300) + 0.3 * noise(0.03) * np.exp(-t * 500))


def bell(freqs, sec=1.4, decays=None):
    t = t_of(sec)
    decays = decays or [3 + i * 1.5 for i in range(len(freqs))]
    x = sum((0.8 ** i) * np.sin(2 * np.pi * f * t) * np.exp(-t * d) for i, (f, d) in enumerate(zip(freqs, decays)))
    return norm(x * env(len(t), 0.003, 0.3))


def ding(base=1318.5, sec=1.4):
    return bell([base, base * 2, base * 3, base * 1.5], sec, [3, 5, 7, 4])


def notes(seq, step=0.11, tail=0.5, kind="sine", bright=0.3):
    out = np.zeros(int(RATE * (step * len(seq) + tail)))
    for i, f in enumerate(seq):
        sec = step + tail if i == len(seq) - 1 else step * 1.6
        t = t_of(sec)
        n = (np.sin(2 * np.pi * f * t) + bright * tone(f * 2, sec, kind)) * np.exp(-t * 6) * env(len(t), 0.004, 0.05)
        s = int(RATE * step * i)
        out[s:s + len(n)] += n[: len(out) - s]
    return norm(out)


def riser(sec=2.0, f0=120, mult=16, noisy=0.5):
    t = t_of(sec)
    n = len(t)
    f = f0 * (mult ** (t / t[-1]))
    tn = tone(f, sec) + 0.5 * tone(f * 1.5, sec)
    nz = hp(noise(sec), 400) * (t / t[-1]) ** 2
    grow = (t / t[-1]) ** 2.2
    return norm((0.6 * tn + noisy * nz) * grow * env(n, 0.05, 0.03))


def noise_riser(sec=2.5):
    n = int(RATE * sec)
    x = np.linspace(0, 1, n)
    return norm(sweep_filter(noise(sec), 300, 12000, x ** 1.5, 2.2) * x ** 2.5 * env(n, 0.01, 0.02))


def downer(sec=1.6, f0=900, f1=40):
    t = t_of(sec)
    f = glide(f0, f1, sec, 0.6)
    x = tone(f, sec) + 0.4 * tone(f * 1.01, sec, "saw") * 0.3 + 0.3 * lp(noise(sec), 2000) * np.exp(-t * 3)
    return norm(x * env(len(t), 0.005, sec * 0.6))


def impact(sec=1.6, low=55, crack=0.7, drive=2.2):
    t = t_of(sec)
    boom = np.sin(2 * np.pi * np.cumsum(low + 90 * np.exp(-t * 12)) / RATE) * np.exp(-t * 3.2)
    cr = lp(noise(sec), 2500) * np.exp(-t * 18)
    return norm(np.tanh(drive * (boom + crack * cr)))


def punch(sec=0.35):
    t = t_of(sec)
    body = np.sin(2 * np.pi * np.cumsum(60 + 140 * np.exp(-t * 40)) / RATE) * np.exp(-t * 14)
    smack = bp(noise(sec), 800, 5000) * np.exp(-t * 60)
    return norm(np.tanh(2.5 * (body + 0.6 * smack)))


def metal_hit(base=420, sec=1.5):
    t = t_of(sec)
    parts = [1, 2.76, 5.4, 8.93, 13.34]
    x = sum(np.sin(2 * np.pi * base * r * t + rng.uniform(0, 6)) * np.exp(-t * (2 + i * 1.8)) / (i + 1) for i, r in enumerate(parts))
    return norm(x + 0.4 * hp(noise(sec), 3000) * np.exp(-t * 40))


def cinematic_boom(sec=3.0):
    return norm(reverb(impact(1.8, 42, 0.9, 3.0), 1.6, 0.5, 3000))


def thud(sec=0.5):
    t = t_of(sec)
    return norm(lp(np.sin(2 * np.pi * np.cumsum(50 + 60 * np.exp(-t * 25)) / RATE) * np.exp(-t * 9) + 0.3 * lp(noise(sec), 400) * np.exp(-t * 20), 600))


def explosion(sec=2.5):
    t = t_of(sec)
    nz = noise(sec)
    rumble = (lp(nz, 2800) * np.exp(-t * 5) + lp(nz, 300)) * np.exp(-t * 1.6)
    crack = hp(noise(sec), 1500) * np.exp(-t * 12)
    return norm(np.tanh(3 * (rumble * 2 + 0.5 * crack + 0.6 * np.sin(2 * np.pi * 38 * t) * np.exp(-t * 2.5))))


def braam(sec=2.4):
    t = t_of(sec)
    x = sum(tone(f, sec, "saw") for f in (55, 55.4, 82.4, 110.2))
    return norm(np.tanh(1.8 * lp(x, 900)) * env(len(t), 0.03, 1.4))


def glitch(sec=0.7, seed=7, tonal=True):
    g = np.random.default_rng(seed)
    n = int(RATE * sec)
    x = np.zeros(n)
    pos = 0
    while pos < n:
        seg = int(RATE * g.uniform(0.012, 0.06))
        kind = g.integers(0, 3 if tonal else 2)
        tt = np.arange(seg) / RATE
        if kind == 0:
            s = g.standard_normal(seg)
        elif kind == 2:
            s = np.zeros(seg)
        else:
            s = np.sign(np.sin(2 * np.pi * g.uniform(150, 2400) * tt))
        x[pos:pos + seg] = s[:max(0, min(seg, n - pos))] * g.uniform(0.3, 1.0)
        pos += seg
    return norm(lp(x, 7000) * env(n, 0.002, 0.05))


def bitcrush(sec=0.8, seed=3):
    g = np.random.default_rng(seed)
    t = t_of(sec)
    x = tone(glide(g.uniform(200, 600), g.uniform(60, 1600), sec), sec, "square")
    step = 40
    x = np.repeat(x[::step], step)[: len(t)]
    return norm(x * env(len(t), 0.005, 0.1) * (0.6 + 0.4 * np.sign(np.sin(2 * np.pi * 12 * t))))


def static(sec=0.9):
    t = t_of(sec)
    x = noise(sec) * (0.4 + 0.6 * (rng.random(len(t)) > 0.97))
    return norm(bp(x, 800, 9000) * env(len(t), 0.01, 0.2))


def tv_off(sec=0.8):
    t = t_of(sec)
    return norm(tone(glide(9000, 200, sec, 0.5), sec) * 0.6 * np.exp(-t * 3) + 0.4 * hp(noise(sec), 2000) * np.exp(-t * 8))


def power_down(sec=1.4):
    t = t_of(sec)
    return norm(tone(glide(400, 30, sec, 0.7), sec, "saw") * env(len(t), 0.005, 0.3) * 0.8)


def power_up(sec=1.2):
    t = t_of(sec)
    return norm(lp(tone(glide(60, 700, sec, 1.6), sec, "saw"), 3000) * env(len(t), 0.05, 0.05))


def typing(sec=1.2, gap=(0.07, 0.14)):
    n = int(RATE * sec)
    x = np.zeros(n)
    t = 0.04
    while t < sec - 0.08:
        c = click(0.05, rng.uniform(1800, 3200), rng.uniform(150, 220)) * rng.uniform(0.4, 0.9)
        i = int(t * RATE)
        x[i:i + len(c)] += c[:n - i]
        t += rng.uniform(*gap)
    return norm(x)


def shutter():
    a = click(0.05, 2000, 160)
    b = click(0.06, 1400, 120) * 0.8
    return norm(cat(a, np.zeros(int(RATE * 0.05)), b))


def switch(on=True):
    a = click(0.035, 1800 if on else 1300, 260)
    return norm(cat(a * 0.6, np.zeros(int(RATE * 0.02)), click(0.04, 2600 if on else 1600, 200)))


def clock_tick(n=4):
    out = []
    for i in range(n):
        out += [tick(3200 if i % 2 == 0 else 2600), np.zeros(int(RATE * 0.47))]
    return norm(cat(*out))


def bubble(sec=0.25, up=True):
    t = t_of(sec)
    f = 400 + 1400 * (t / t[-1]) ** 1.5 if up else 1800 - 1400 * (t / t[-1]) ** 0.7
    return norm(np.sin(2 * np.pi * np.cumsum(f) / RATE) * np.sin(np.pi * t / t[-1]) ** 1.5)


def bubbles(count=6, sec=1.0):
    out = np.zeros(int(RATE * sec))
    for _ in range(count):
        b = bubble(rng.uniform(0.06, 0.14), True) * rng.uniform(0.4, 1)
        s = int(rng.uniform(0, sec - 0.15) * RATE)
        out[s:s + len(b)] += b
    return norm(out)


def boing(sec=0.8):
    t = t_of(sec)
    f = 180 + 120 * np.sin(2 * np.pi * 9 * t) * np.exp(-t * 3) + 160 * np.exp(-t * 4)
    return norm(tone(f, sec, "tri") * np.exp(-t * 3.5))


def slide_whistle(sec=0.8, up=True):
    t = t_of(sec)
    f = glide(500, 1800, sec) if up else glide(1800, 450, sec)
    f = f * (1 + 0.01 * np.sin(2 * np.pi * 6 * t))
    return norm((tone(f, sec) + 0.15 * hp(noise(sec), 3000)) * env(len(t), 0.04, 0.1))


def wobble(sec=0.9):
    t = t_of(sec)
    f = 300 + 80 * np.sin(2 * np.pi * 14 * t)
    return norm(tone(f, sec, "tri") * env(len(t), 0.01, 0.4))


def jump(sec=0.25):
    return norm(tone(glide(250, 900, sec, 0.7), sec, "square") * env(int(RATE * sec), 0.003, 0.08) * 0.6)


def fall(sec=0.9):
    t = t_of(sec)
    return norm(tone(glide(1400, 120, sec), sec, "tri") * env(len(t), 0.01, 0.2))


def laser(sec=0.35):
    t = t_of(sec)
    return norm(tone(glide(2400, 200, sec, 0.4), sec, "saw") * np.exp(-t * 6) * 0.8)


def coin():
    a = tone(988, 0.08, "square")
    b = tone(1319, 0.35, "square") * np.exp(-t_of(0.35) * 8)
    return norm(lp(cat(a, b), 7000) * 0.5)


def power_8bit(sec=0.6):
    seq = [262, 330, 392, 523, 659, 784, 1047]
    return notes(seq, sec / len(seq), 0.15, "square", 0.6)


def squeak(sec=0.22):
    t = t_of(sec)
    f = 1500 + 900 * np.sin(np.pi * t / t[-1])
    return norm(tone(f, sec) * np.sin(np.pi * t / t[-1]))


def sparkle(sec=1.2):
    out = np.zeros(int(RATE * sec))
    for i in range(12):
        f = rng.uniform(2500, 6500)
        b = bell([f, f * 2.01], 0.4, [10, 14]) * rng.uniform(0.3, 0.9)
        s = int(i / 12 * (sec - 0.4) * RATE)
        out[s:s + len(b)] += b
    return norm(out)


def error_buzz():
    t = t_of(0.18)
    a = tone(140, 0.18, "square") * env(len(t), 0.005, 0.03)
    return norm(lp(cat(a, np.zeros(int(RATE * 0.05)), a), 3000) * 0.7)


def hover():
    t = t_of(0.07)
    return norm(np.sin(2 * np.pi * 1800 * t) * np.sin(np.pi * t / t[-1]) * 0.6)


def wind(sec=2.5):
    n = int(RATE * sec)
    x = np.linspace(0, 1, n)
    shape = 0.5 + 0.5 * np.sin(2 * np.pi * (x * 1.3 + 0.2))
    return norm(sweep_filter(noise(sec), 300, 1500, shape, 1.3) * env(n, 0.6, 0.8))


def heartbeat():
    def beat(f):
        t = t_of(0.18)
        return lp(np.sin(2 * np.pi * np.cumsum(f + 30 * np.exp(-t * 30)) / RATE) * np.exp(-t * 22), 300)
    return norm(cat(beat(55), np.zeros(int(RATE * 0.08)), beat(48) * 0.7, np.zeros(int(RATE * 0.5))))


def camera_flash():
    t = t_of(1.2)
    whine = tone(glide(1200, 5200, 1.0, 0.6), 1.0) * 0.12 * np.linspace(0, 1, int(RATE * 1.0))
    pop_ = hp(noise(0.2), 1000) * np.exp(-t_of(0.2) * 25)
    return norm(cat(whine, pop_))


def page_flip():
    n = int(RATE * 0.35)
    x = np.linspace(0, 1, n)
    return norm(bp(noise(0.35), 1500, 8000) * np.sin(np.pi * x) ** 2 * (0.6 + 0.4 * np.sin(2 * np.pi * 30 * x)))


def scribble(sec=1.0):
    t = t_of(sec)
    am = 0.5 + 0.5 * np.sin(2 * np.pi * (5 + 3 * np.sin(2 * np.pi * 0.7 * t)) * t)
    return norm(bp(noise(sec), 2000, 7000) * am * env(len(t), 0.02, 0.1))


# id: (папка, название, функция). Папки и названия видит пользователь в панели.
SOUNDS = [
    # Вжухи
    ("whoosh", "whoosh", "Вжух", lambda: whoosh()),
    ("whoosh", "whoosh-short", "Вжух короткий", lambda: whoosh(0.4, 500, 5000)),
    ("whoosh", "whoosh-long", "Вжух длинный", lambda: whoosh(1.6, 200, 3000, 0.55)),
    ("whoosh", "whoosh-deep", "Вжух низкий", lambda: whoosh(1.0, 120, 1200, 0.5, 1.4)),
    ("whoosh", "whoosh-airy", "Вжух воздушный", lambda: whoosh(0.9, 1200, 9000, 0.45, 2.2)),
    ("whoosh", "whoosh-fast", "Вжух быстрый", lambda: whoosh(0.3, 800, 7000, 0.4)),
    ("whoosh", "whoosh-double", "Двойной вжух", double_whoosh),
    ("whoosh", "whoosh-reverse", "Обратный вжух", swoosh_reverse),
    ("whoosh", "swish", "Свист", lambda: whoosh(0.35, 800, 6000)),
    ("whoosh", "sword", "Взмах мечом", lambda: whoosh(0.28, 1500, 10000, 0.35, 2.5)),
    ("whoosh", "wind-pass", "Порыв ветра", wind),
    ("whoosh", "swoosh-cloth", "Взмах ткани", lambda: whoosh(0.6, 400, 2500, 0.4, 1.2)),
    # Свайпы и переходы
    ("swipe", "swipe-up", "Взмах", lambda: whoosh(0.5, 500, 9000)),
    ("swipe", "swipe-in", "Свайп вверх", lambda: swipe(0.35, True)),
    ("swipe", "swipe-out", "Свайп вниз", lambda: swipe(0.35, False)),
    ("swipe", "swipe-long", "Длинный свайп", lambda: swipe(0.7, True)),
    ("swipe", "zip-up", "Молния вверх", lambda: zip_sound(0.35, True)),
    ("swipe", "zip-down", "Молния вниз", lambda: zip_sound(0.35, False)),
    ("swipe", "page", "Перелистывание", page_flip),
    ("swipe", "scribble", "Карандаш", scribble),
    # Удары
    ("impact", "impact", "Удар", lambda: impact()),
    ("impact", "impact-hard", "Жёсткий удар", lambda: impact(1.4, 48, 1.0, 3.5)),
    ("impact", "boom", "Кинематографичный бум", cinematic_boom),
    ("impact", "punch", "Хлопок кулаком", punch),
    ("impact", "thud", "Глухой удар", thud),
    ("impact", "metal", "Металл", lambda: metal_hit(420)),
    ("impact", "metal-high", "Металл высокий", lambda: metal_hit(900, 1.2)),
    ("impact", "explosion", "Взрыв", explosion),
    ("impact", "braam", "Браам", braam),
    ("impact", "heartbeat", "Сердцебиение", heartbeat),
    # Нарастания
    ("riser", "riser", "Нарастание", lambda: riser()),
    ("riser", "riser-short", "Нарастание короткое", lambda: riser(1.0, 160, 10)),
    ("riser", "riser-long", "Нарастание длинное", lambda: riser(3.5, 90, 20, 0.7)),
    ("riser", "riser-noise", "Шумовое нарастание", noise_riser),
    ("riser", "riser-tone", "Тональное нарастание", lambda: riser(2.0, 200, 8, 0.1)),
    ("riser", "power-up", "Зарядка", power_up),
    ("riser", "downer", "Спад", downer),
    ("riser", "downer-long", "Долгий спад", lambda: downer(2.6, 600, 30)),
    ("riser", "power-down", "Выключение", power_down),
    # Интерфейс
    ("ui", "click", "Клик", lambda: click()),
    ("ui", "click-soft", "Мягкий клик", lambda: norm(lp(click(0.06, 1200, 140), 3000))),
    ("ui", "click-hard", "Резкий клик", lambda: click(0.04, 3800, 260)),
    ("ui", "tap", "Тап", lambda: pop(1600, 700, 0.06, 80)),
    ("ui", "tick", "Тик", lambda: tick()),
    ("ui", "toggle-on", "Переключатель вкл", lambda: switch(True)),
    ("ui", "toggle-off", "Переключатель выкл", lambda: switch(False)),
    ("ui", "hover", "Наведение", hover),
    ("ui", "select", "Выбор", lambda: notes([880, 1320], 0.06, 0.15)),
    ("ui", "back", "Назад", lambda: notes([1320, 880], 0.06, 0.15)),
    ("ui", "success", "Успех", lambda: notes([660, 880, 1320], 0.08, 0.4)),
    ("ui", "error", "Ошибка", error_buzz),
    ("ui", "notify", "Уведомление", lambda: notes([880, 1318.5], 0.12, 0.35, "sine", 0.3)),
    ("ui", "message", "Сообщение", lambda: notes([1046, 1568], 0.09, 0.3)),
    # Попы
    ("pop", "pop", "Поп", lambda: pop()),
    ("pop", "pop-high", "Поп высокий", lambda: pop(1800, 600, 0.12, 40)),
    ("pop", "pop-low", "Поп низкий", lambda: pop(500, 120, 0.2, 25)),
    ("pop", "plop", "Плюх", lambda: pop(700, 90, 0.25, 18)),
    ("pop", "cork", "Пробка", lambda: norm(mix(pop(1200, 300, 0.1, 50), hp(noise(0.05), 2000) * 0.4))),
    ("pop", "bubble", "Пузырь", lambda: bubble()),
    ("pop", "bubble-down", "Пузырь вниз", lambda: bubble(0.25, False)),
    ("pop", "bubbles", "Пузырьки", bubbles),
    # Глитч
    ("glitch", "glitch", "Глитч", lambda: glitch(0.7, 7)),
    ("glitch", "glitch-short", "Глитч короткий", lambda: glitch(0.25, 11)),
    ("glitch", "glitch-long", "Глитч длинный", lambda: glitch(1.4, 23)),
    ("glitch", "glitch-noise", "Цифровой шум", lambda: glitch(0.6, 31, False)),
    ("glitch", "glitch-stutter", "Заикание", lambda: glitch(0.5, 42)),
    ("glitch", "bitcrush", "Битовый шум", lambda: bitcrush(0.8, 3)),
    ("glitch", "data", "Передача данных", lambda: bitcrush(1.0, 9)),
    ("glitch", "static", "Помехи", static),
    ("glitch", "tv-off", "Выключение ТВ", tv_off),
    # Звонки
    ("bell", "ding", "Дзынь", lambda: ding()),
    ("bell", "ding-low", "Дзынь низкий", lambda: ding(880, 1.6)),
    ("bell", "ding-high", "Дзынь высокий", lambda: ding(2093, 1.2)),
    ("bell", "bell", "Колокольчик", lambda: bell([1567, 3134, 4700, 2350], 1.8, [2, 3.5, 5, 3])),
    ("bell", "chime-up", "Перелив вверх", lambda: notes([1046, 1318, 1568, 2093], 0.08, 0.6)),
    ("bell", "chime-down", "Перелив вниз", lambda: notes([2093, 1568, 1318, 1046], 0.08, 0.6)),
    ("bell", "sparkle", "Волшебные искры", sparkle),
    ("bell", "alert", "Сигнал", lambda: notes([1760, 1760, 1760], 0.13, 0.12, "square", 0.2)),
    ("bell", "coin", "Монетка", coin),
    # Мультяшные
    ("cartoon", "boing", "Пружина", boing),
    ("cartoon", "slide-up", "Свисток вверх", lambda: slide_whistle(0.8, True)),
    ("cartoon", "slide-down", "Свисток вниз", lambda: slide_whistle(0.8, False)),
    ("cartoon", "wobble", "Дрожание", wobble),
    ("cartoon", "jump", "Прыжок", jump),
    ("cartoon", "fall", "Падение", fall),
    ("cartoon", "laser", "Лазер", laser),
    ("cartoon", "power-8bit", "8 бит: усиление", power_8bit),
    ("cartoon", "squeak", "Писк", squeak),
    # Механика
    ("mech", "typing", "Клавиатура", lambda: typing()),
    ("mech", "typing-fast", "Быстрый набор", lambda: typing(1.2, (0.04, 0.08))),
    ("mech", "shutter", "Затвор камеры", shutter),
    ("mech", "flash", "Вспышка фотоаппарата", camera_flash),
    ("mech", "switch", "Выключатель", lambda: switch(True)),
    ("mech", "clock", "Часы", lambda: clock_tick(4)),
]

FOLDERS = [
    ("whoosh", "Вжухи"), ("swipe", "Свайпы"), ("impact", "Удары"), ("riser", "Нарастания"), ("ui", "Интерфейс"),
    ("pop", "Попы"), ("glitch", "Глитч"), ("bell", "Звонки"), ("cartoon", "Мультяшные"), ("mech", "Механика"),
]


def save(name, x):
    data = (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()
    with wave.open(str(OUT / (name + ".wav")), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(data)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    keep = set()
    for folder, sid, title, fn in SOUNDS:
        rng = np.random.default_rng(zlib.crc32(sid.encode()))   # своё зерно у каждого звука
        save(sid, fn())
        keep.add(sid + ".wav")
    for old in OUT.glob("*.wav"):
        if old.name not in keep:
            old.unlink()
    print(len(SOUNDS), "sounds")
