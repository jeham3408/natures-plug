"""Tests of the signal-processing kernels (dsp.py)."""
import numpy as np
import pytest

import dsp

DT = 0.004
N = 1001
T = np.arange(N) * DT
INNER = slice(150, N - 150)          # away from the filter edge effects

BANDS = [(None, None), (10.0, 40.0), (None, 30.0), (20.0, None)]


def tone(f, a=1.0, phase=0.0):
    return a * np.cos(2 * np.pi * f * T + phase)


# ---------------------------------------------------------------- band-pass
def test_kernel_length_rule():
    assert dsp.n_taps_for(10.0, 40.0, DT) == 201           # 3.3/(3.5*0.004) = 236 -> clamped
    assert dsp.n_taps_for(40.0, 80.0, DT) == 59            # df = 14 Hz
    assert dsp.n_taps_for(None, 60.0, DT) == 69            # low-pass, df = 12 Hz
    assert dsp.n_taps_for(100.0, None, DT) == 31           # clamped from below
    for band in [(5.0, 9.0), (30.0, 90.0), (None, 12.0), (70.0, None)]:
        n = dsp.n_taps_for(band[0], band[1], DT)
        assert n % 2 == 1 and 31 <= n <= dsp.MAX_TAPS


@pytest.mark.parametrize("band", [(10.0, 40.0), (None, 30.0), (20.0, None), (25.0, 60.0)])
def test_bandpass_kernel_is_symmetric(band):
    h = dsp.bandpass_kernel(band[0], band[1], DT)
    assert h.size % 2 == 1
    assert np.array_equal(h, h[::-1])                      # symmetric = zero phase


def test_bandpass_gain_in_and_out_of_band():
    for f in (14.0, 20.0, 25.0, 30.0, 36.0):
        for phase in (0.0, 1.1):
            x = tone(f, 1.0, phase)
            y = dsp.bandpass(x, 10.0, 40.0, DT)
            gain = np.sqrt(np.mean(y[INNER] ** 2) / np.mean(x[INNER] ** 2))
            assert abs(gain - 1.0) < 0.05, (f, gain)
            # zero phase: the output IS the input (no delay, no phase rotation)
            assert np.max(np.abs(y[INNER] - x[INNER])) < 0.05, f
    for f in (2.0, 5.0, 48.0, 60.0, 100.0):
        y = dsp.bandpass(tone(f), 10.0, 40.0, DT)
        assert np.max(np.abs(y[INNER])) < 0.05, f


def test_bandpass_zero_phase_impulse():
    x = np.zeros(N)
    x[500] = 1.0
    y = dsp.bandpass(x, 10.0, 40.0, DT).astype(np.float64)
    assert int(np.argmax(np.abs(y))) == 500
    assert np.allclose(y[500 - 100:500], y[500 + 100:500:-1], atol=1e-7)


def test_lowpass_and_highpass():
    lo = dsp.bandpass(tone(10.0), None, 30.0, DT)
    assert np.max(np.abs(lo[INNER] - tone(10.0)[INNER])) < 0.05
    assert np.max(np.abs(dsp.bandpass(tone(50.0), None, 30.0, DT)[INNER])) < 0.05
    hi = dsp.bandpass(tone(50.0), 20.0, None, DT)
    assert np.max(np.abs(hi[INNER] - tone(50.0)[INNER])) < 0.05
    assert np.max(np.abs(dsp.bandpass(tone(8.0), 20.0, None, DT)[INNER])) < 0.05


def test_no_band_is_identity():
    x = tone(17.0).astype(np.float32)
    assert np.array_equal(dsp.bandpass(x, None, None, DT), x)


def test_normalise_band():
    assert dsp.normalise_band(None, None, DT) == (None, None)
    assert dsp.normalise_band(0.0, 40.0, DT) == (None, 40.0)
    assert dsp.normalise_band(10.0, 125.0, DT) == (10.0, None)
    assert dsp.normalise_band(10.0, 500.0, DT) == (10.0, None)
    for bad in [(-1.0, 40.0), (40.0, 10.0), (10.0, 10.0), (130.0, None), (None, 0.0), (None, -5.0),
                (float("nan"), 10.0)]:
        with pytest.raises(ValueError):
            dsp.normalise_band(bad[0], bad[1], DT)


