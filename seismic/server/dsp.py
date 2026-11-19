"""dsp.py - signal-processing kernels of seismic-viewer.

Pure functions on numpy arrays.  Conventions used everywhere in this module:

* Section functions take arrays whose LAST axis is time (one trace per row).
* ``dt_s`` is the sample interval in seconds, frequencies are in Hz.
* A trace is considered to be ZERO outside its recorded time range.
* A filter is always the convolution ``y[n] = sum_k h[k] * x[n + M - k]`` with
  an odd kernel of length ``L = 2 M + 1`` ("same" convolution, zero padding).
* Sections are filtered with an FFT (double precision internally); slices are
  computed as the dot product of the very same kernel with a slab of the
  time-major cube.  Both give the same numbers (to float32 rounding), so a
  slice value equals the section value at the same (inline, crossline, time).

Only numpy and scipy are used.
"""
from __future__ import annotations

import concurrent.futures
import functools
import math
import os
import sys
import threading

import numpy as np
from scipy import fft as sfft
from scipy.signal import firwin

MAX_TAPS = 201          # longest kernel (samples), odd
MIN_TAPS = 31           # shortest band-pass kernel (samples), odd
ATTRS = ("amp", "rms", "env", "ifreq", "sd")
SIGNED_ATTRS = ("amp",)
ENV_DEFAULT_FLO_HZ = 3.0      # default analytic band without a band-pass:
ENV_DEFAULT_FHI_FRAC = 0.9    # 3 Hz .. 0.9 * Nyquist
SD_SIGMA_CYCLES = 0.6         # Gabor window: sigma = 0.6 / f0 seconds


class Cancelled(Exception):
    """Raised by long computations when their ``should_stop`` callback returns True."""


_WORKERS = max(1, min(4, os.cpu_count() or 1))


# --------------------------------------------------------------------------
# kernel design
# --------------------------------------------------------------------------
def nyquist_hz(dt_s: float) -> float:
    """Nyquist frequency in Hz for a sample interval in seconds."""
    return 0.5 / dt_s


def normalise_band(flo, fhi, dt_s):
    """Validate band-pass corners (Hz) and return ``(flo, fhi)``.

    ``None`` means "corner absent".  ``flo == 0`` is treated as absent (no
    low cut) and ``fhi >= Nyquist`` as absent (no high cut).  Raises
    ``ValueError`` for negative / non-finite values, ``flo >= Nyquist`` or
    ``flo >= fhi``.
    """
    fn = nyquist_hz(dt_s)
    if flo is not None:
        flo = float(flo)
        if not math.isfinite(flo) or flo < 0:
            raise ValueError("flo must be a finite frequency >= 0 Hz")
    if fhi is not None:
        fhi = float(fhi)
        if not math.isfinite(fhi) or fhi <= 0:
            raise ValueError("fhi must be a finite frequency > 0 Hz")
    if flo is not None and fhi is not None and flo >= fhi:
        raise ValueError("flo must be smaller than fhi")
    if flo is not None and flo >= fn:
        raise ValueError("flo must be below the Nyquist frequency (%g Hz)" % fn)
    if flo is not None and flo == 0:
        flo = None
    if fhi is not None and fhi >= fn:
        fhi = None
    return flo, fhi


def n_taps_for(flo, fhi, dt_s, max_taps=MAX_TAPS):
    """Kernel length (odd) from the transition width: ``3.3 / (df * dt)``.

    Hamming-window rule of thumb.  ``df`` is
    band-pass  max(2 Hz, min(0.35 * flo, 0.5 * (fhi - flo))),
    high-pass  max(2 Hz, 0.35 * flo),
    low-pass   max(2 Hz, 0.20 * fhi).
    The result is forced odd and clamped to [31, max_taps].
    """
    if flo is None and fhi is None:
        raise ValueError("no band given")
    if flo is not None and fhi is not None:
        df = max(2.0, min(0.35 * flo, 0.5 * (fhi - flo)))
    elif flo is not None:
        df = max(2.0, 0.35 * flo)
    else:
        df = max(2.0, 0.20 * fhi)
    n = int(math.ceil(3.3 / (df * dt_s))) | 1
    hi = max_taps if max_taps % 2 else max_taps - 1
    return int(min(max(n, MIN_TAPS), hi))


def _readonly(a):
    a.setflags(write=False)
    return a


