"""Tests of the HTTP back end (server.py) against the synthetic cube."""
import gzip
import http.client
import io
import json
import os
import signal
import socket
import subprocess
import sys
import time

import numpy as np
import pytest
from PIL import Image

import dsp

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INFO_COMMON = {"endpoint", "attr", "signed", "unit", "vmax", "rows", "cols", "src_rows", "src_cols",
               "flo", "fhi", "win_ms", "f0", "taps", "band6", "ms", "queued_ms", "cached"}


def global_vmax(synth, attr, flo=None, fhi=None, win=100.0, f0=30.0):
    """The documented default scale: 99.5th percentile of |attribute| over the fixed-seed trace sample."""
    y, _ = dsp.section_attribute(dsp.sample_traces(synth.ixt, 2000, seed=0), attr, synth.dt_s, flo, fhi, win, f0)
    return dsp.robust_vmax(y, 99.5)


def http_get(live, path, headers=None, method="GET"):
    conn = http.client.HTTPConnection(live[0], live[1], timeout=60)
    try:
        conn.request(method, path, headers=headers or {})
        r = conn.getresponse()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, r.read()
    finally:
        conn.close()


def get_json(live, path):
    status, hdr, body = http_get(live, path)
    assert hdr["content-type"].startswith("application/json"), (path, hdr)
    return status, json.loads(body)


def get_image(live, path):
    """-> (pixels uint8 2-D, info dict, headers)"""
    status, hdr, body = http_get(live, path)
    assert status == 200, (path, status, body[:200])
    info = json.loads(hdr["x-sv-info"])
    pix = np.array(Image.open(io.BytesIO(body)))
    assert pix.ndim == 2 and pix.dtype == np.uint8
    assert pix.shape == (info["rows"], info["cols"])
    return pix, info, hdr


def decode(pix, info):
    return dsp.decode_signed(pix, info["vmax"]) if info["signed"] else dsp.decode_unsigned(pix, info["vmax"])


def quantum(info):
    """Largest error of the 8-bit coding (half a grey level) plus float slack."""
    return (0.5 / 127 if info["signed"] else 0.5 / 255) * info["vmax"] * 1.02 + 1e-6


def check_pixels(pix, info, expected):
    """Decoded pixels equal ``expected`` (clipped to the coded range) within quantisation."""
    lo = -info["vmax"] if info["signed"] else 0.0
    exp = np.clip(np.asarray(expected, dtype=np.float64), lo, info["vmax"])
    assert pix.shape == exp.shape
    err = np.max(np.abs(decode(pix, info) - exp))
    assert err <= quantum(info), (err, quantum(info))


# ------------------------------------------------------------------ basics
def test_health(live):
    assert get_json(live, "/api/health") == (200, {"ok": True})


def test_meta(live, synth):
    status, m = get_json(live, "/api/meta")
    assert status == 200
    for key in ("name", "synthetic", "attribution", "licence", "doi", "n_il", "n_xl", "n_t", "il0", "il_step",
                "xl0", "xl_step", "t0_ms", "dt_ms", "domain", "nyquist_hz", "il_axis_m", "xl_axis_m",
                "origin_xy", "crs", "amp", "spectrum", "textual_header", "truth", "server"):
        assert key in m, key
    assert m["synthetic"] is True and m["name"] == "SYNTHETIC TEST CUBE" and m["domain"] == "time"
    assert (m["n_il"], m["n_xl"], m["n_t"]) == synth.ixt.shape
    assert m["server"]["attrs"] == ["amp", "rms", "env", "ifreq", "sd"]
    assert m["server"]["max_taps"] == 201 and isinstance(m["server"]["version"], str)
    assert set(m["amp"]) >= {"min", "max", "rms", "p50", "p90", "p99", "p995", "p999"}
    assert m["amp"]["min"] < 0 < m["amp"]["p50"] < m["amp"]["p90"] < m["amp"]["p999"] <= m["amp"]["max"]
    assert m["il_axis_m"] == [0.0, 37.5] and m["xl_axis_m"] == [-12.5, 0.0]
    assert max(m["spectrum"]["amp"]) == pytest.approx(1.0) and len(m["spectrum"]["f_hz"]) == len(m["spectrum"]["amp"])
    assert len(m["textual_header"]) == 40


def test_meta_gzip(live):
    status, hdr, body = http_get(live, "/api/meta", headers={"Accept-Encoding": "gzip"})
    assert status == 200 and hdr.get("content-encoding") == "gzip"
    assert json.loads(gzip.decompress(body))["server"]["max_taps"] == 201
    status, hdr, body = http_get(live, "/api/meta")
    assert "content-encoding" not in hdr and json.loads(body)["n_t"] > 0