def test_convolve_same_matches_numpy():
    rng = np.random.default_rng(1)
    x = rng.standard_normal((3, 400))
    h = dsp.bandpass_kernel(10.0, 40.0, DT)
    y = dsp.convolve_same(x, h)
    for i in range(3):
        assert np.allclose(y[i], np.convolve(x[i], h, mode="same"), atol=1e-5)
    hc = dsp.analytic_kernel(10.0, 40.0, DT)
    z = dsp.convolve_same(x, hc, ext=1)
    ref = np.convolve(np.pad(x[0], 1), hc, mode="same")
    assert z.shape == (3, 402) and np.allclose(z[0], ref, atol=1e-5)


# ---------------------------------------------------------------- analytic signal
def test_analytic_kernel_real_part_is_the_bandpass():
    for flo, fhi in [(10.0, 40.0), (5.0, 60.0), (3.0, 112.5)]:
        k = dsp.analytic_kernel(flo, fhi, DT)
        assert np.allclose(k.real, dsp.bandpass_kernel(flo, fhi, DT), atol=1e-12)
        f = np.fft.fftfreq(4096, DT)
        H = np.abs(np.fft.fft(k, 4096))
        mid = 0.5 * (flo + fhi)
        assert abs(H[np.argmin(np.abs(f - mid))] - 2.0) < 0.02       # positive band doubled
        assert H[np.argmin(np.abs(f + mid))] < 0.01                  # negative band removed
    assert dsp.analytic_band(None, None, DT) == (3.0, 112.5)


@pytest.mark.parametrize("band", BANDS)
def test_envelope_of_cosine_is_its_amplitude(band):
    a = 2.5
    for f in (24.0, 26.0):                                 # inside the pass band of every case
        e = dsp.envelope(tone(f, a, 0.4), band[0], band[1], DT)
        assert np.max(np.abs(e[INNER] - a)) < 0.02 * a, (band, f)


@pytest.mark.parametrize("band", BANDS)
def test_instantaneous_frequency_of_cosine(band):
    for f in (24.0, 28.0, 30.0):
        fi = dsp.inst_freq(tone(f, 1.7, 0.3), band[0], band[1], DT)
        assert np.max(np.abs(fi[INNER] - f)) < 1.0, (band, f)
    fi = dsp.inst_freq(tone(10.0), None, None, DT)
    assert np.max(np.abs(fi[INNER] - 10.0)) < 1.0
    fi = dsp.inst_freq(tone(55.0), None, None, DT)
    assert np.max(np.abs(fi[INNER] - 55.0)) < 1.0
    assert fi.min() >= 0.0 and fi.max() <= 125.0


# ---------------------------------------------------------------- spectral decomposition
def test_spectral_decomposition_peaks_at_f0():
    a, f = 2.0, 30.0
    x = tone(f, a, 0.7)
    f0s = np.arange(10.0, 61.0, 2.5)
    resp = np.array([np.median(dsp.spectral_decomp(x, f0, DT)[INNER]) for f0 in f0s])
    assert f0s[int(np.argmax(resp))] == f
    assert abs(resp.max() - a) < 0.01 * a
    sd = dsp.spectral_decomp(x, f, DT)
    assert np.max(np.abs(sd[INNER] - a)) < 0.01 * a
    assert resp[0] < 0.1 * a and resp[-1] < 0.3 * a
    for f0 in (5.0, 30.0, 110.0):
        assert dsp.gabor_kernel(f0, DT).size <= dsp.MAX_TAPS
    with pytest.raises(ValueError):
        dsp.gabor_kernel(125.0, DT)


# ---------------------------------------------------------------- RMS
def test_rms_length():
    assert dsp.rms_length(100.0, 4.0) == 25
    assert dsp.rms_length(90.0, 4.0) == 23
    assert dsp.rms_length(4.0, 4.0) == 3
    assert dsp.rms_length(1000.0, 4.0) in (249, 251)
    assert dsp.clamp_win_ms(1.0, 4.0) == 12.0 and dsp.clamp_win_ms(5000.0, 4.0) == 1000.0