@functools.lru_cache(maxsize=256)
def bandpass_kernel(flo, fhi, dt_s, max_taps=MAX_TAPS):
    """Zero-phase (symmetric, odd length) FIR designed with ``scipy.signal.firwin``.

    Hamming window.  ``flo``/``fhi`` in Hz, either may be ``None`` (low-pass
    or high-pass).  Unit gain in the pass band.  Returns float64, read-only.
    """
    n = n_taps_for(flo, fhi, dt_s, max_taps)
    fs = 1.0 / dt_s
    if flo is not None and fhi is not None:
        h = firwin(n, [flo, fhi], pass_zero=False, fs=fs)
    elif fhi is not None:
        h = firwin(n, fhi, fs=fs)
    else:
        h = firwin(n, flo, pass_zero=False, fs=fs)
    h = np.asarray(h, dtype=np.float64)
    return _readonly(0.5 * (h + h[::-1]))        # exactly symmetric = exactly zero phase


def analytic_band(flo, fhi, dt_s):
    """Band (Hz) of the analytic filter used for envelope / instantaneous frequency.

    A missing corner is replaced by the broad default (3 Hz, 0.9 * Nyquist).
    """
    fn = nyquist_hz(dt_s)
    lo = ENV_DEFAULT_FLO_HZ if flo is None else float(flo)
    hi = ENV_DEFAULT_FHI_FRAC * fn if fhi is None else float(fhi)
    if lo >= hi:                      # only possible with one user corner
        if flo is None:
            lo = 0.5 * hi
        else:
            hi = 0.5 * (lo + fn)
    return lo, hi


@functools.lru_cache(maxsize=256)
def analytic_kernel(flo, fhi, dt_s, max_taps=MAX_TAPS):
    """Complex FIR that band-passes AND makes the signal analytic.

    Its real part is exactly ``bandpass_kernel(lo, hi)`` and its imaginary
    part is the windowed quadrature (Hilbert) partner, i.e. the windowed
    ideal response that is 2 for lo < f < hi and 0 for all other (including
    all negative) frequencies.  ``real(x * k)`` is the band-passed trace and
    ``abs(x * k)`` its envelope.  Returns complex128, read-only.
    """
    lo, hi = analytic_band(flo, fhi, dt_s)
    h = bandpass_kernel(lo, hi, dt_s, max_taps)
    n = h.size
    m = (n - 1) // 2
    t = np.arange(-m, m + 1) * dt_s
    win = np.hamming(n)
    with np.errstate(divide="ignore", invalid="ignore"):
        re0 = (np.sin(2 * np.pi * hi * t) - np.sin(2 * np.pi * lo * t)) / (np.pi * t)
        im0 = (np.cos(2 * np.pi * lo * t) - np.cos(2 * np.pi * hi * t)) / (np.pi * t)
    re0[m] = 2.0 * (hi - lo)
    im0[m] = 0.0
    scale = h[m] / (re0[m] * win[m])          # firwin's pass-band normalisation
    im = scale * win * im0
    return _readonly(h + 0.5j * (im - im[::-1]))  # imaginary part exactly antisymmetric


@functools.lru_cache(maxsize=256)
def gabor_kernel(f0, dt_s, max_taps=MAX_TAPS):
    """Complex Gabor kernel ``w(t) * exp(i 2 pi f0 t)`` for spectral decomposition.

    ``w`` is a Gaussian with sigma = 0.6 / f0 seconds (about 3.8 cycles
    inside +-pi sigma), limited to [2 dt, (max_taps-1)/2 * dt / 3.5] and
    truncated at 3.5 sigma.  Normalised with 2 / sum(w) so that a
    unit-amplitude cosine at f0 gives magnitude 1.0.  complex128, read-only.

    This is NOT a single frequency: the -6 dB band is 0.69 f0 .. 1.31 f0
    (see :func:`response_band`).  Outside :func:`sd_f0_range` the window is
    capped / floored and the result is not reliable; the server refuses it.
    """
    if not (0.0 < f0 < nyquist_hz(dt_s)):
        raise ValueError("f0 must be between 0 and the Nyquist frequency")
    m_max = (max_taps - 1) // 2
    sigma = min(max(SD_SIGMA_CYCLES / f0, 2.0 * dt_s), m_max * dt_s / 3.5)
    m = int(min(m_max, max(3, math.ceil(3.5 * sigma / dt_s))))
    t = np.arange(-m, m + 1) * dt_s
    w = np.exp(-0.5 * (t / sigma) ** 2)
    g = w * np.exp(2j * np.pi * f0 * t)
    return _readonly(g * (2.0 / w.sum()))