# ------------------------------------------------------------------ sections
def test_inline_section_pixels_and_info(live, synth):
    m = synth.meta
    line = m["il0"] + 3 * m["il_step"]
    pix, info, hdr = get_image(live, "/api/section?kind=il&line=%d&fmt=png" % line)
    assert hdr["content-type"] == "image/png"
    assert hdr["cache-control"] == "no-store"
    assert hdr["access-control-expose-headers"] == "X-SV-Info"
    assert hdr["x-sv-info"].isascii()
    assert set(info) == INFO_COMMON | {"kind", "line", "a0", "a1", "t0", "t1"}
    assert info["endpoint"] == "section" and info["attr"] == "amp" and info["signed"] is True
    assert info["unit"] == "amplitude" and info["kind"] == "il" and info["line"] == line
    assert (info["rows"], info["cols"]) == (m["n_t"], m["n_xl"]) == (info["src_rows"], info["src_cols"])
    assert info["a0"] == m["xl0"] and info["a1"] == m["xl0"] + (m["n_xl"] - 1) * m["xl_step"]
    assert info["t0"] == m["t0_ms"] and info["t1"] == m["t0_ms"] + (m["n_t"] - 1) * m["dt_ms"]
    assert info["vmax"] == pytest.approx(m["amp"]["p999"])        # global scale for unfiltered amplitude
    assert info["flo"] is None and info["fhi"] is None and info["taps"] == 0
    assert info["win_ms"] == 100.0 and info["f0"] == 30.0 and info["cached"] is False
    assert isinstance(info["ms"], float)
    # rows = time downward, columns = crossline number increasing to the right
    check_pixels(pix, info, np.asarray(synth.ixt[3]).T)


def test_crossline_section_pixels(live, synth):
    m = synth.meta
    j = 77
    pix, info, _ = get_image(live, "/api/section?kind=xl&line=%d&fmt=png" % (m["xl0"] + j * m["xl_step"]))
    assert info["kind"] == "xl" and (info["rows"], info["cols"]) == (m["n_t"], m["n_il"])
    assert info["a0"] == m["il0"] and info["a1"] == m["il0"] + (m["n_il"] - 1) * m["il_step"]
    check_pixels(pix, info, np.asarray(synth.ixt[:, j, :]).T)


def test_line_number_to_index_mapping(live, synth):
    m = synth.meta
    pix, info, _ = get_image(live, "/api/section?kind=il&line=%d&fmt=png" % (m["il0"] + m["il_step"]))
    check_pixels(pix, info, np.asarray(synth.ixt[1]).T)            # il0 + il_step is index 1
    last = m["il0"] + (m["n_il"] - 1) * m["il_step"]
    pix, info, _ = get_image(live, "/api/section?kind=il&line=%d&fmt=png" % last)
    check_pixels(pix, info, np.asarray(synth.ixt[m["n_il"] - 1]).T)
    for bad in (m["il0"] + 1, m["il0"] - m["il_step"], last + m["il_step"]):
        status, err = get_json(live, "/api/section?kind=il&line=%d" % bad)
        assert status == 400 and "error" in err, bad
    status, err = get_json(live, "/api/section?kind=xl&line=%d" % (m["xl0"] + m["n_xl"]))
    assert status == 400 and "error" in err


def test_section_cropping_and_snapping(live, synth):
    m = synth.meta
    q = "/api/section?kind=il&line=%d&fmt=png&a0=%s&a1=%s&t0=%s&t1=%s" % (
        m["il0"] + 10 * m["il_step"], m["xl0"] + 20.4, m["xl0"] + 119.6, m["t0_ms"] + 201.0, m["t0_ms"] + 598.9)
    pix, info, _ = get_image(live, q)
    assert (info["a0"], info["a1"]) == (m["xl0"] + 20, m["xl0"] + 120)
    assert (info["t0"], info["t1"]) == (m["t0_ms"] + 200.0, m["t0_ms"] + 600.0)
    assert (info["rows"], info["cols"]) == (101, 101)
    check_pixels(pix, info, np.asarray(synth.ixt[10, 20:121, 50:151]).T)
    # crossline section cropped in inline NUMBERS (step 2); out-of-range values are clamped
    q = "/api/section?kind=xl&line=%d&fmt=png&a0=%d&a1=%d&t0=0&t1=99999" % (
        m["xl0"] + 5, m["il0"] + 8 * m["il_step"], m["il0"] + 30 * m["il_step"])
    pix, info, _ = get_image(live, q)
    assert (info["a0"], info["a1"]) == (m["il0"] + 8 * m["il_step"], m["il0"] + 30 * m["il_step"])
    assert info["cols"] == 23 and info["rows"] == m["n_t"]
    check_pixels(pix, info, np.asarray(synth.ixt[8:31, 5, :]).T)