def test_rms_of_cosine():
    a = 3.0
    x = tone(30.0, a, 0.2)
    r = dsp.moving_rms(x, dsp.rms_length(100.0, 4.0))         # 100 ms = 3 periods of 30 Hz
    assert np.max(np.abs(r[20:-20] - a / np.sqrt(2))) < 0.01 * a
    r2 = dsp.moving_rms(tone(17.0, a), dsp.rms_length(400.0, 4.0))
    assert np.max(np.abs(r2[60:-60] - a / np.sqrt(2))) < 0.03 * a


def test_rms_edges_use_the_samples_inside_the_trace():
    rng = np.random.default_rng(2)
    x = rng.standard_normal(60)
    r = dsp.moving_rms(x, 11)
    for n in (0, 1, 4, 5, 30, 54, 58, 59):
        seg = x[max(0, n - 5):min(60, n + 6)]
        assert abs(r[n] - np.sqrt(np.mean(seg ** 2))) < 1e-6
    assert np.allclose(dsp.moving_rms(np.full(40, -2.0), 9), 2.0)


# ---------------------------------------------------------------- image helpers
def test_block_factors_and_block_mean():
    assert dsp.block_factors(1001, 2731, 900, 1600) == (2, 2)
    assert dsp.block_factors(100, 100, 900, 1600) == (1, 1)
    assert dsp.block_factors(301, 2731, 64, 64) == (5, 43)
    a = np.arange(70, dtype=np.float32).reshape(7, 10)
    b = dsp.block_mean(a, 2, 3)
    assert b.shape == (4, 4)
    assert b[0, 0] == pytest.approx(a[0:2, 0:3].mean())
    assert b[1, 2] == pytest.approx(a[2:4, 6:9].mean())
    assert b[3, 3] == pytest.approx(a[6:7, 9:10].mean())      # incomplete edge block
    assert b[0, 3] == pytest.approx(a[0:2, 9:10].mean())
    assert np.array_equal(dsp.block_mean(a, 1, 1), a)
    assert dsp.block_mean(np.ones((1001, 2731), np.float32), 2, 2).shape == (501, 1366)


def test_8bit_coding_round_trip():
    rng = np.random.default_rng(3)
    vmax = 3.7
    v = rng.uniform(-1.5 * vmax, 1.5 * vmax, 5000)
    p = dsp.encode_signed(v, vmax)
    assert p.dtype == np.uint8 and p.min() == 1 and p.max() == 255
    back = dsp.decode_signed(p, vmax)
    assert np.max(np.abs(back - np.clip(v, -vmax, vmax))) <= 0.5 * vmax / 127 + 1e-5
    assert dsp.encode_signed(np.array([0.0, vmax, -vmax, 10 * vmax, -10 * vmax]), vmax).tolist() == \
        [128, 255, 1, 255, 1]
    u = rng.uniform(-0.2 * vmax, 1.5 * vmax, 5000)
    q = dsp.encode_unsigned(u, vmax)
    assert q.min() == 0 and q.max() == 255
    assert np.max(np.abs(dsp.decode_unsigned(q, vmax) - np.clip(u, 0, vmax))) <= 0.5 * vmax / 255 + 1e-5
    assert dsp.encode_unsigned(np.array([0.0, vmax, 2 * vmax, np.nan]), vmax).tolist() == [0, 255, 255, 0]


def test_robust_vmax():
    assert dsp.robust_vmax(np.zeros((4, 4))) == 1.0
    a = np.linspace(-1, 1, 2001)
    assert dsp.robust_vmax(a) == pytest.approx(0.995, abs=2e-3)
    # a NaN or an image that is almost all zeros must not collapse the scale to 1.0
    assert dsp.robust_vmax(np.array([1e4, 2e4, np.nan])) == pytest.approx(2e4, rel=0.01)
    assert dsp.robust_vmax(np.array([np.inf, -3.0, 2.0])) == pytest.approx(3.0, rel=0.01)
    z = np.zeros(10000)
    z[:40] = 1000.0                                      # 99.6 % zeros
    assert dsp.robust_vmax(z) == pytest.approx(1000.0)
    assert dsp.robust_vmax(np.array([np.nan, np.nan])) == 1.0 and dsp.robust_vmax(np.array([])) == 1.0