def sd_f0_range(dt_s, max_taps=MAX_TAPS):
    """Range ``(f_min, f_max)`` in Hz in which spectral decomposition is trustworthy.

    Below f_min the Gaussian window no longer fits into ``max_taps`` samples
    (sigma would be capped), so 0 Hz leaks in; above f_max = 0.8 * Nyquist the
    mirror image at -f0 aliases through Nyquist and a pure cosine no longer
    reads as a constant (ripple 4 % at 0.8 * Nyquist, 30 % at 0.88 * Nyquist).
    """
    m_max = (max_taps - 1) // 2
    f_min = float(math.ceil(3.5 * SD_SIGMA_CYCLES / (m_max * dt_s) * 0.95))
    f_max = float(math.floor(0.8 * nyquist_hz(dt_s)))
    return f_min, max(f_min, f_max)


def response_band(h, dt_s, level=0.5, nfft=8192):
    """Band ``(lo, hi)`` in Hz in which the kernel's gain is >= ``level`` x its peak gain.

    ``level = 0.5`` is the -6 dB band.  Only 0 .. Nyquist is examined.  The
    band is the connected interval around the peak; ``lo = 0`` / ``hi =
    Nyquist`` mean that the gain never drops below the level on that side
    (for example a "band-pass" whose low corner is too low to be realised
    with the available number of taps).
    """
    h = np.asarray(h)
    H = np.abs(np.fft.fft(h, nfft))[: nfft // 2 + 1]
    f = np.arange(nfft // 2 + 1) / (nfft * dt_s)
    k = int(np.argmax(H))
    thr = level * float(H[k])
    if not thr > 0:
        return 0.0, float(f[-1])
    i = k
    while i > 0 and H[i - 1] >= thr:
        i -= 1
    lo = 0.0 if i == 0 else float(f[i - 1] + (f[i] - f[i - 1]) * (thr - H[i - 1]) / (H[i] - H[i - 1]))
    j = k
    while j < H.size - 1 and H[j + 1] >= thr:
        j += 1
    hi = float(f[-1]) if j == H.size - 1 else float(f[j] + (f[j + 1] - f[j]) * (H[j] - thr) / (H[j] - H[j + 1]))
    return lo, hi


def attribute_kernel(attr, dt_s, flo=None, fhi=None, f0=30.0, max_taps=MAX_TAPS):
    """The FIR kernel an attribute uses (``None`` for unfiltered amp / rms)."""
    if attr in ("amp", "rms"):
        if flo is None and fhi is None:
            return None
        return bandpass_kernel(flo, fhi, dt_s, max_taps)
    if attr in ("env", "ifreq"):
        return analytic_kernel(flo, fhi, dt_s, max_taps)
    if attr == "sd":
        return gabor_kernel(float(f0), dt_s, max_taps)
    raise ValueError("unknown attribute %r" % (attr,))


def rms_length(win_ms, dt_ms):
    """Number of samples of the RMS window: odd integer nearest win_ms/dt_ms, >= 3."""
    r = float(win_ms) / float(dt_ms)
    return max(3, 2 * int(math.floor((r - 1.0) / 2.0 + 0.5)) + 1)


def clamp_win_ms(win_ms, dt_ms):
    """Clamp an RMS window length (ms) to [3 * dt, 1000]."""
    return float(min(max(float(win_ms), 3.0 * dt_ms), 1000.0))


# --------------------------------------------------------------------------
# sections: time is the last axis
# --------------------------------------------------------------------------
def clean(x):
    """``x`` as float32 with non-finite samples (NaN, +-inf) replaced by 0 (no copy if all are finite)."""
    x = np.asarray(x, dtype=np.float32)
    if np.isfinite(x).all():
        return x
    return np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)


def convolve_same(x, h, ext=0):
    """"Same" convolution along the last axis with zero padding.

    ``y[..., n] = sum_k h[k] * x[..., n + M - k]`` for n = -ext .. N-1+ext
    (M = (len(h)-1)/2; ``ext`` extra output samples on each side, where the
    trace itself is zero).  Real kernel -> float32, complex kernel ->
    complex64.  Computed by FFT in double precision.
    """
    x = np.asarray(x)
    h = np.asarray(h)
    n = x.shape[-1]
    L = h.size
    M = (L - 1) // 2
    if L % 2 != 1 or ext > M:
        raise ValueError("kernel must be odd and ext <= (len-1)/2")
    full = n + L - 1
    if np.iscomplexobj(h):
        nfft = sfft.next_fast_len(full, real=False)
        X = sfft.fft(x.astype(np.float64, copy=False), nfft, axis=-1, workers=_WORKERS)
        X *= sfft.fft(h, nfft)
        y = sfft.ifft(X, nfft, axis=-1, overwrite_x=True, workers=_WORKERS)
        return y[..., M - ext:M + n + ext].astype(np.complex64)
    nfft = sfft.next_fast_len(full, real=True)
    X = sfft.rfft(x.astype(np.float64, copy=False), nfft, axis=-1, workers=_WORKERS)
    X *= sfft.rfft(h.astype(np.float64, copy=False), nfft)
    y = sfft.irfft(X, nfft, axis=-1, overwrite_x=True, workers=_WORKERS)
    return y[..., M - ext:M + n + ext].astype(np.float32)


def bandpass(x, flo, fhi, dt_s, max_taps=MAX_TAPS):
    """Zero-phase band-pass (Hz corners, ``None`` = absent) along the last axis."""
    if flo is None and fhi is None:
        return np.asarray(x, dtype=np.float32)
    return convolve_same(x, bandpass_kernel(flo, fhi, dt_s, max_taps))


def analytic(x, flo, fhi, dt_s, max_taps=MAX_TAPS, ext=0):
    """Analytic (complex) trace within the band; see :func:`analytic_kernel`."""
    return convolve_same(x, analytic_kernel(flo, fhi, dt_s, max_taps), ext=ext)


def envelope(x, flo, fhi, dt_s, max_taps=MAX_TAPS):
    """Envelope (instantaneous amplitude) = |analytic trace|, amplitude units."""
    return np.abs(analytic(x, flo, fhi, dt_s, max_taps))


def _ifreq_from_triple(z_prev, z_mid, z_next, dt_s):
    """Central phase difference as the mean of the two one-sample phase steps.

    f = [angle(z[n+1] conj z[n]) + angle(z[n] conj z[n-1])] / (4 pi dt),
    clipped to [0, Nyquist].  Each one-sample step is unambiguous up to
    Nyquist, so this equals ``angle(z[n+1] conj z[n-1]) / (4 pi dt)``
    wherever that is below Nyquist / 2 and stays correct above it (the
    two-sample form wraps there and would read 0 Hz).
    """
    a = z_next * np.conj(z_mid)
    b = z_mid * np.conj(z_prev)
    f = (np.arctan2(a.imag, a.real) + np.arctan2(b.imag, b.real)) / (4.0 * np.pi * dt_s)
    return np.clip(f, 0.0, nyquist_hz(dt_s)).astype(np.float32)


def inst_freq(x, flo, fhi, dt_s, max_taps=MAX_TAPS):
    """Instantaneous frequency in Hz (central phase difference of the analytic trace).

    See :func:`_ifreq_from_triple`; valid from 0 Hz up to Nyquist.
    """
    z = analytic(x, flo, fhi, dt_s, max_taps, ext=1)
    return _ifreq_from_triple(z[..., :-2], z[..., 1:-1], z[..., 2:], dt_s)


def spectral_decomp(x, f0, dt_s, max_taps=MAX_TAPS):
    """Spectral decomposition at f0 (Hz): |x * Gabor kernel|, amplitude units."""
    return np.abs(convolve_same(x, gabor_kernel(float(f0), dt_s, max_taps)))


def moving_rms(x, n_win):
    """Centred moving RMS over ``n_win`` (odd) samples along the last axis.

    sqrt(mean(x^2)); at the trace ends the mean is taken over the samples
    that are actually inside the trace.
    """
    x = np.asarray(x)
    n = x.shape[-1]
    half = (int(n_win) - 1) // 2
    c = np.zeros(x.shape[:-1] + (n + 1,), dtype=np.float64)
    np.cumsum(np.square(x, dtype=np.float64), axis=-1, out=c[..., 1:])
    idx = np.arange(n)
    lo = np.maximum(idx - half, 0)
    hi = np.minimum(idx + half, n - 1) + 1
    s = c[..., hi] - c[..., lo]
    np.maximum(s, 0.0, out=s)
    return np.sqrt(s / (hi - lo)).astype(np.float32)


def section_attribute(x, attr, dt_s, flo=None, fhi=None, win_ms=100.0, f0=30.0,
                      max_taps=MAX_TAPS):
    """Attribute of a section ``x`` (traces x time).  Returns ``(float32, taps)``.

    ``taps`` is the length of the FIR kernel that was used (0 if none).
    amp: band-passed amplitude; rms: moving RMS of the band-passed trace;
    env / ifreq: from the analytic trace; sd: spectral decomposition at f0
    (band-pass ignored).
    """
    x = clean(x)                       # a non-finite sample counts as 0, as in the slices
    if attr in ("amp", "rms"):
        taps = 0
        y = np.asarray(x, dtype=np.float32)
        if flo is not None or fhi is not None:
            k = bandpass_kernel(flo, fhi, dt_s, max_taps)
            taps = k.size
            y = convolve_same(x, k)
        if attr == "rms":
            y = moving_rms(y, rms_length(win_ms, dt_s * 1000.0))
        return y, taps
    if attr == "env":
        k = analytic_kernel(flo, fhi, dt_s, max_taps)
        return np.abs(convolve_same(x, k)), k.size
    if attr == "ifreq":
        k = analytic_kernel(flo, fhi, dt_s, max_taps)
        z = convolve_same(x, k, ext=1)
        return _ifreq_from_triple(z[..., :-2], z[..., 1:-1], z[..., 2:], dt_s), k.size
    if attr == "sd":
        k = gabor_kernel(float(f0), dt_s, max_taps)
        return np.abs(convolve_same(x, k)), k.size
    raise ValueError("unknown attribute %r" % (attr,))


# --------------------------------------------------------------------------
# slices: slab of the time-major cube (n_t, n_il, n_xl)
# --------------------------------------------------------------------------
def kernel_matrix(h, out_times, slab_t0, slab_n):
    """Matrix K with ``y[out_times[r]] = sum_c K[r, c] * x[slab_t0 + c]``.

    Row r holds the reversed kernel centred on sample ``out_times[r]``;
    kernel samples that fall outside the slab are dropped (the trace is zero
    there).  Same dtype kind as ``h``.
    """
    h = np.asarray(h)
    M = (h.size - 1) // 2
    tau = slab_t0 + np.arange(slab_n)
    idx = np.asarray(out_times)[:, None] + M - tau[None, :]
    ok = (idx >= 0) & (idx < h.size)
    return np.where(ok, h[np.clip(idx, 0, h.size - 1)], 0)


_SLAB_POOL = None
_SLAB_FDS = {}
_SLAB_LOCK = threading.Lock()


def _slab_fd(filename):
    """Plain read-only file descriptor of a cube file (opened once per process), and the reader pool."""
    global _SLAB_POOL
    with _SLAB_LOCK:
        if _SLAB_POOL is None:
            _SLAB_POOL = concurrent.futures.ThreadPoolExecutor(max_workers=8, thread_name_prefix="sv-slab")
        fd = _SLAB_FDS.get(filename)
        if fd is None:
            fd = _SLAB_FDS[filename] = os.open(filename, os.O_RDONLY)
        return fd


def can_read_direct(tix, x0, x1):
    """True if :func:`read_slab` can use positional file reads for this cube and crossline range."""
    return (isinstance(tix, np.memmap) and getattr(tix, "filename", None) is not None
            and hasattr(os, "preadv") and tix.dtype == np.dtype("<f4") and sys.byteorder == "little"
            and tix.flags.c_contiguous and x0 == 0 and x1 == tix.shape[2])


def read_slab(tix, ta, tb, ia, ib, x0, x1):
    """``tix[ta:tb+1, ia:ib, x0:x1]`` as a C-contiguous float32 array.

    For a memory-mapped little-endian float32 file and a full crossline
    range, every time plane's block of inlines is one contiguous piece of
    the file: consecutive planes are read with (parallel) positional reads
    (``os.preadv``) straight into the result, i.e. as one forward pass
    over the file.  When the file is not in the page cache this is faster
    than touching the memory map, whose page faults read 128 kB at a time,
    one after the other.  Anything else (arrays in memory, zoomed windows)
    is sliced; the numbers are identical either way.
    """
    n_il, n_xl = tix.shape[1], tix.shape[2]
    filename = getattr(tix, "filename", None)
    if not can_read_direct(tix, x0, x1):
        return np.ascontiguousarray(tix[ta:tb + 1, ia:ib, x0:x1], dtype=np.float32)
    fd = _slab_fd(str(filename))
    out = np.empty((tb - ta + 1, ib - ia, n_xl), dtype=np.float32)
    base, plane_bytes = int(tix.offset), (ib - ia) * n_xl * 4

    def read(j):
        buf = memoryview(out[j]).cast("B")
        pos = base + (((ta + j) * n_il + ia) * n_xl) * 4
        got = 0
        while got < plane_bytes:
            n = os.preadv(fd, [buf[got:]], pos + got)
            if n <= 0:
                raise IOError("short read from %s" % filename)
            got += n
    list(_SLAB_POOL.map(read, range(out.shape[0])))
    return out


def slice_attribute(tix, k, i_sl, x_sl, attr, dt_s, flo=None, fhi=None,
                    win_ms=100.0, f0=30.0, max_taps=MAX_TAPS,
                    chunk_bytes=192 * 1024 * 1024, should_stop=None):
    """Attribute on the time slice at sample index ``k``.

    ``tix`` is the cube in (time, inline, crossline) order (may be a
    memmap); ``i_sl`` / ``x_sl`` are slices selecting inlines / crosslines.
    Only the slab of time samples that the kernel needs is read, in chunks
    of at most ``chunk_bytes``, and the kernel dot product is taken at the
    centre, so the result equals ``section_attribute(...)[..., k]``.
    Two equivalent orders of work are used: for a full crossline range of
    a memory-mapped cube (and every attribute except rms) the slab is read
    time plane by time plane, in file order, and the kernel product is
    accumulated (fast when the file is not cached); otherwise the slab is
    cut into inline chunks.
    For ``rms`` the window is centred on ``k``.  Returns ``(float32 2-D, taps)``.
    Non-finite samples count as 0 (as in the sections).  ``should_stop`` is
    an optional callable polled before every inline chunk; when it returns
    True the computation is abandoned with :class:`Cancelled`.
    """
    n_t = tix.shape[0]
    if not 0 <= k < n_t:
        raise ValueError("time index out of range")
    filt = flo is not None or fhi is not None
    if attr == "amp" and not filt:
        return clean(np.array(tix[k, i_sl, x_sl], dtype=np.float32)), 0

    if attr in ("amp", "rms"):
        h = bandpass_kernel(flo, fhi, dt_s, max_taps) if filt else np.ones(1)
        if attr == "rms":
            half = (rms_length(win_ms, dt_s * 1000.0) - 1) // 2
            out_times = np.arange(max(0, k - half), min(n_t - 1, k + half) + 1)
        else:
            out_times = np.array([k])
    elif attr in ("env", "ifreq"):
        h = analytic_kernel(flo, fhi, dt_s, max_taps)
        out_times = np.array([k - 1, k, k + 1]) if attr == "ifreq" else np.array([k])
    elif attr == "sd":
        h = gabor_kernel(float(f0), dt_s, max_taps)
        out_times = np.array([k])
    else:
        raise ValueError("unknown attribute %r" % (attr,))
    taps = int(h.size) if (filt or attr not in ("amp", "rms")) else 0

    M = (h.size - 1) // 2
    ta = max(0, int(out_times.min()) - M)
    tb = min(n_t - 1, int(out_times.max()) + M)
    n_slab = tb - ta + 1
    K = kernel_matrix(h, out_times, ta, n_slab)
    m = K.shape[0]
    is_complex = np.iscomplexobj(K)
    if is_complex:
        K = np.vstack([K.real, K.imag])
    K = np.ascontiguousarray(K, dtype=np.float32)

    i0, i1, _ = i_sl.indices(tix.shape[1])
    x0, x1, _ = x_sl.indices(tix.shape[2])
    n_i, n_x = i1 - i0, x1 - x0
    out = np.empty((n_i, n_x), dtype=np.float32)
    per_inline = max(n_slab, K.shape[0]) * n_x * 4
    step = max(1, int(chunk_bytes // max(1, per_inline)))
    plain_rms = attr == "rms" and not filt

    def reduce(s2):
        """Attribute of the traces in the columns of ``s2`` (slab samples x traces)."""
        if plain_rms:
            return np.sqrt(np.einsum("tn,tn->n", s2, s2) / m)
        return post(K @ s2)

    def post(Y):
        """Attribute from the kernel products ``Y`` (kernel rows x traces)."""
        if attr == "amp":
            return Y[0]
        if attr == "rms":
            return np.sqrt(np.einsum("tn,tn->n", Y, Y) / m)
        if attr in ("env", "sd"):
            return np.hypot(Y[0], Y[1])
        # ifreq: rows are re z(k-1), re z(k), re z(k+1), im z(k-1), im z(k), im z(k+1)
        a = np.arctan2(Y[5] * Y[1] - Y[2] * Y[4], Y[2] * Y[1] + Y[5] * Y[4])     # angle(z(k+1) conj z(k))
        a += np.arctan2(Y[4] * Y[0] - Y[1] * Y[3], Y[1] * Y[0] + Y[4] * Y[3])    # angle(z(k) conj z(k-1))
        return np.clip(a / (4.0 * np.pi * dt_s), 0.0, nyquist_hz(dt_s))

    if attr != "rms" and n_i * n_x > 0 and can_read_direct(tix, x0, x1):
        # time-plane order: one forward pass over the file, a few kernel rows accumulated per plane chunk
        Y = np.zeros((K.shape[0], n_i * n_x), dtype=np.float32)
        tstep = max(1, int(chunk_bytes // (n_i * n_x * 4)))
        for c0 in range(0, n_slab, tstep):
            if should_stop is not None and should_stop():
                raise Cancelled()
            c1 = min(n_slab, c0 + tstep)
            planes = read_slab(tix, ta + c0, ta + c1 - 1, i0, i1, x0, x1)
            with np.errstate(invalid="ignore", over="ignore"):
                Y += np.ascontiguousarray(K[:, c0:c1]) @ planes.reshape(c1 - c0, -1)
            del planes
        with np.errstate(invalid="ignore", over="ignore"):
            r = np.asarray(post(Y), dtype=np.float32)
        del Y
        bad = np.flatnonzero(~np.isfinite(r))
        if bad.size <= 4096:
            if bad.size:           # traces holding NaN / inf samples: redo them with those samples = 0
                s2 = np.stack([np.asarray(tix[ta:tb + 1, i0 + j // n_x, x0 + j % n_x], dtype=np.float32)
                               for j in bad.tolist()], axis=1)
                r[bad] = reduce(np.nan_to_num(s2, nan=0.0, posinf=0.0, neginf=0.0))
            return r.reshape(n_i, n_x), taps
        # (a cube full of non-finite samples: fall through to the inline-chunk order, which cleans whole chunks)

    if n_i * n_x > 0 and can_read_direct(tix, x0, x1) and n_slab * n_i * n_x * 4 >= 256 * 1024 * 1024:
        # A large slab that is cut into inline chunks below (rms): first pull it into the page cache with one
        # forward pass over the file.  Uncached, that is about twice as fast as the page faults of the memory
        # map; cached, it costs a fraction of the computation.
        pstep = max(1, int((64 * 1024 * 1024) // (n_i * n_x * 4)))
        for c0 in range(0, n_slab, pstep):
            if should_stop is not None and should_stop():
                raise Cancelled()
            read_slab(tix, ta + c0, min(tb, ta + c0 + pstep - 1), i0, i1, x0, x1)

    for a in range(0, n_i, step):
        if should_stop is not None and should_stop():
            raise Cancelled()
        b = min(n_i, a + step)
        slab = np.ascontiguousarray(tix[ta:tb + 1, i0 + a:i0 + b, x0:x1], dtype=np.float32)
        s2 = slab.reshape(n_slab, -1)
        with np.errstate(invalid="ignore", over="ignore"):
            r = np.asarray(reduce(s2), dtype=np.float32)
        bad = np.flatnonzero(~np.isfinite(r))
        if bad.size:               # traces holding NaN / inf samples: redo them with those samples = 0
            r[bad] = reduce(np.nan_to_num(s2[:, bad], nan=0.0, posinf=0.0, neginf=0.0))
        out[a:b] = r.reshape(b - a, n_x)
        del slab, s2, r
    return out, taps


# --------------------------------------------------------------------------
# image helpers
# --------------------------------------------------------------------------
def block_factors(src_rows, src_cols, max_rows, max_cols):
    """Integer block-mean factors ``(ceil(rows/max_rows), ceil(cols/max_cols))``."""
    return (max(1, -(-int(src_rows) // int(max_rows))),
            max(1, -(-int(src_cols) // int(max_cols))))


def block_mean(a, fr, fc):
    """Reduce a 2-D array by the mean over blocks of ``fr`` rows x ``fc`` columns.

    The output has ceil(rows/fr) x ceil(cols/fc) elements; incomplete blocks
    at the bottom / right edge are the mean of the samples that exist.
    """
    a = np.asarray(a)
    if fr <= 1 and fc <= 1:
        return np.asarray(a, dtype=np.float32)
    out = a
    if fr > 1:
        idx = np.arange(0, out.shape[0], fr)
        cnt = np.minimum(idx + fr, out.shape[0]) - idx
        out = np.add.reduceat(out, idx, axis=0, dtype=np.float64) / cnt[:, None]
    if fc > 1:
        idx = np.arange(0, out.shape[1], fc)
        cnt = np.minimum(idx + fc, out.shape[1]) - idx
        out = np.add.reduceat(out, idx, axis=1, dtype=np.float64) / cnt[None, :]
    return out.astype(np.float32)


def encode_signed(v, vmax):
    """8-bit code of a signed quantity: p = 128 + round(127 * clip(v/vmax, -1, 1))."""
    s = np.clip(np.nan_to_num(np.asarray(v, dtype=np.float32)) * np.float32(1.0 / vmax), -1.0, 1.0)
    return (128.0 + np.rint(127.0 * s)).astype(np.uint8)


def encode_unsigned(v, vmax):
    """8-bit code of a non-negative quantity: p = round(255 * clip(v/vmax, 0, 1))."""
    s = np.clip(np.nan_to_num(np.asarray(v, dtype=np.float32)) * np.float32(1.0 / vmax), 0.0, 1.0)
    return np.rint(255.0 * s).astype(np.uint8)


def decode_signed(p, vmax):
    """Inverse of :func:`encode_signed` (to within half a grey level)."""
    return (np.asarray(p, dtype=np.float64) - 128.0) / 127.0 * vmax


def decode_unsigned(p, vmax):
    """Inverse of :func:`encode_unsigned` (to within half a grey level)."""
    return np.asarray(p, dtype=np.float64) / 255.0 * vmax


def robust_vmax(img, pct=99.5):
    """The ``pct``-th percentile of |img| over the finite samples.

    If that percentile is 0 (an image that is almost entirely zero) the
    percentile of the finite NON-ZERO samples is used instead; 1.0 only if
    there is no finite non-zero sample at all.
    """
    a = np.abs(np.asarray(img, dtype=np.float32)).ravel()
    a = a[np.isfinite(a)]
    if a.size:
        v = float(np.percentile(a, pct))
        if v > 0.0:
            return v
        a = a[a > 0]
        if a.size:
            return float(np.percentile(a, pct))
    return 1.0


# --------------------------------------------------------------------------
# statistics used by prep.py / make_synthetic.py / server.py
# --------------------------------------------------------------------------
def pick_evenly(n, n_max):
    """At most ``n_max`` evenly spaced indices out of ``range(n)`` (sorted, unique)."""
    if n <= n_max:
        return np.arange(n)
    return np.unique(np.rint(np.linspace(0, n - 1, n_max)).astype(np.int64))


def mean_amplitude_spectrum(traces, dt_s, nfft=None):
    """Mean amplitude spectrum of traces (last axis = time).

    Each trace is Hann-tapered, |rfft| is taken (zero-padded to ``nfft``)
    and the magnitudes are averaged.  Returns ``(f_hz, amp)`` (float64,
    not normalised).
    """
    x = np.asarray(traces, dtype=np.float64)
    x = x.reshape(-1, x.shape[-1])
    n = x.shape[-1]
    nfft = n if nfft is None else max(int(nfft), n)
    spec = np.abs(sfft.rfft(x * np.hanning(n)[None, :], nfft, axis=-1)).mean(axis=0)
    return sfft.rfftfreq(nfft, dt_s), spec


def sample_traces(cube_ixt, n_traces, seed=0):
    """Fixed-seed random sample of whole traces from an (il, xl, t) cube -> (n, n_t)."""
    n_il, n_xl, _ = cube_ixt.shape
    total = n_il * n_xl
    n = int(min(total, n_traces))
    rng = np.random.default_rng(seed)
    flat = np.sort(rng.choice(total, size=n, replace=False))
    return np.stack([np.asarray(cube_ixt[i // n_xl, i % n_xl, :], dtype=np.float32) for i in flat])


def amplitude_stats(sample):
    """rms and percentiles of |amplitude| of a sample -> dict for meta["amp"]."""
    a = np.abs(np.asarray(sample, dtype=np.float32).ravel())
    p = np.percentile(a, [50, 90, 99, 99.5, 99.9])
    return {
        "rms": float(np.sqrt(np.mean(np.square(a, dtype=np.float64)))),
        "p50": float(p[0]), "p90": float(p[1]), "p99": float(p[2]),
        "p995": float(p[3]), "p999": float(p[4]),
        "n_sample": int(a.size),
        "zero_fraction": float(np.mean(a == 0)),
    }


def cube_statistics(cube_ixt, dt_s, seed=0, min_samples=4_000_000, min_traces=2000):
    """Sampled statistics of a cube: ``(amp_stats_without_min_max, spectrum_dict)``.

    Uses a fixed-seed random sample of whole traces holding at least
    ``min_samples`` samples and ``min_traces`` traces (or the whole cube if
    it is smaller).  The spectrum is normalised to a maximum of 1.
    """
    n_t = cube_ixt.shape[-1]
    n_tr = max(min_traces, int(math.ceil(min_samples / n_t)))
    tr = sample_traces(cube_ixt, n_tr, seed)
    stats = amplitude_stats(tr)
    f, s = mean_amplitude_spectrum(tr, dt_s)
    mx = float(s.max())
    s = s / mx if mx > 0 else s
    spectrum = {"f_hz": [round(float(v), 4) for v in f],
                "amp": [round(float(v), 5) for v in s],
                "n_traces": int(tr.shape[0])}
    return stats, spectrum