def test_reduction_factors(live, synth):
    m = synth.meta
    pix, info, _ = get_image(live, "/api/section?kind=il&line=%d&fmt=png&w=100&h=64" % m["il0"])
    fr, fc = -(-m["n_t"] // 64), -(-m["n_xl"] // 100)              # ceil(src / limit)
    assert (info["src_rows"], info["src_cols"]) == (m["n_t"], m["n_xl"])
    assert (info["rows"], info["cols"]) == (-(-m["n_t"] // fr), -(-m["n_xl"] // fc))
    assert info["rows"] <= 64 and info["cols"] <= 100
    check_pixels(pix, info, dsp.block_mean(np.asarray(synth.ixt[0]).T, fr, fc))
    # limits are clamped to 64..4096 and the image is never upsampled
    pix, info, _ = get_image(live, "/api/section?kind=il&line=%d&fmt=png&w=1&h=100000" % m["il0"])
    assert info["cols"] == -(-m["n_xl"] // -(-m["n_xl"] // 64)) and info["rows"] == m["n_t"]
    # reduction happens AFTER the attribute is computed
    pix, info, _ = get_image(live, "/api/section?kind=il&line=%d&fmt=png&attr=env&w=100&h=64" % m["il0"])
    env, _ = dsp.section_attribute(np.asarray(synth.ixt[0]), "env", synth.dt_s)
    check_pixels(pix, info, dsp.block_mean(env.T, fr, fc))


@pytest.mark.parametrize("attr,extra", [
    ("amp", "&flo=10&fhi=40"), ("amp", "&fhi=25"), ("amp", "&flo=30"),
    ("rms", ""), ("rms", "&flo=10&fhi=40&win_ms=60"),
    ("env", ""), ("env", "&flo=10&fhi=40"),
    ("ifreq", ""), ("ifreq", "&flo=10&fhi=40"),
    ("sd", "&f0=20"), ("sd", "&f0=45&flo=10&fhi=20"),
])
def test_section_attributes_match_dsp(live, synth, attr, extra):
    m = synth.meta
    i = 30
    args = dict(p.split("=") for p in extra.strip("&").split("&")) if extra else {}
    flo = float(args["flo"]) if "flo" in args else None
    fhi = float(args["fhi"]) if "fhi" in args else None
    win = float(args.get("win_ms", 100.0))
    f0 = float(args.get("f0", 30.0))
    pix, info, _ = get_image(live, "/api/section?kind=il&line=%d&fmt=png&attr=%s%s"
                             % (m["il0"] + i * m["il_step"], attr, extra))
    if attr == "sd":
        flo = fhi = None                                           # band-pass ignored for sd
    exp, taps = dsp.section_attribute(np.asarray(synth.ixt[i]), attr, synth.dt_s, flo, fhi, win, f0)
    assert info["attr"] == attr and info["signed"] is (attr == "amp")
    assert info["unit"] == ("Hz" if attr == "ifreq" else "amplitude")
    assert info["flo"] == flo and info["fhi"] == fhi and info["taps"] == taps and info["f0"] == f0
    assert info["win_ms"] == win
    if attr == "ifreq":
        assert info["vmax"] == (fhi if fhi is not None else min(m["nyquist_hz"], 100.0))
    else:
        assert info["vmax"] == pytest.approx(global_vmax(synth, attr, flo, fhi, win, f0), rel=1e-5)
    check_pixels(pix, info, exp.T)


def test_default_vmax_rules(live, synth):
    m = synth.meta
    base = "/api/section?kind=il&line=%d&fmt=png" % m["il0"]
    assert get_image(live, base)[1]["vmax"] == pytest.approx(m["amp"]["p999"])
    assert get_image(live, base + "&attr=ifreq")[1]["vmax"] == 100.0
    assert get_image(live, base + "&attr=ifreq&fhi=40")[1]["vmax"] == 40.0
    assert get_image(live, base + "&attr=ifreq&flo=10")[1]["vmax"] == 100.0
    pix, info, _ = get_image(live, base + "&vmax=2.5")
    assert info["vmax"] == 2.5
    check_pixels(pix, info, np.asarray(synth.ixt[0]).T)
    pix, info, _ = get_image(live, base + "&attr=env&vmax=0.75")
    assert info["vmax"] == 0.75
    # "everything else": ONE scale per parameter set (99.5th percentile over a fixed-seed trace sample),
    # whatever the image size
    want = global_vmax(synth, "amp", 8.0, 30.0)
    for size in ("", "&w=64&h=64", "&w=200&h=100"):
        assert get_image(live, base + "&flo=8&fhi=30" + size)[1]["vmax"] == pytest.approx(want, rel=1e-5)
    pix, info, _ = get_image(live, "/api/slice?t=2000&fmt=png")
    assert info["vmax"] == pytest.approx(m["amp"]["p999"])
    pix, info, _ = get_image(live, "/api/slice?t=2000&fmt=png&attr=rms")
    assert info["vmax"] == pytest.approx(global_vmax(synth, "rms"), rel=1e-5)


@pytest.mark.parametrize("extra,kw", [
    ("&flo=5&fhi=15", dict(attr="amp", flo=5.0, fhi=15.0)),
    ("&attr=env", dict(attr="env")),
    ("&attr=rms&win_ms=200&flo=10&fhi=40", dict(attr="rms", flo=10.0, fhi=40.0, win=200.0)),
    ("&attr=sd&f0=60", dict(attr="sd", f0=60.0)),
])
def test_filtered_views_share_one_scale(live, synth, extra, kw):
    """Reviewer finding: the scale must not change with time, panel, zoom window or image size."""
    m = synth.meta
    seen = set()
    for t in (m["t0_ms"], 2000.0, 2500.0, 3000.0, m["t0_ms"] + (m["n_t"] - 1) * m["dt_ms"]):
        seen.add(get_image(live, "/api/slice?t=%g&fmt=png%s" % (t, extra))[1]["vmax"])
    seen.add(get_image(live, "/api/slice?t=2200&fmt=png&w=64&h=64&i0=%d&i1=%d%s"
                       % (m["il0"] + 4, m["il0"] + 40, extra))[1]["vmax"])
    for i in (0, m["n_il"] // 2, m["n_il"] - 1):
        seen.add(get_image(live, "/api/section?kind=il&line=%d&fmt=png%s" % (m["il0"] + i * m["il_step"], extra))[1]["vmax"])
    seen.add(get_image(live, "/api/section?kind=xl&line=%d&fmt=png&w=64&h=64&t0=2000&t1=2400%s"
                       % (m["xl0"] + 9, extra))[1]["vmax"])
    assert len(seen) == 1, seen
    assert seen.pop() == pytest.approx(global_vmax(synth, **kw), rel=1e-5)
    # so the same sample has the same pixel code in a slice and in a section
    sl = get_image(live, "/api/slice?t=2300&fmt=png%s" % extra)[0]
    sec = get_image(live, "/api/section?kind=il&line=%d&fmt=png%s" % (m["il0"] + 20 * m["il_step"], extra))[0]
    assert np.max(np.abs(sl[20].astype(int) - sec[synth.t_index(2300.0)].astype(int))) <= 1


def test_info_reports_real_band_and_queue_time(live, synth):
    base = "/api/section?kind=il&line=%d&fmt=png" % synth.meta["il0"]
    info = get_image(live, base)[1]
    assert info["band6"] is None and info["queued_ms"] == 0.0
    lo, hi = get_image(live, base + "&flo=10&fhi=40")[1]["band6"]
    assert abs(lo - 10.0) < 0.3 and abs(hi - 40.0) < 0.3
    lo, hi = get_image(live, base + "&flo=0.5&fhi=40")[1]["band6"]     # 201 taps cannot realise a 0.5 Hz corner
    assert lo == 0.0 and abs(hi - 40.0) < 0.3
    lo, hi = get_image(live, base + "&flo=10&fhi=11")[1]["band6"]      # ... nor a 1 Hz wide band
    assert hi - lo > 2.0
    lo, hi = get_image(live, base + "&attr=sd&f0=60")[1]["band6"]      # one "frequency" is a band of +-31 %
    assert abs(lo - 41.3) < 0.5 and abs(hi - 78.7) < 0.5
    lo, hi = get_image(live, base + "&attr=env")[1]["band6"]
    assert lo < 4.5 and hi > 110.0


def test_win_ms_is_clamped_and_reported(live, synth):
    m = synth.meta
    base = "/api/section?kind=il&line=%d&fmt=png&attr=rms" % m["il0"]
    assert get_image(live, base + "&win_ms=1")[1]["win_ms"] == 3 * m["dt_ms"]
    assert get_image(live, base + "&win_ms=90")[1]["win_ms"] == 92.0          # 23 samples
    info = get_image(live, base + "&win_ms=99999")[1]
    assert 996.0 <= info["win_ms"] <= 1004.0


def test_jpeg_is_default_and_close_to_png(live, synth):
    m = synth.meta
    base = "/api/section?kind=il&line=%d" % (m["il0"] + 2 * m["il_step"])
    status, hdr, body = http_get(live, base)
    assert status == 200 and hdr["content-type"] == "image/jpeg" and body[:2] == b"\xff\xd8"
    jpg = np.array(Image.open(io.BytesIO(body))).astype(float)
    png = get_image(live, base + "&fmt=png")[0].astype(float)
    assert jpg.shape == png.shape and np.mean(np.abs(jpg - png)) < 6.0
    small = http_get(live, base + "&q=40")[2]
    big = http_get(live, base + "&q=95")[2]
    assert len(small) < len(body) < len(big) < 400_000


def test_cache_flag(live, synth):
    path = "/api/section?kind=il&line=%d&fmt=png&attr=env&flo=12&fhi=33" % (synth.meta["il0"] + 8)
    a, info_a, _ = get_image(live, path)
    b, info_b, _ = get_image(live, path + "&w=1600")               # same normalised parameters
    assert info_a["cached"] is False and info_b["cached"] is True
    assert np.array_equal(a, b)
    assert {k: v for k, v in info_a.items() if k not in ("ms", "queued_ms", "cached")} == \
           {k: v for k, v in info_b.items() if k not in ("ms", "queued_ms", "cached")}
    assert live[2].RequestHandlerClass.engine.responses.max_items >= 64


# ------------------------------------------------------------------ slices
def test_slice_pixels_info_and_orientation(live, synth):
    m, f = synth.meta, synth.truth["f_marker"]
    pix, info, hdr = get_image(live, "/api/slice?t=%g&fmt=png&vmax=%g" % (f["t_ms"], f["amp"]))
    assert set(info) == INFO_COMMON | {"t", "i0", "i1", "x0", "x1"}
    assert info["endpoint"] == "slice" and info["t"] == f["t_ms"]
    assert (info["i0"], info["i1"]) == (m["il0"], m["il0"] + (m["n_il"] - 1) * m["il_step"])
    assert (info["x0"], info["x1"]) == (m["xl0"], m["xl0"] + (m["n_xl"] - 1) * m["xl_step"])
    assert (info["rows"], info["cols"]) == (m["n_il"], m["n_xl"])
    k = synth.t_index(f["t_ms"])
    check_pixels(pix, info, np.asarray(synth.tix[k]))
    amp = decode(pix, info)

    # the letter F from the truth, placed with the CONTRACT convention:
    # row = inline index (increasing downward, row 0 = i0), column = crossline index
    mask = np.zeros(amp.shape, dtype=bool)
    for cell in f["cells"]:
        r0, r1 = synth.il_index(cell["il"][0]), synth.il_index(cell["il"][1])
        c0, c1 = synth.xl_index(cell["xl"][0]), synth.xl_index(cell["xl"][1])
        mask[r0:r1 + 1, c0:c1 + 1] = True
    r0, r1 = synth.il_index(f["il"][0]), synth.il_index(f["il"][1])
    c0, c1 = synth.xl_index(f["xl"][0]), synth.xl_index(f["xl"][1])
    box = np.zeros_like(mask)
    box[r0:r1 + 1, c0:c1 + 1] = True
    inside, outside = amp[mask].mean(), amp[box & ~mask].mean()
    assert inside > 0.6 * f["amp"] and outside < 0.3 * f["amp"], (inside, outside)

    # a mirrored / flipped / rotated image must NOT match (the F is asymmetric)
    sub, msub = amp[r0:r1 + 1, c0:c1 + 1], mask[r0:r1 + 1, c0:c1 + 1]

    def contrast(a):
        return a[msub].mean() - a[~msub].mean()
    good = contrast(sub)
    for wrong in (sub[::-1], sub[:, ::-1], sub[::-1, ::-1]):
        assert contrast(wrong) < 0.7 * good

    # geographic sense: stem at the HIGHEST crossline numbers (west), top bar at the HIGHEST inlines (north)
    assert sub[:, -3:].mean() > 0.6 * f["amp"]            # stem: all inlines, western-most crosslines
    assert sub[-2:, :].mean() > 0.6 * f["amp"]            # top bar: northern-most inlines, all crosslines
    assert sub[:2, :12].mean() < 0.3 * f["amp"]           # south-east corner of the box is empty
    # in a north-up, east-right map (flip both axes, because crosslines grow westward and rows grow
    # northward) the pattern reads as the documented upright F
    geo = sub[::-1, ::-1]
    rows = [geo[2 * r:2 * r + 2].reshape(2, 5, 6).mean(axis=(0, 2)) > 0.5 * f["amp"] for r in range(7)]
    text = ["".join("X" if v else "." for v in row) for row in rows]
    assert text == f["pattern_north_up_west_left"]
    assert m["xl_axis_m"][0] < 0 and m["il_axis_m"][1] > 0


def test_slice_window_and_time_snapping(live, synth):
    m = synth.meta
    q = "/api/slice?t=%g&fmt=png&i0=%d&i1=%d&x0=%d&x1=%d" % (
        m["t0_ms"] + 801.9, m["il0"] + 10 * m["il_step"] + 1, m["il0"] + 20 * m["il_step"],
        m["xl0"] + 100, m["xl0"] + 250)
    pix, info, _ = get_image(live, q)
    assert info["t"] == m["t0_ms"] + 800.0                         # snapped to the nearest sample
    # inline number il0+21 lies between two stored lines; ties snap upward (to index 11)
    assert (info["i0"], info["i1"]) == (m["il0"] + 11 * m["il_step"], m["il0"] + 20 * m["il_step"])
    assert (info["x0"], info["x1"]) == (m["xl0"] + 100, m["xl0"] + 250)
    assert (info["rows"], info["cols"]) == (10, 151)
    check_pixels(pix, info, np.asarray(synth.tix[200, 11:21, 100:251]))   # row 0 = i0
    pix, info, _ = get_image(live, "/api/slice?t=2000&fmt=png&w=64&h=64")
    fr, fc = dsp.block_factors(m["n_il"], m["n_xl"], 64, 64)
    assert (fr, fc) == (1, 5) and (info["rows"], info["cols"]) == (m["n_il"], -(-m["n_xl"] // 5))
    check_pixels(pix, info, dsp.block_mean(np.asarray(synth.tix[synth.t_index(2000.0)]), fr, fc))


@pytest.mark.parametrize("attr,extra", [
    ("amp", "&flo=10&fhi=40"), ("rms", ""), ("rms", "&flo=10&fhi=40&win_ms=200"),
    ("env", ""), ("env", "&fhi=35"), ("ifreq", ""), ("ifreq", "&flo=10&fhi=40"), ("sd", "&f0=25"),
])
def test_slice_attributes_match_dsp(live, synth, attr, extra):
    args = dict(p.split("=") for p in extra.strip("&").split("&")) if extra else {}
    flo = float(args["flo"]) if "flo" in args else None
    fhi = float(args["fhi"]) if "fhi" in args else None
    win = float(args.get("win_ms", 100.0))
    f0 = float(args.get("f0", 30.0))
    t_ms = synth.truth["channel"]["tau_ms"] + 20.0
    k = synth.t_index(t_ms)
    pix, info, _ = get_image(live, "/api/slice?t=%g&fmt=png&attr=%s%s" % (t_ms, attr, extra))
    exp, taps = dsp.slice_attribute(synth.tix, k, slice(None), slice(None), attr, synth.dt_s, flo, fhi, win, f0)
    assert info["taps"] == taps and info["attr"] == attr
    check_pixels(pix, info, exp)
    # ... and the slice shows the same numbers as a section through it
    i = 33
    sec, _ = dsp.section_attribute(np.asarray(synth.ixt[i]), attr, synth.dt_s, flo, fhi, win, f0)
    assert np.max(np.abs(decode(pix, info)[i] - np.clip(sec[:, k], 0 if attr != "amp" else -info["vmax"],
                                                         info["vmax"]))) <= quantum(info) + 1e-3 * info["vmax"]


def test_slice_and_section_agree_over_http(live, synth):
    m = synth.meta
    i, t_ms, vmax = 25, 2300.0, 3.0
    sl, _, _ = get_image(live, "/api/slice?t=%g&fmt=png&flo=10&fhi=40&vmax=%g" % (t_ms, vmax))
    sec, info, _ = get_image(live, "/api/section?kind=il&line=%d&fmt=png&flo=10&fhi=40&vmax=%g"
                             % (m["il0"] + i * m["il_step"], vmax))
    k = synth.t_index(t_ms)
    assert np.max(np.abs(sl[i].astype(int) - sec[k].astype(int))) <= 1
    xsec, _, _ = get_image(live, "/api/section?kind=xl&line=%d&fmt=png&flo=10&fhi=40&vmax=%g"
                           % (m["xl0"] + 140, vmax))
    assert np.max(np.abs(sl[:, 140].astype(int) - xsec[k].astype(int))) <= 1


def test_channel_is_bright_in_rms_map(live, synth):
    """Sanity of the synthetic content: the channel stands out in an RMS map around its horizon."""
    ch = synth.truth["channel"]
    pix, info, _ = get_image(live, "/api/slice?t=%g&fmt=png&attr=rms&win_ms=160" % (ch["tau_ms"] + 46.0))
    rms = decode(pix, info)
    n_il, n_xl = rms.shape
    west = 12.5 * np.arange(n_xl)
    north = 37.5 * np.arange(n_il)
    centre = 37.5 * (n_il // 2) + 0.2 * north[-1] * np.sin(2 * np.pi * west / 1500.0 + 0.6)
    on = np.abs(north[:, None] - centre[None, :]) < 60.0
    off = np.abs(north[:, None] - centre[None, :]) > 400.0
    assert rms[on].mean() > 2.0 * rms[off].mean()


# ------------------------------------------------------------------ spectrum
def test_spectrum_of_tone_block(live, synth):
    tb = synth.truth["tone_block"]
    base = "/api/spectrum?kind=il&line=%d&a0=%d&a1=%d" % (tb["il"][0], tb["xl"][0], tb["xl"][1])
    status, s = get_json(live, base)
    assert status == 200 and s["filtered"] is None
    f, raw = np.array(s["f_hz"]), np.array(s["raw"])
    assert s["n_traces"] == tb["xl"][1] - tb["xl"][0] + 1
    assert f[0] == 0.0 and f[-1] == pytest.approx(synth.meta["nyquist_hz"]) and len(f) == len(raw)
    assert raw.max() == pytest.approx(1.0) and abs(f[np.argmax(raw)] - tb["f_hz"]) <= 0.5
    assert raw[np.abs(f - tb["f_hz"]) > 5.0].max() < 0.01
    status, s = get_json(live, base + "&flo=50&fhi=90")            # tone is out of band
    assert status == 200 and max(s["filtered"]) < 0.05 and max(s["raw"]) == pytest.approx(1.0)
    status, s = get_json(live, base + "&flo=20&fhi=40&t0=1700&t1=3300")   # tone is in band
    fil = np.array(s["filtered"])
    assert abs(fil.max() - 1.0) < 0.05 and abs(np.array(s["f_hz"])[np.argmax(fil)] - tb["f_hz"]) <= 0.5


def test_spectrum_of_real_window(live, synth):
    m = synth.meta
    status, s = get_json(live, "/api/spectrum?kind=xl&line=%d&flo=30&fhi=60" % (m["xl0"] + 200))
    assert status == 200 and s["n_traces"] == m["n_il"]
    f, raw, fil = np.array(s["f_hz"]), np.array(s["raw"]), np.array(s["filtered"])
    assert raw.max() == pytest.approx(1.0)
    assert fil[(f < 22) | (f > 70)].max() < 0.05 * max(raw[(f < 22)].max(), 1e-9) + 0.02   # suppressed out of band
    inband = (f > 36) & (f < 54)
    assert np.allclose(fil[inband], raw[inband], rtol=0.06, atol=0.01)                 # untouched in band
    status, s = get_json(live, "/api/spectrum?kind=il&line=%d&a0=%d&a1=%d&t0=1800&t1=2400"
                         % (m["il0"], m["xl0"], m["xl0"] + 2000))
    assert status == 200 and s["n_traces"] == m["n_xl"] and s["filtered"] is None


# ------------------------------------------------------------------ errors
@pytest.mark.parametrize("path", [
    "/api/section",                                        # kind missing
    "/api/section?kind=zz&line=4175",
    "/api/section?kind=il",                                # line missing
    "/api/section?kind=il&line=abc",
    "/api/section?kind=il&line=4176",                      # not a stored inline (step 2)
    "/api/section?kind=il&line=4175.5",
    "/api/section?kind=il&line=4175&attr=phase",
    "/api/section?kind=il&line=4175&flo=40&fhi=10",
    "/api/section?kind=il&line=4175&flo=-3",
    "/api/section?kind=il&line=4175&flo=200",
    "/api/section?kind=il&line=4175&fhi=0",
    "/api/section?kind=il&line=4175&fhi=nan",
    "/api/section?kind=il&line=4175&vmax=0",
    "/api/section?kind=il&line=4175&vmax=-1",
    "/api/section?kind=il&line=4175&fmt=gif",
    "/api/section?kind=il&line=4175&w=wide",
    "/api/section?kind=il&line=4175&a0=x",
    "/api/section?kind=il&line=4175&t0=later",
    "/api/section?kind=il&line=4175&attr=sd&f0=0",
    "/api/section?kind=il&line=4175&attr=sd&f0=125",
    "/api/section?kind=il&line=4175&attr=sd&f0=3",         # window does not fit into 201 taps: 0 Hz leaks in
    "/api/section?kind=il&line=4175&attr=sd&f0=110",       # aliases through Nyquist
    "/api/section?kind=il&line=4175&vmax=1e-40",           # would overflow the float32 pixel coding
    "/api/section?kind=il&line=1e300",
    "/api/section?kind=il&line=4175&attr=rms&win_ms=long",
    "/api/slice",                                          # t missing
    "/api/slice?t=soon",
    "/api/slice?t=2000&attr=nope",
    "/api/slice?t=2000&i0=a",
    "/api/slice?t=2000&q=best",
    "/api/slice?t=inf",
    "/api/spectrum",
    "/api/spectrum?kind=il&line=4176",
    "/api/spectrum?kind=il&line=4175&flo=50&fhi=20",
    "/api/spectrum?kind=il&line=4175&t0=2000&t1=2000",
])
def test_bad_parameters_give_400_json(live, path):
    status, err = get_json(live, path)
    assert status == 400 and isinstance(err.get("error"), str) and err["error"], path


def test_lenient_parameters(live, synth):
    """Documented leniencies: blank values = absent, flo=0 / fhi>=Nyquist = no corner, reversed ranges swap."""
    m = synth.meta
    base = "/api/section?kind=il&line=%d&fmt=png" % m["il0"]
    ref = get_image(live, base)[0]
    for extra in ("&flo=&fhi=&a0=&t1=&vmax=", "&flo=0", "&fhi=125", "&flo=0&fhi=9999", "&unknown=1"):
        pix, info, _ = get_image(live, base + extra)
        assert np.array_equal(pix, ref) and info["flo"] is None and info["fhi"] is None, extra
    pix, info, _ = get_image(live, base + "&a0=%d&a1=%d&t0=2500&t1=2000" % (m["xl0"] + 50, m["xl0"] + 10))
    assert (info["a0"], info["a1"], info["t0"], info["t1"]) == (m["xl0"] + 10, m["xl0"] + 50, 2000.0, 2500.0)


def test_unknown_paths_and_methods(live):
    assert get_json(live, "/api/nope")[0] == 404
    assert get_json(live, "/api")[0] == 404
    assert http_get(live, "/missing.js")[0] == 404
    status, hdr, _ = http_get(live, "/api/health", method="POST")
    assert status == 405 and hdr["allow"] == "GET, HEAD"
    # HEAD = GET without the body (so "curl -I" works)
    status, hdr, body = http_get(live, "/api/health", method="HEAD")
    assert status == 200 and body == b"" and hdr["content-type"] == "application/json"
    assert int(hdr["content-length"]) == len(http_get(live, "/api/health")[2])
    status, hdr, body = http_get(live, "/", method="HEAD")
    assert status == 200 and body == b"" and int(hdr["content-length"]) > 0
    assert http_get(live, "/api/nope", method="HEAD")[0] == 404


# ------------------------------------------------------------------ static files
def test_static_files(live):
    status, hdr, body = http_get(live, "/")
    assert status == 200 and b"INDEX-MARKER" in body and hdr["content-type"].startswith("text/html")
    assert http_get(live, "/index.html")[2] == body
    status, hdr, body = http_get(live, "/app.js?v=3")
    assert status == 200 and b"APP-MARKER" in body and "javascript" in hdr["content-type"]
    status, hdr, gz = http_get(live, "/app.js", headers={"Accept-Encoding": "gzip, deflate"})
    assert hdr.get("content-encoding") == "gzip" and gzip.decompress(gz) == body
    status, hdr, body = http_get(live, "/style.css")
    assert status == 200 and hdr["content-type"].startswith("text/css")


def test_placeholder_without_web_folder(live_noweb):
    status, hdr, body = http_get(live_noweb, "/")
    assert status == 200 and b"seismic-viewer" in body and hdr["content-type"].startswith("text/html")
    assert http_get(live_noweb, "/app.js")[0] == 404
    assert get_json(live_noweb, "/api/health") == (200, {"ok": True})


@pytest.mark.parametrize("path", [
    "/../server.py", "/%2e%2e/server.py", "/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt",
    "/%2e%2e%2fsecret.txt", "/./../secret.txt", "/x/../../secret.txt", "/..\\secret.txt", "/%5c..%5csecret.txt",
    "//../secret.txt", "/../../../../../../etc/passwd", "/%2e%2e/%2e%2e/%2e%2e/%2e%2e/etc/passwd",
    "/link.txt", "/.hidden", "/index.html/../../secret.txt", "/%252e%252e/secret.txt", "/..",
    "/api/../../secret.txt", "/api/..%2f..%2fsecret.txt",
])
def test_path_traversal_does_not_leak(live, path):
    status, hdr, body = http_get(live, path)
    assert status in (400, 404), (path, status)
    assert b"TOP-SECRET" not in body and b"root:" not in body and b"import " not in body


def test_raw_socket_traversal(live):
    """Raw request line, exactly as an attacker would send it (no client-side normalisation)."""
    for target in ("/../server.py", "/%2e%2e/server.py", "/../secret.txt"):
        with socket.create_connection((live[0], live[1]), timeout=10) as s:
            s.sendall(("GET %s HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n" % target).encode())
            data = b""
            while True:
                chunk = s.recv(65536)
                if not chunk:
                    break
                data += chunk
        assert data.startswith(b"HTTP/1.1 404"), (target, data[:60])
        assert b"TOP-SECRET" not in data and b"ThreadingHTTPServer" not in data


# ------------------------------------------------------------------ process level
def test_bound_to_loopback_only(live):
    assert live[2].server_address[0] == "127.0.0.1"
    assert live[2].socket.getsockname()[0] == "127.0.0.1"


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _listeners(port):
    """Local addresses (hex, as in /proc/net/tcp*) that listen on ``port``."""
    out = []
    for fn in ("/proc/net/tcp", "/proc/net/tcp6"):
        if not os.path.exists(fn):
            continue
        with open(fn) as fh:
            for line in fh.readlines()[1:]:
                p = line.split()
                addr, prt = p[1].rsplit(":", 1)
                if p[3] == "0A" and int(prt, 16) == port:
                    out.append(addr)
    return out


@pytest.mark.parametrize("signame", ["SIGTERM", "SIGINT", "SIGHUP"])
def test_command_line_server_binds_loopback_and_stops_cleanly(synth, web_dir, signame):
    port = _free_port()
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, "server.py"), "--data", synth.dir,
                             "--port", str(port), "--web", web_dir],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd="/")
    try:
        deadline = time.time() + 30
        ok = False
        while time.time() < deadline and proc.poll() is None:
            try:
                ok = get_json(("127.0.0.1", port), "/api/health") == (200, {"ok": True})
                break
            except OSError:
                time.sleep(0.1)
        assert ok, "server did not start"
        if os.path.exists("/proc/net/tcp"):
            assert _listeners(port) == ["0100007F"]                # 127.0.0.1 and nothing else
        assert get_json(("127.0.0.1", port), "/api/meta")[1]["name"] == "SYNTHETIC TEST CUBE"
        proc.send_signal(getattr(signal, signame))
        assert proc.wait(timeout=10) == 0
        out = proc.stdout.read().decode()
        assert "listening on http://127.0.0.1:%d/" % port in out and "stopped" in out
        assert "/api/health" in out and " ms" in out               # one log line per request with timing
        with pytest.raises(OSError):
            socket.create_connection(("127.0.0.1", port), timeout=2).close()
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def test_api_under_page_prefix(live):
    """Inside Nature's Plug the page sits at /seismic/, so its relative api/... calls arrive with that prefix."""
    import json as _json
    import urllib.request as _rq
    host, port, _ = live
    for path in ("/seismic/api/health", "/api/health"):
        with _rq.urlopen("http://%s:%d%s" % (host, port, path), timeout=10) as r:
            assert _json.loads(r.read()) == {"ok": True}


def test_datasets_wells_and_track(live, synth):
    """The endpoints behind wells.js: cube list, wells file (empty without one) and the event follower."""
    import json as _json
    import urllib.request as _rq
    import numpy as _np
    host, port, httpd = live
    base = "http://%s:%d" % (host, port)
    with _rq.urlopen(base + "/api/datasets", timeout=10) as r:
        d = _json.loads(r.read())["datasets"]
    assert len(d) == 1 and d[0]["wells"] is False
    name = d[0]["id"]
    with _rq.urlopen(base + "/seismic/api/%s/wells" % name, timeout=10) as r:
        assert _json.loads(r.read()) == {"wells": [], "gc_sites": []}
    with _rq.urlopen(base + "/api/%s/pred" % name, timeout=10) as r:      # no prediction computed for the test cube
        assert _json.loads(r.read())["sections"] == []
    with _rq.urlopen(base + "/api/%s/meta" % name, timeout=10) as r:
        m = _json.loads(r.read())
    ds = httpd.RequestHandlerClass.engine.ds
    # seed on the strongest sample of the middle trace: the follower must return a grid of the cube's size
    # whose value at the seed is the seed time, in units of 0.25 ms
    i, j = ds.n_il // 2, ds.n_xl // 2
    k = int(_np.argmax(_np.abs(ds.ixt[i, j, :])))
    url = base + "/api/track?il=%d&xl=%d&t=%.1f" % (ds.line("il", i), ds.line("xl", j), ds.time(k))
    with _rq.urlopen(url, timeout=60) as r:
        info = _json.loads(r.headers["X-SV-Info"])
        grid = _np.frombuffer(r.read(), dtype="<i2").reshape(info["n_il"], info["n_xl"])
    assert grid.shape == (m["n_il"], m["n_xl"])
    assert info["polarity"] in ("peak", "trough") and info["picked"] >= 1
    assert abs(grid[i, j] * 0.25 - ds.time(info["seed_sample"])) <= ds.dt_ms / 2 + 0.25
    assert info["picked"] == int((grid != -32768).sum())