# ---------------------------------------------------------------- reviewer findings
def test_instantaneous_frequency_is_valid_up_to_nyquist():
    """The two-sample phase difference wrapped above Nyquist/2 (62.5 Hz) and read 0 Hz there."""
    for f in (5.0, 30.0, 62.0, 63.0, 70.0, 80.0, 100.0, 110.0):
        fi = dsp.inst_freq(tone(f, 1.3, 0.2), 3.0, 122.0, DT)
        assert np.max(np.abs(fi[INNER] - f)) < 0.5, f
    # below Nyquist/2 the result is the contract formula angle(z[n+1] conj z[n-1]) / (4 pi dt)
    rng = np.random.default_rng(5)
    x = dsp.bandpass(rng.standard_normal(N), 5.0, 55.0, DT)
    z = dsp.analytic(x, 5.0, 55.0, DT, ext=1).astype(np.complex128)
    ref = np.clip(np.angle(z[2:] * np.conj(z[:-2])) / (4 * np.pi * DT), 0, 125.0)
    fi = dsp.inst_freq(x, 5.0, 55.0, DT)
    ok = (ref > 1.0) & (ref < 60.0)
    assert ok.mean() > 0.8 and np.max(np.abs(fi[ok] - ref[ok])) < 1e-2
    # linear chirp 5 -> 110 Hz
    f_t = 5.0 + (110.0 - 5.0) * T / T[-1]
    chirp = np.cos(2 * np.pi * np.cumsum(f_t) * DT)
    fi = dsp.inst_freq(chirp, None, None, DT)
    sel = slice(150, N - 150)
    assert np.max(np.abs(fi[sel] - f_t[sel])) < 3.0


def test_response_band_and_decomposition_range():
    lo, hi = dsp.response_band(dsp.gabor_kernel(30.0, DT), DT)
    assert abs(lo - 20.6) < 0.3 and abs(hi - 39.4) < 0.3            # +-31 %, not "30 Hz"
    lo, hi = dsp.response_band(dsp.bandpass_kernel(15.0, 30.0, DT), DT)
    assert abs(lo - 15.0) < 0.3 and abs(hi - 30.0) < 0.3
    assert dsp.response_band(dsp.bandpass_kernel(0.5, 40.0, DT), DT)[0] == 0.0   # no -6 dB point on the low side
    lo, hi = dsp.response_band(dsp.bandpass_kernel(10.0, 11.0, DT), DT)
    assert hi - lo > 2.0                                             # a 1 Hz band cannot be made with 201 taps
    assert dsp.response_band(dsp.bandpass_kernel(None, 30.0, DT), DT)[0] == 0.0
    assert dsp.response_band(dsp.bandpass_kernel(20.0, None, DT), DT)[1] == pytest.approx(125.0)
    f_min, f_max = dsp.sd_f0_range(DT)
    assert (f_min, f_max) == (5.0, 100.0)
    # inside the allowed range a constant trace is rejected and a unit cosine at f0 reads 1
    for f0 in (f_min, 10.0, 30.0, 60.0, f_max):
        assert np.max(dsp.spectral_decomp(np.ones(N), f0, DT)[INNER]) < 0.01, f0
        sd = dsp.spectral_decomp(tone(f0, 1.0, 0.4), f0, DT)[INNER]
        assert np.max(np.abs(sd - 1.0)) < 0.05, f0


