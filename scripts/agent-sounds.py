"""Builds sounds/done.mp3 and sounds/blocked.mp3, the agent alerts, from a small synth.

    uv run --no-project --with numpy --with scipy scripts/agent-sounds.py

Done is one quiet sine blip over a sub bass; needs you is two rising saw chord stabs,
4 dB louder. Both echo left and right through a ping-pong delay into a short reverb.
It needs ffmpeg for the MP3s.
"""
import subprocess
import tempfile
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import lfilter

SR = 44100
LEN = 2.6
OUT = Path(__file__).resolve().parent.parent / "sounds"


def hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def blank():
    return np.zeros((2, int(LEN * SR)))


def place(buf, sig, start, pan=0.0):
    """Mixes a mono or stereo signal into buf at start seconds, panned -1..1."""
    if sig.ndim == 1:
        sig = np.vstack([sig * np.sqrt((1 - pan) / 2), sig * np.sqrt((1 + pan) / 2)])
    o = int(start * SR)
    n = min(sig.shape[1], buf.shape[1] - o)
    buf[:, o:o + n] += sig[:, :n]


def saw(freq, n, phase=0.0):
    """A band-limited (polyBLEP) sawtooth."""
    dt = np.full(n, freq / SR)
    p = (np.cumsum(dt) + phase) % 1.0
    y = 2 * p - 1
    a = p < dt
    t = p[a] / dt[a]
    y[a] -= t + t - t * t - 1
    b = p > 1 - dt
    t = (p[b] - 1) / dt[b]
    y[b] -= t * t + t + t + 1
    return y


def env(n, attack, decay, sustain=0.0, release=0.3, hold=None):
    """Linear attack, exponential decay to sustain, exponential release after hold seconds."""
    t = np.arange(n) / SR
    e = np.where(t < attack, t / attack, sustain + (1 - sustain) * np.exp(-(t - attack) / decay))
    if hold is not None:
        after = t > hold
        e[after] = e[min(int(hold * SR), n - 1)] * np.exp(-(t[after] - hold) / release)
    return e


def lowpass(x, cutoff, res=0.2):
    """A state-variable low-pass whose cutoff may change every sample."""
    g = np.tan(np.pi * np.clip(np.broadcast_to(cutoff, x.shape), 20, SR * 0.45) / SR)
    k = 2 - 2 * res
    a1 = 1 / (1 + g * (g + k))
    ic1 = ic2 = 0.0
    y = np.empty_like(x)
    for i in range(len(x)):
        v1 = a1[i] * ic1 + g[i] * a1[i] * (x[i] - ic2)
        v2 = ic2 + g[i] * v1
        ic1, ic2 = 2 * v1 - ic1, 2 * v2 - ic2
        y[i] = v2
    return y


def sweep(n, start, end, time):
    """An exponential move from start to end over time seconds."""
    return start * (end / start) ** np.minimum(np.arange(n) / SR / time, 1.0)


def sub(m, vel, dur):
    n = int((dur + 0.6) * SR)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * hz(m) * t) + 0.12 * np.sin(4 * np.pi * hz(m) * t)
    return x * env(n, 0.012, 1.0, 1.0, 0.25, hold=dur) * vel


def blip(m, vel, drop):
    """A sine that starts drop semitones sharp and falls onto its note."""
    n = int(0.9 * SR)
    t = np.arange(n) / SR
    f = hz(m) * 2 ** (drop * np.exp(-t / 0.03) / 12)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, 0.003, 0.22) * vel


def stab(ms, vel, cutoff=2200, decay=0.3, rng=None):
    """A detuned saw chord, its filter closing, one side 6 cents sharp and the other flat."""
    n = int(1.4 * SR)
    sides = []
    for cents in (6, -6):
        x = sum(saw(hz(m) * 2 ** (cents / 1200), n, rng.random()) for m in ms) / len(ms)
        x = lowpass(x, sweep(n, cutoff, 400, decay * 2), 0.25)
        sides.append(x * env(n, 0.006, decay, 0.15, 0.25, hold=0.35) * vel)
    return np.vstack(sides)


def pingpong(buf, time, feedback, mix):
    """Darkened echoes every time seconds, alternating left and right."""
    mono = lowpass(buf.mean(0), 2500, 0.0)
    d = int(time * SR)
    for i in range(1, 7):
        if i * d >= buf.shape[1]:
            break
        buf[(i + 1) % 2, i * d:] += mono[:-i * d] * feedback ** i * mix
    return buf


def reverb(buf, wet):
    """A Schroeder reverb: six combs into three all-passes, a little longer on the right."""
    out = buf.copy()
    for ch in (0, 1):
        acc = 0
        for c in (1116, 1188, 1277, 1356, 1422, 1491):
            d = c + 23 * ch
            a = np.zeros(d + 1)
            a[0], a[d] = 1, -0.49
            acc = acc + lfilter([1], a, buf[ch])
        for ap in (556, 441, 341):
            d = ap + 11 * ch
            b = np.zeros(d + 1)
            b[0], b[d] = -0.5, 1
            a = np.zeros(d + 1)
            a[0], a[d] = 1, -0.5
            acc = lfilter(b, a, acc)
        out[ch] += lowpass(acc, 5000, 0.0) * wet / 6
    return out


def save(buf, name, rms_db):
    """Fades the tail, levels to rms_db with peaks under -3 dB, and writes an MP3."""
    fade = int(0.5 * SR)
    buf[:, -fade:] *= np.linspace(1, 0, fade)
    buf *= 10 ** (rms_db / 20) / np.sqrt(np.mean(buf ** 2))
    buf *= min(1.0, 10 ** (-3 / 20) / np.abs(buf).max())
    with tempfile.TemporaryDirectory() as tmp:
        wav = f"{tmp}/{name}.wav"
        wavfile.write(wav, SR, (buf.T * 32767).astype(np.int16))
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", wav,
                        "-codec:a", "libmp3lame", "-q:a", "2", str(OUT / f"{name}.mp3")], check=True)


rng = np.random.default_rng(7)
OUT.mkdir(exist_ok=True)

# Done: one D5 blip over a low D, settled.
done = blank()
place(done, blip(74, 0.3, 0.6), 0)
place(done, sub(38, 0.5, 0.7), 0)
save(reverb(pingpong(done, 0.28, 0.35, 0.4), 0.2), "done", -27)

# Needs you: A minor seventh, then a fourth higher on D minor seventh, as a question.
need = blank()
place(need, stab([57, 60, 64, 67], 0.35, rng=rng), 0)
place(need, stab([62, 65, 69, 72], 0.42, 2800, rng=rng), 0.22)
place(need, sub(38, 0.45, 0.9), 0.22)
save(reverb(pingpong(need, 0.3, 0.3, 0.35), 0.3), "blocked", -23)