def test_non_finite_samples_count_as_zero_in_sections_and_slices():
    """One NaN used to blank its whole trace in sections (FFT) and to set vmax to 1.0."""
    rng = np.random.default_rng(11)
    ixt = dsp.bandpass(rng.standard_normal((6, 9, 300)), 8.0, 50.0, DT).astype(np.float32) * 1000.0
    dirty = ixt.copy()
    dirty[2, 4, 150] = np.nan
    dirty[3, 1, 10] = np.inf
    zeroed = np.nan_to_num(dirty, nan=0.0, posinf=0.0, neginf=0.0)
    tix_d, tix_z = np.ascontiguousarray(dirty.transpose(2, 0, 1)), np.ascontiguousarray(zeroed.transpose(2, 0, 1))
    for attr, band in [("amp", (None, None)), ("amp", (10.0, 40.0)), ("rms", (None, None)), ("rms", (10.0, 40.0)),
                       ("env", (None, None)), ("ifreq", (10.0, 40.0)), ("sd", (None, None))]:
        kw = dict(flo=band[0], fhi=band[1], win_ms=60.0, f0=30.0)
        sec_d, _ = dsp.section_attribute(dirty[2], attr, DT, **kw)
        sec_z, _ = dsp.section_attribute(zeroed[2], attr, DT, **kw)
        assert np.isfinite(sec_d).all() and np.array_equal(sec_d, sec_z), attr
        for k in (5, 140, 150, 160, 290):
            sl_d, _ = dsp.slice_attribute(tix_d, k, slice(None), slice(None), attr, DT, **kw)
            sl_z, _ = dsp.slice_attribute(tix_z, k, slice(None), slice(None), attr, DT, **kw)
            assert np.isfinite(sl_d).all() and np.allclose(sl_d, sl_z, rtol=1e-5, atol=1e-3), (attr, k)
            tol = 1e-4 * float(np.sqrt(np.mean(np.square(sec_d, dtype=np.float64)))) + (0.01 if attr == "ifreq" else 0)
            assert np.max(np.abs(sl_d[2] - sec_d[:, k])) <= tol, (attr, k)
        assert 100.0 < dsp.robust_vmax(sec_d) < 1e5 or attr == "ifreq"


def test_slice_computation_can_be_cancelled(synth):
    n_t, n_il, n_xl = synth.tix.shape
    calls = []

    def stop_after_two():
        calls.append(1)
        return len(calls) > 2
    with pytest.raises(dsp.Cancelled):
        dsp.slice_attribute(synth.tix, 200, slice(0, n_il), slice(0, n_xl), "env", synth.dt_s, 10.0, 40.0,
                            chunk_bytes=400_000, should_stop=stop_after_two)
    assert len(calls) == 3                                # polled before every inline chunk, stopped at once
    out, _ = dsp.slice_attribute(synth.tix, 200, slice(0, n_il), slice(0, n_xl), "env", synth.dt_s, 10.0, 40.0,
                                 should_stop=lambda: False)
    assert out.shape == (n_il, n_xl)


# ---------------------------------------------------------------- the tone block of the synthetic cube
def test_tone_block_truth(synth):
    tb = synth.truth["tone_block"]
    i, j = synth.il_index(tb["il"][0]), synth.xl_index(tb["xl"][1])
    x = np.asarray(synth.ixt[i, j, :], dtype=np.float64)
    t_ms = synth.meta["t0_ms"] + synth.meta["dt_ms"] * np.arange(x.size)
    assert np.allclose(x, tb["amp"] * np.cos(2 * np.pi * tb["f_hz"] * t_ms / 1000.0), atol=1e-6)
    inner = slice(120, x.size - 120)
    dt = synth.dt_s
    assert np.max(np.abs(dsp.envelope(x, None, None, dt)[inner] - tb["amp"])) < 0.02
    assert np.max(np.abs(dsp.inst_freq(x, None, None, dt)[inner] - tb["f_hz"])) < 1.0
    assert np.max(np.abs(dsp.spectral_decomp(x, tb["f_hz"], dt)[inner] - tb["amp"])) < 0.01
    assert np.max(np.abs(dsp.moving_rms(x, 25)[inner] - tb["amp"] / np.sqrt(2))) < 0.01
    assert np.max(np.abs(dsp.bandpass(x, 50.0, 90.0, dt)[inner])) < 0.05


# ---------------------------------------------------------------- slice == section
CASES = [(attr, band) for attr in ("amp", "rms", "env", "ifreq") for band in BANDS] + [("sd", (None, None))]


@pytest.mark.parametrize("attr,band", CASES)
def test_slice_equals_section(synth, attr, band):
    """A slice value equals the section value at the same (inline, crossline, time)."""
    n_t, n_il, n_xl = synth.tix.shape
    dt = synth.dt_s
    kw = dict(flo=band[0], fhi=band[1], win_ms=100.0, f0=30.0)
    inlines = [0, 4, n_il // 2, n_il - 1]
    sections = {i: dsp.section_attribute(np.asarray(synth.ixt[i]), attr, dt, **kw) for i in inlines}
    times = [0, 1, 2, 7, 60, 250, 333, n_t - 8, n_t - 3, n_t - 2, n_t - 1]   # top, interior, bottom
    for k in times:
        sl, taps = dsp.slice_attribute(synth.tix, k, slice(0, n_il), slice(0, n_xl), attr, dt, **kw)
        assert sl.shape == (n_il, n_xl) and sl.dtype == np.float32
        for i in inlines:
            sec, taps_s = sections[i]
            assert taps == taps_s
            tol = 1e-4 * float(np.sqrt(np.mean(np.square(sec, dtype=np.float64))))
            assert np.max(np.abs(sl[i] - sec[:, k])) <= tol, (attr, band, k, i)


def test_slice_window_and_chunking(synth):
    n_t, n_il, n_xl = synth.tix.shape
    dt = synth.dt_s
    full, _ = dsp.slice_attribute(synth.tix, 200, slice(0, n_il), slice(0, n_xl), "env", dt, 10.0, 40.0)
    part, _ = dsp.slice_attribute(synth.tix, 200, slice(5, 20), slice(30, 200), "env", dt, 10.0, 40.0,
                                  chunk_bytes=200_000)        # forces many small inline chunks
    assert part.shape == (15, 170)
    assert np.allclose(part, full[5:20, 30:200], atol=1e-5)
    rms_long, _ = dsp.slice_attribute(synth.tix, 3, slice(0, 8), slice(0, 50), "rms", dt, 10.0, 40.0,
                                      win_ms=1000.0)
    sec, _ = dsp.section_attribute(np.asarray(synth.ixt[2, :50]), "rms", dt, 10.0, 40.0, win_ms=1000.0)
    assert np.allclose(rms_long[2], sec[:, 3], atol=1e-4)
    with pytest.raises(ValueError):
        dsp.slice_attribute(synth.tix, n_t, slice(0, 2), slice(0, 2), "amp", dt)


def test_read_slab_direct_reads_equal_the_memory_map(synth):
    """The positional-read path (full crossline range of a memory-mapped cube) returns exactly the mapped data."""
    n_t, n_il, n_xl = synth.tix.shape
    assert isinstance(synth.tix, np.memmap)
    for ta, tb, ia, ib in [(0, n_t - 1, 0, n_il), (100, 300, 3, n_il - 2), (n_t - 1, n_t - 1, 0, n_il)]:
        got = dsp.read_slab(synth.tix, ta, tb, ia, ib, 0, n_xl)
        assert got.dtype == np.float32 and got.flags.c_contiguous and got.flags.writeable
        assert np.array_equal(got, np.asarray(synth.tix[ta:tb + 1, ia:ib, :]))
    part = dsp.read_slab(synth.tix, 10, 60, 2, 9, 5, 40)                     # zoomed window: sliced
    assert np.array_equal(part, np.asarray(synth.tix[10:61, 2:9, 5:40]))
    mem = np.array(synth.tix[:50])                                           # plain array in memory
    assert np.array_equal(dsp.read_slab(mem, 0, 49, 0, n_il, 0, n_xl), mem)


def test_ibm_floats():
    """SEG-Y format 1: IBM hexadecimal floats, checked against known bit patterns."""
    import prep
    u = np.array([0x42640000, 0xC2640000, 0x00000000, 0x40800000, 0x41100000, 0xC0200000], dtype=np.uint32)
    assert np.allclose(prep.ibm_to_ieee(u), [100.0, -100.0, 0.0, 0.5, 1.0, -0.125])
