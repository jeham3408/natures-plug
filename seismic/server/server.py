#!/usr/bin/env python
"""server.py - HTTP back end of seismic-viewer.

    python server.py [--data DIR] [--port 8777] [--web DIR]

Over ssh start it with a terminal (``ssh -t host python server.py``) so that
closing the session stops the server.  Without a terminal the server notices
on its own that the session is gone (its stdout / stderr pipe is closed) and
stops, so it never survives as an orphan that keeps the port.

Serves one dataset folder (cube_ixt.npy, cube_tix.npy, meta.json) on
127.0.0.1 only.  GET (and HEAD) only.  Endpoints:

    /api/health     {"ok": true}
    /api/meta       meta.json + "server" block
    /api/section    vertical section (inline or crossline) as 8-bit grey image
    /api/slice      time slice / map as 8-bit grey image
    /api/spectrum   mean amplitude spectrum of a section window (JSON)
    everything else static files from the web directory

Image responses carry the header X-SV-Info (compact JSON) describing the
actual window, scale (vmax) and coding.  Standard library + numpy + scipy +
Pillow only.

Colour scale.  Unfiltered amplitude uses meta.amp.p999.  Instantaneous
frequency uses fhi (or min(Nyquist, 100 Hz)).  Every other view (band-passed
amplitude, RMS, envelope, spectral decomposition) uses ONE scale per
parameter set: the 99.5th percentile of |attribute| over a fixed-seed sample
of whole traces of the cube.  It therefore does not depend on which inline,
crossline, time, zoom window or image size is shown, so the three panels and
all positions can be compared.  (An earlier version scaled every image by its
own 99.5th percentile, which changed the scale up to 7x between time slices.)
"""
from __future__ import annotations

import argparse
import collections
import concurrent.futures
import errno
import gzip
import io
import json
import math
import mimetypes
import os
import select
import signal
import socket
import sys
import threading
import time
import traceback
import urllib.parse
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from PIL import Image

import dsp
import track as tracker

VERSION = "1.0.0"
HOST = "127.0.0.1"                 # never bind to anything else
HERE = os.path.dirname(os.path.abspath(__file__))
SPECTRUM_MAX_TRACES = 600
SPECTRUM_MIN_NFFT = 512
SCALE_SAMPLE_TRACES = 2000         # traces of the fixed-seed sample behind the default colour scales
VMAX_FLOOR = 1e-30                 # smaller vmax values overflow float32 in the pixel coding

PLACEHOLDER = (b"<!doctype html><html><head><meta charset=\"utf-8\"><title>seismic-viewer</title></head>"
               b"<body><h1>seismic-viewer back end is running</h1><p>The web front end (web/index.html) "
               b"is not installed yet. API: <a href=\"/api/meta\">/api/meta</a>, "
               b"<a href=\"/api/health\">/api/health</a>.</p></body></html>")


class BadRequest(Exception):
    """Invalid request parameter -> HTTP 400 with a JSON error."""


class ClientGone(Exception):
    """The client closed the connection while its request was queued or being computed."""


# --------------------------------------------------------------------------
# small thread-safe LRU caches
# --------------------------------------------------------------------------
class LRU:
    """LRU cache limited by entry count and by total size in bytes."""

    def __init__(self, max_items, max_bytes):
        self.max_items, self.max_bytes = int(max_items), int(max_bytes)
        self._d = collections.OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()

    def get(self, key):
        with self._lock:
            hit = self._d.get(key)
            if hit is None:
                return None
            self._d.move_to_end(key)
            return hit[0]

    def put(self, key, value, nbytes):
        nbytes = int(nbytes)
        if nbytes > self.max_bytes:
            return
        with self._lock:
            old = self._d.pop(key, None)
            if old is not None:
                self._bytes -= old[1]
            self._d[key] = (value, nbytes)
            self._bytes += nbytes
            while len(self._d) > self.max_items or self._bytes > self.max_bytes:
                _, (_, nb) = self._d.popitem(last=False)
                self._bytes -= nb

    def __len__(self):
        return len(self._d)


# --------------------------------------------------------------------------
# dataset
# --------------------------------------------------------------------------
class Dataset:
    """A dataset folder opened read-only with memory-mapped cubes."""

    def __init__(self, data_dir):
        self.dir = os.path.abspath(data_dir)
        with open(os.path.join(self.dir, "meta.json")) as fh:
            self.meta = json.load(fh)
        m = self.meta
        self.n_il, self.n_xl, self.n_t = int(m["n_il"]), int(m["n_xl"]), int(m["n_t"])
        self.il0, self.il_step = int(m["il0"]), int(m["il_step"])
        self.xl0, self.xl_step = int(m["xl0"]), int(m["xl_step"])
        self.t0_ms, self.dt_ms = float(m["t0_ms"]), float(m["dt_ms"])
        self.dt_s = self.dt_ms / 1000.0
        self.nyquist = 500.0 / self.dt_ms
        self.ixt = np.load(os.path.join(self.dir, "cube_ixt.npy"), mmap_mode="r")
        self.tix = np.load(os.path.join(self.dir, "cube_tix.npy"), mmap_mode="r")
        if self.ixt.shape != (self.n_il, self.n_xl, self.n_t):
            raise SystemExit("cube_ixt.npy has shape %s, meta.json says %s"
                             % (self.ixt.shape, (self.n_il, self.n_xl, self.n_t)))
        if self.tix.shape != (self.n_t, self.n_il, self.n_xl):
            raise SystemExit("cube_tix.npy has shape %s, meta.json says %s"
                             % (self.tix.shape, (self.n_t, self.n_il, self.n_xl)))
        for name, a in (("cube_ixt.npy", self.ixt), ("cube_tix.npy", self.tix)):
            if a.dtype != np.dtype("<f4"):
                raise SystemExit("%s must be little-endian float32, found %s" % (name, a.dtype))
        # plain file descriptor for parallel positional reads of scattered traces (crossline sections)
        self.ixt_fd = os.open(os.path.join(self.dir, "cube_ixt.npy"), os.O_RDONLY)
        self.ixt_offset = int(self.ixt.offset)
        self.p999 = float(m["amp"]["p999"])
        if not (math.isfinite(self.p999) and self.p999 > 0):
            self.p999 = 1.0

    # axis helpers: kind "il" -> the inline axis, "xl" -> the crossline axis
    def axis(self, which):
        if which == "il":
            return self.il0, self.il_step, self.n_il
        return self.xl0, self.xl_step, self.n_xl

    def exact_index(self, which, line):
        """Index of an existing stored line number, else BadRequest."""
        l0, st, n = self.axis(which)
        if abs(line - round(line)) > 1e-9:
            raise BadRequest("line must be an integer line number")
        d = int(round(line)) - l0
        if d % st != 0 or not 0 <= d // st < n:
            raise BadRequest("%s %.12g does not exist (lines %d..%d step %d)"
                             % ("inline" if which == "il" else "crossline", line,
                                l0, l0 + (n - 1) * st, st))
        return d // st

    def snap_index(self, which, line):
        """Index of the stored line nearest to ``line`` (clamped to the cube)."""
        l0, st, n = self.axis(which)
        return int(min(max(math.floor((line - l0) / st + 0.5), 0), n - 1))

    def snap_time(self, t_ms):
        """Index of the sample nearest to t_ms (clamped)."""
        return int(min(max(math.floor((t_ms - self.t0_ms) / self.dt_ms + 0.5), 0), self.n_t - 1))

    def line(self, which, idx):
        l0, st, _ = self.axis(which)
        return l0 + idx * st

    def time(self, k):
        return self.t0_ms + k * self.dt_ms


# --------------------------------------------------------------------------
# parameter parsing
# --------------------------------------------------------------------------
def _get(q, name):
    v = q.get(name)
    if not v:
        return None
    s = v[-1].strip()
    return s if s != "" else None


def _num(q, name, default=None, required=False):
    s = _get(q, name)
    if s is None:
        if required:
            raise BadRequest("missing parameter %r" % name)
        return default
    try:
        v = float(s)
    except ValueError:
        raise BadRequest("parameter %r must be a number" % name) from None
    if not math.isfinite(v):
        raise BadRequest("parameter %r must be finite" % name)
    return v


def _range(ds, which, q, n0, n1):
    """Index range [a, b] (inclusive) from two optional line-number parameters."""
    _, _, n = ds.axis(which)
    v0, v1 = _num(q, n0), _num(q, n1)
    a = 0 if v0 is None else ds.snap_index(which, v0)
    b = n - 1 if v1 is None else ds.snap_index(which, v1)
    return (a, b) if a <= b else (b, a)


def _time_range(ds, q):
    v0, v1 = _num(q, "t0"), _num(q, "t1")
    a = 0 if v0 is None else ds.snap_time(v0)
    b = ds.n_t - 1 if v1 is None else ds.snap_time(v1)
    return (a, b) if a <= b else (b, a)


def _kind(q):
    kind = _get(q, "kind")
    if kind not in ("il", "xl"):
        raise BadRequest("parameter 'kind' must be 'il' or 'xl'")
    return kind


def _band(ds, q):
    try:
        return dsp.normalise_band(_num(q, "flo"), _num(q, "fhi"), ds.dt_s)
    except ValueError as e:
        raise BadRequest(str(e)) from None


def _common(ds, q):
    """Parameters shared by /api/section and /api/slice."""
    attr = _get(q, "attr") or "amp"
    if attr not in dsp.ATTRS:
        raise BadRequest("parameter 'attr' must be one of %s" % ", ".join(dsp.ATTRS))
    flo, fhi = _band(ds, q)
    win_ms = dsp.clamp_win_ms(_num(q, "win_ms", 100.0), ds.dt_ms)
    n_win = dsp.rms_length(win_ms, ds.dt_ms)
    f0 = _num(q, "f0", 30.0)
    if attr == "sd":
        flo = fhi = None                               # band-pass is ignored for sd
        f_min, f_max = dsp.sd_f0_range(ds.dt_s)
        if not f_min <= f0 <= f_max:
            raise BadRequest("parameter 'f0' must be between %g and %g Hz (below, the %d-tap window is too "
                             "short and 0 Hz leaks in; above, the result aliases through Nyquist)"
                             % (f_min, f_max, dsp.MAX_TAPS))
    w = int(min(max(_num(q, "w", 1600), 64), 4096))
    h = int(min(max(_num(q, "h", 900), 64), 4096))
    fmt = (_get(q, "fmt") or "jpg").lower()
    if fmt == "jpeg":
        fmt = "jpg"
    if fmt not in ("jpg", "png"):
        raise BadRequest("parameter 'fmt' must be 'jpg' or 'png'")
    quality = int(min(max(_num(q, "q", 85), 40), 95))
    vmax = _num(q, "vmax")
    if vmax is not None and not vmax >= VMAX_FLOOR:
        raise BadRequest("parameter 'vmax' must be positive (at least %g)" % VMAX_FLOOR)
    return {"attr": attr, "flo": flo, "fhi": fhi, "n_win": n_win, "f0": float(f0),
            "w": w, "h": h, "fmt": fmt, "q": quality, "vmax": vmax}


# --------------------------------------------------------------------------
# rendering engine
# --------------------------------------------------------------------------
class Engine:
    """Turns validated requests into encoded images / JSON, with caching."""

    def __init__(self, ds, cache_items=256):
        self.ds = ds
        self.responses = LRU(cache_items, 256 * 1024 * 1024)     # encoded images
        self.arrays = LRU(24, 256 * 1024 * 1024)                 # float images before 8-bit coding
        self._heavy = threading.BoundedSemaphore(2)              # bounds memory of attribute slices
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=8, thread_name_prefix="sv-read")
        self._scale_lock = threading.Lock()
        self._scale_sample = None                                # fixed-seed sample of whole traces
        self._scales = collections.OrderedDict()                 # parameter set -> default vmax
        self.abandoned = 0                                       # requests dropped because the client left
        self._track_lock = threading.Lock()
        self._tracks = collections.OrderedDict()                 # seed -> (grid bytes, info) of followed events

    # ---- default colour scale ----------------------------------------------
    def scale_sample(self):
        """Fixed-seed random sample of whole traces (n, n_t) float32, read once."""
        if self._scale_sample is None:
            self._scale_sample = dsp.clean(dsp.sample_traces(self.ds.ixt, SCALE_SAMPLE_TRACES, seed=0))
        return self._scale_sample

    def default_vmax(self, attr, flo, fhi, n_win, f0):
        """Default vmax of a view: one constant per parameter set (see the module docstring)."""
        ds = self.ds
        if attr == "amp" and flo is None and fhi is None:
            return ds.p999
        if attr == "ifreq":
            return float(fhi) if fhi is not None else min(ds.nyquist, 100.0)
        key = (attr, flo, fhi, n_win if attr == "rms" else None, f0 if attr == "sd" else None)
        with self._scale_lock:
            v = self._scales.get(key)
            if v is None:
                y, _ = dsp.section_attribute(self.scale_sample(), attr, ds.dt_s, flo, fhi,
                                             n_win * ds.dt_ms, f0)
                v = self._scales[key] = dsp.robust_vmax(y, 99.5)
                while len(self._scales) > 512:
                    self._scales.popitem(last=False)
            return v

    # ---- data access -------------------------------------------------------
    def section_traces(self, kind, idx, a, b):
        """Traces of one section as (n_traces, n_t) float32 (full time range)."""
        ds = self.ds
        if kind == "il":
            return dsp.clean(np.array(ds.ixt[idx, a:b + 1, :], dtype=np.float32))
        # a crossline section is one trace per inline, n_xl traces apart in the file: when the file is not
        # in the page cache these are random reads, so issue them in parallel (about 8x faster on an SSD)
        n, nbytes = b - a + 1, ds.n_t * 4
        out = np.empty((n, ds.n_t), dtype=np.float32)

        def read(i):
            buf = os.pread(ds.ixt_fd, nbytes, ds.ixt_offset + ((a + i) * ds.n_xl + idx) * nbytes)
            if len(buf) != nbytes:
                raise IOError("short read from cube_ixt.npy")
            out[i] = np.frombuffer(buf, dtype="<f4")
        list(self.pool.map(read, range(n)))
        return dsp.clean(out)

    # ---- image endpoints ---------------------------------------------------
    def image(self, endpoint, q, gone=None):
        """Returns (body bytes, content type, info dict).

        ``gone`` is an optional callable that tells whether the client has
        closed the connection; a queued or running attribute computation is
        then abandoned with :class:`ClientGone` instead of being finished.
        """
        try:
            return self._image(endpoint, q, gone)
        except ClientGone:
            self.abandoned += 1
            raise

    def _image(self, endpoint, q, gone):
        t_start = time.perf_counter()
        queued = 0.0
        ds = self.ds
        c = _common(ds, q)
        attr, flo, fhi = c["attr"], c["flo"], c["fhi"]
        if endpoint == "section":
            kind = _kind(q)
            idx = ds.exact_index(kind, _num(q, "line", required=True))
            cross = "xl" if kind == "il" else "il"
            a, b = _range(ds, cross, q, "a0", "a1")
            ta, tb = _time_range(ds, q)
            src_rows, src_cols = tb - ta + 1, b - a + 1
            where = (kind, idx, a, b, ta, tb)
        else:
            k = ds.snap_time(_num(q, "t", required=True))
            ia, ib = _range(ds, "il", q, "i0", "i1")
            xa, xb = _range(ds, "xl", q, "x0", "x1")
            src_rows, src_cols = ib - ia + 1, xb - xa + 1
            where = (k, ia, ib, xa, xb)
        fr, fc = dsp.block_factors(src_rows, src_cols, c["h"], c["w"])
        data_key = (endpoint, where, attr, flo, fhi,
                    c["n_win"] if attr == "rms" else None,
                    c["f0"] if attr == "sd" else None, fr, fc)
        resp_key = (data_key, c["vmax"], c["fmt"], c["q"] if c["fmt"] == "jpg" else None)

        hit = self.responses.get(resp_key)
        if hit is not None:
            body, ctype, info = hit
            info = dict(info, ms=round((time.perf_counter() - t_start) * 1000.0, 2), queued_ms=0.0, cached=True)
            return body, ctype, info

        got = self.arrays.get(data_key)
        if got is None:
            heavy = not (attr == "amp" and flo is None and fhi is None)
            if heavy:                                    # wait for a slot, but not for a client that has left
                while not self._heavy.acquire(timeout=0.05):
                    if gone is not None and gone():
                        raise ClientGone()
                queued = time.perf_counter() - t_start
            try:
                if heavy and gone is not None and gone():
                    raise ClientGone()
                if endpoint == "section":
                    x = self.section_traces(kind, idx, a, b)
                    y, taps = dsp.section_attribute(x, attr, ds.dt_s, flo, fhi,
                                                    c["n_win"] * ds.dt_ms, c["f0"])
                    img = y[:, ta:tb + 1].T                      # rows = time, cols = crossing line
                else:
                    img, taps = dsp.slice_attribute(ds.tix, k, slice(ia, ib + 1), slice(xa, xb + 1),
                                                    attr, ds.dt_s, flo, fhi,
                                                    c["n_win"] * ds.dt_ms, c["f0"], should_stop=gone)
                img = np.ascontiguousarray(dsp.block_mean(img, fr, fc))
            except dsp.Cancelled:
                raise ClientGone() from None
            finally:
                if heavy:
                    self._heavy.release()
            img.setflags(write=False)
            self.arrays.put(data_key, (img, taps), img.nbytes)
        else:
            img, taps = got

        signed = attr in dsp.SIGNED_ATTRS
        if c["vmax"] is not None:
            vmax = float(c["vmax"])
        else:
            vmax = self.default_vmax(attr, flo, fhi, c["n_win"], c["f0"])
        kern = dsp.attribute_kernel(attr, ds.dt_s, flo, fhi, c["f0"])
        band6 = None if kern is None else [round(v, 2) for v in dsp.response_band(kern, ds.dt_s)]
        pix = dsp.encode_signed(img, vmax) if signed else dsp.encode_unsigned(img, vmax)
        buf = io.BytesIO()
        if c["fmt"] == "png":
            Image.fromarray(pix).save(buf, "PNG", compress_level=3)
            ctype = "image/png"
        else:
            Image.fromarray(pix).save(buf, "JPEG", quality=c["q"])
            ctype = "image/jpeg"
        body = buf.getvalue()

        info = {"endpoint": endpoint, "attr": attr, "signed": signed,
                "unit": "Hz" if attr == "ifreq" else "amplitude", "vmax": vmax,
                "rows": int(pix.shape[0]), "cols": int(pix.shape[1]),
                "src_rows": int(src_rows), "src_cols": int(src_cols)}
        if endpoint == "section":
            info.update({"kind": kind, "line": ds.line(kind, idx),
                         "a0": ds.line(cross, a), "a1": ds.line(cross, b),
                         "t0": ds.time(ta), "t1": ds.time(tb)})
        else:
            info.update({"t": ds.time(k), "i0": ds.line("il", ia), "i1": ds.line("il", ib),
                         "x0": ds.line("xl", xa), "x1": ds.line("xl", xb)})
        info.update({"flo": flo, "fhi": fhi, "win_ms": c["n_win"] * ds.dt_ms, "f0": c["f0"],
                     "taps": int(taps), "band6": band6, "ms": 0.0, "queued_ms": 0.0, "cached": False})
        self.responses.put(resp_key, (body, ctype, info), len(body) + 512)
        # "ms" is compute time only; time spent waiting for a free slot is reported separately
        info = dict(info, ms=round((time.perf_counter() - t_start - queued) * 1000.0, 2),
                    queued_ms=round(queued * 1000.0, 2))
        return body, ctype, info

    # ---- spectrum ----------------------------------------------------------
    def spectrum(self, q):
        ds = self.ds
        kind = _kind(q)
        idx = ds.exact_index(kind, _num(q, "line", required=True))
        cross = "xl" if kind == "il" else "il"
        a, b = _range(ds, cross, q, "a0", "a1")
        ta, tb = _time_range(ds, q)
        flo, fhi = _band(ds, q)
        if tb - ta + 1 < 2:
            raise BadRequest("the time window must hold at least 2 samples")
        key = ("spectrum", kind, idx, a, b, ta, tb, flo, fhi)
        hit = self.responses.get(key)
        if hit is not None:
            return hit
        pick = a + dsp.pick_evenly(b - a + 1, SPECTRUM_MAX_TRACES)
        if kind == "il":
            x = np.array(ds.ixt[idx, pick, :], dtype=np.float32)
        else:
            x = self.section_traces(kind, idx, a, b)[pick - a]
        n = tb - ta + 1
        nfft = max(n, SPECTRUM_MIN_NFFT)
        f, raw = dsp.mean_amplitude_spectrum(x[:, ta:tb + 1], ds.dt_s, nfft)
        scale = float(raw.max())
        scale = 1.0 / scale if scale > 0 else 1.0
        filtered = None
        if flo is not None or fhi is not None:
            y = dsp.bandpass(x, flo, fhi, ds.dt_s)               # full trace, then crop (as in images)
            _, fs = dsp.mean_amplitude_spectrum(y[:, ta:tb + 1], ds.dt_s, nfft)
            filtered = [round(float(v) * scale, 5) for v in fs]
        out = {"f_hz": [round(float(v), 4) for v in f],
               "raw": [round(float(v) * scale, 5) for v in raw],
               "filtered": filtered, "n_traces": int(x.shape[0])}
        self.responses.put(key, out, 24 * len(out["f_hz"]) * 3)
        return out

    def track(self, q):
        """Follow the event nearest to (il, xl, t) through the cube -> (int16 little-endian grid of two-way time in
        units of 0.25 ms, -32768 = no pick, row = inline; info)."""
        ds = self.ds
        il, xl, t = _num(q, "il", required=True), _num(q, "xl", required=True), _num(q, "t", required=True)
        max_lag = int(min(max(_num(q, "lag", 2), 1), 6))
        i0, j0, k0 = ds.snap_index("il", il), ds.snap_index("xl", xl), ds.snap_time(t)
        key = (i0, j0, k0, max_lag)
        with self._track_lock:
            hit = self._tracks.get(key)
        t_start = time.perf_counter()
        if hit is None:
            try:
                picks, info = tracker.track(ds.ixt, i0, j0, k0, max_lag=max_lag)
            except ValueError as e:
                raise BadRequest(str(e))
            twt = ds.t0_ms + picks * ds.dt_ms
            grid = np.where(np.isfinite(twt), np.clip(np.round(twt * 4.0), -32767, 32767), -32768).astype("<i2")
            info.update(n_il=ds.n_il, n_xl=ds.n_xl, unit_ms=0.25, nodata=-32768,
                        seed_il=ds.line("il", i0), seed_xl=ds.line("xl", j0), seed_twt=ds.time(info["seed_sample"]))
            hit = (grid.tobytes(), info)
            with self._track_lock:
                if len(self._tracks) >= 12:
                    self._tracks.pop(next(iter(self._tracks)))
                self._tracks[key] = hit
            cached = False
        else:
            cached = True
        info = dict(hit[1], cached=cached, ms=round((time.perf_counter() - t_start) * 1000.0, 1))
        return hit[0], info

    def meta(self):
        out = dict(self.ds.meta)
        f_min, f_max = dsp.sd_f0_range(self.ds.dt_s)
        out["server"] = {"version": VERSION, "attrs": list(dsp.ATTRS), "max_taps": dsp.MAX_TAPS,
                         "f0_min": f_min, "f0_max": f_max}
        return out


# --------------------------------------------------------------------------
# HTTP layer
# --------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    disable_nagle_algorithm = True
    server_version = "seismic-viewer/" + VERSION
    timeout = 120

    # set by make_server
    engine = None
    engines = {}
    web_root = None
    quiet = False

    # ---- helpers -----------------------------------------------------------
    def handle(self):
        try:
            super().handle()
        except (ConnectionError, TimeoutError):      # the client reset the connection: nothing to report
            self.close_connection = True

    def _accepts_gzip(self):
        for part in (self.headers.get("Accept-Encoding") or "").lower().split(","):
            name, _, params = part.strip().partition(";")
            if name.strip() not in ("gzip", "x-gzip", "*"):
                continue
            qv = 1.0
            for prm in params.split(";"):
                k, _, v = prm.strip().partition("=")
                if k.strip() == "q":
                    try:
                        qv = float(v)
                    except ValueError:
                        qv = 0.0
            if name.strip() != "*" or qv > 0:
                return qv > 0
        return False

    def _send(self, status, body, ctype, extra=None, compress=False):
        headers = [("Content-Type", ctype), ("Cache-Control", "no-store"),
                   ("X-Content-Type-Options", "nosniff")]
        if compress and len(body) > 512 and self._accepts_gzip():
            body = gzip.compress(body, compresslevel=5)
            headers += [("Content-Encoding", "gzip"), ("Vary", "Accept-Encoding")]
        headers.append(("Content-Length", str(len(body))))
        if extra:
            headers += extra
        if self.close_connection:
            headers.append(("Connection", "close"))
        if self.command == "HEAD":                   # same headers as GET (including the length), no body
            body = b""
        self._status, self._bytes = status, len(body)
        # status line, headers and body go out in ONE write: no Nagle / delayed-ACK stall (40 ms) per request
        head = ["HTTP/1.1 %d %s" % (status, HTTPStatus(status).phrase),
                "Server: " + self.version_string(), "Date: " + self.date_time_string()]
        head += ["%s: %s" % kv for kv in headers]
        self.wfile.write(("\r\n".join(head) + "\r\n\r\n").encode("latin-1") + body)
        self.wfile.flush()

    def _json(self, status, obj, extra=None):
        body = json.dumps(obj, separators=(",", ":")).encode("ascii")
        self._send(status, body, "application/json", extra=extra, compress=True)

    def _stderr(self, text):
        """Write a log line; a dead stderr (closed ssh session) stops the server instead of killing the thread."""
        try:
            sys.stderr.write(text)
            sys.stderr.flush()
        except (OSError, ValueError):
            stop = getattr(self.server, "stop_event", None)
            if stop is not None:
                stop.set()

    def log_message(self, fmt, *args):          # default access log replaced by _log
        if not self.quiet:
            self._stderr("%s %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def _log(self, t_start, note=""):
        if self.quiet:
            return
        self._stderr("%s %s %s -> %s %d B %.1f ms%s\n" % (
            time.strftime("%H:%M:%S"), self.command, self.path, getattr(self, "_status", "-"),
            getattr(self, "_bytes", 0), (time.perf_counter() - t_start) * 1000.0, note))

    def _client_gone(self):
        """True when the peer has closed the connection (FIN or RST) while we are still working."""
        try:
            readable, _, _ = select.select([self.connection], [], [], 0)
            if not readable:
                return False
            return self.connection.recv(1, socket.MSG_PEEK) == b""
        except (OSError, ValueError):
            return True

    # ---- methods -----------------------------------------------------------
    def do_GET(self):
        t_start = time.perf_counter()
        self._status, self._bytes, note = "-", 0, ""
        try:
            u = urllib.parse.urlsplit(self.path)
            # The API answers under any prefix, so the page also works as /seismic/ inside Nature's Plug
            # (its relative "api/meta" then arrives as /seismic/api/meta).
            i = (u.path + "/").find("/api/")
            if i >= 0:
                # /api/<dataset>/... picks one of the cubes; without a dataset name the first one answers
                sub, eng = u.path[i:], self.engine
                segs = sub.split("/")
                if len(segs) >= 3 and segs[2] in self.engines:
                    eng, sub = self.engines[segs[2]], "/api/" + "/".join(segs[3:])
                note = self._api(sub.rstrip("/") if sub != "/api/" else "/api", urllib.parse.parse_qs(u.query, keep_blank_values=True), eng)
            else:
                self._static(u.path)
        except BadRequest as e:
            try:
                self._json(400, {"error": str(e)})
            except OSError:
                self.close_connection = True
        except ClientGone:
            self.close_connection = True
            note = " [abandoned: client closed the connection]"
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except Exception:                        # never leak a traceback to the client
            try:
                traceback.print_exc()
            except OSError:
                pass
            try:
                self._json(500, {"error": "internal server error"})
            except Exception:
                self.close_connection = True
        self._log(t_start, note or "")

    do_HEAD = do_GET                             # _send drops the body for HEAD

    def _not_allowed(self):
        t_start = time.perf_counter()
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = -1
        if 0 < n <= 1 << 20:
            self.rfile.read(n)
        elif n:                                  # huge, negative or unreadable length: do not try to skip a body
            self.close_connection = True
        try:
            self._json(405, {"error": "only GET is supported"}, extra=[("Allow", "GET, HEAD")])
        except OSError:
            self.close_connection = True
        self._log(t_start)

    do_POST = do_PUT = do_DELETE = do_PATCH = do_OPTIONS = _not_allowed

    # ---- API ---------------------------------------------------------------
    def _api(self, path, q, eng=None):
        eng = eng or self.engine
        if path == "/api/health":
            self._json(200, {"ok": True})
        elif path == "/api/datasets":
            self._json(200, {"datasets": [{"id": k, "name": e.ds.meta.get("name"), "wells": os.path.isfile(os.path.join(e.ds.dir, "wells.json"))}
                                          for k, e in self.engines.items()]})
        elif path == "/api/wells":
            p = os.path.join(eng.ds.dir, "wells.json")
            if not os.path.isfile(p):
                self._json(200, {"wells": [], "gc_sites": []})
            else:
                with open(p, "rb") as fh:
                    self._send(200, fh.read(), "application/json", compress=True)
        elif path == "/api/pred":                                    # logs predicted from seismic (predict_logs.py)
            p = os.path.join(eng.ds.dir, "pred.json")
            if not os.path.isfile(p):
                self._json(200, {"sections": [], "sets": [], "props": [], "table": []})
            else:
                with open(p, "rb") as fh:
                    self._send(200, fh.read(), "application/json", compress=True)
        elif path == "/api/track":
            body, info = eng.track(q)
            self._send(200, body, "application/octet-stream", compress=True, extra=[
                ("Access-Control-Expose-Headers", "X-SV-Info"),
                ("X-SV-Info", json.dumps(info, separators=(",", ":")))])
            return " [track %s %.0f ms%s]" % (info["polarity"], info["ms"], " cached" if info["cached"] else "")
        elif path == "/api/meta":
            self._json(200, eng.meta())
        elif path in ("/api/section", "/api/slice"):
            body, ctype, info = eng.image(path[5:], q, gone=self._client_gone)
            self._send(200, body, ctype, extra=[
                ("Access-Control-Expose-Headers", "X-SV-Info"),
                ("X-SV-Info", json.dumps(info, separators=(",", ":")))])
            return " [%s %.1f ms%s%s]" % (info["attr"], info["ms"], " cached" if info["cached"] else "",
                                         " + %.0f ms queued" % info["queued_ms"] if info["queued_ms"] >= 1 else "")
        elif path == "/api/spectrum":
            self._json(200, eng.spectrum(q))
        else:
            self._json(404, {"error": "unknown API path"})
        return ""

    # ---- static files ------------------------------------------------------
    def _static(self, raw_path):
        root = self.web_root
        path = urllib.parse.unquote(raw_path)
        parts = [p for p in path.split("/") if p not in ("", ".")]
        bad = ("\x00" in path or "\\" in path or
               any(p == ".." or p.startswith(".") for p in parts))
        full = None
        if not bad and root and os.path.isdir(root):
            real_root = os.path.realpath(root)
            cand = os.path.realpath(os.path.join(real_root, *parts)) if parts else real_root
            if cand == real_root or cand.startswith(real_root + os.sep):
                if os.path.isdir(cand):
                    cand = os.path.join(cand, "index.html")
                if os.path.isfile(cand):
                    full = cand
        if full is None:
            if not bad and not parts:            # "/" without a front end yet
                self._send(200, PLACEHOLDER, "text/html; charset=utf-8")
            else:
                self._json(404, {"error": "not found"})
            return
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        text = ctype.startswith("text/") or ctype in ("application/javascript", "application/json",
                                                      "image/svg+xml")
        if text and "charset" not in ctype:
            ctype += "; charset=utf-8"
        with open(full, "rb") as fh:
            body = fh.read()
        self._send(200, body, ctype, compress=text)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64
    stop_event = None                  # set by main(): lets a handler ask for a shutdown


def _hangup_watch():
    """Callable that tells whether stdout or stderr has lost its reader, or None if that cannot be watched.

    A server started as ``ssh host python server.py`` (no terminal) gets no SIGHUP when the ssh session
    dies; its stdout / stderr are pipes whose read end disappears, which poll() reports as POLLERR.
    Regular files and /dev/null never report it, so ``nohup python server.py > log 2>&1 &`` keeps running.
    """
    if not hasattr(select, "poll"):
        return None
    fds = []
    for stream in (sys.stdout, sys.stderr):
        try:
            fds.append(stream.fileno())
        except (AttributeError, OSError, ValueError):
            pass
    if not fds:
        return None
    poller = select.poll()
    for fd in set(fds):
        try:
            poller.register(fd, 0)               # no events requested: only POLLERR / POLLHUP / POLLNVAL
        except (OSError, ValueError):
            pass

    def lost():
        try:
            return any(ev & (select.POLLERR | select.POLLHUP) for _, ev in poller.poll(0))
        except (OSError, ValueError):
            return False
    return lost


def default_data_dir():
    adele = os.path.join(HERE, "data", "adele")
    if os.path.isfile(os.path.join(adele, "meta.json")):
        return adele
    return os.path.join(HERE, "data", "synthetic")


def make_server(data_dir=None, port=8777, web_dir=None, quiet=False):
    """Create (not start) the HTTP server bound to 127.0.0.1:port (0 = free port)."""
    # data_dir: one folder, or a list of folders / "name=folder" entries (the first one is the default cube)
    entries = data_dir if isinstance(data_dir, (list, tuple)) else [data_dir or default_data_dir()]
    engines = collections.OrderedDict()
    for e in entries:
        name, _, path = str(e).rpartition("=")
        if not name:
            name = os.path.basename(os.path.normpath(path)) or "cube"
        engines[name] = Engine(Dataset(path))
    handler = type("BoundHandler", (Handler,), {
        "engine": next(iter(engines.values())),
        "engines": engines,
        "web_root": os.path.abspath(web_dir or os.path.join(HERE, "..", "..")),   # the whole Nature's Plug app
        "quiet": quiet,
    })
    return Server((HOST, int(port)), handler)


def main(argv=None):
    ap = argparse.ArgumentParser(description="seismic-viewer back end (listens on 127.0.0.1 only)")
    ap.add_argument("--data", default=None, nargs="+",
                    help="one or more dataset folders, optionally as name=folder; the first is the default cube "
                         "(default: data/adele if it has meta.json, else data/synthetic)")
    ap.add_argument("--port", type=int, default=8777)
    ap.add_argument("--web", default=None, help="folder to serve as the web site (default: the Nature's Plug app two levels up; the viewer is its seismic/ page)")
    ap.add_argument("--quiet", action="store_true", help="no request log")
    a = ap.parse_args(argv)
    data_dir = a.data or [default_data_dir()]
    for e in data_dir:
        d = str(e).rpartition("=")[2]
        if not os.path.isfile(os.path.join(d, "meta.json")):
            raise SystemExit("no dataset in %s (run make_synthetic.py or prep.py first)" % d)
    try:
        httpd = make_server(data_dir, a.port, a.web, a.quiet)
    except OSError as e:
        if e.errno != errno.EADDRINUSE:
            raise
        raise SystemExit("port %d on %s is already in use, probably by an earlier seismic-viewer "
                         "(find it with: pgrep -af server.py); stop that one or choose another --port"
                         % (a.port, HOST)) from None
    ds = httpd.RequestHandlerClass.engine.ds
    stop = httpd.stop_event = threading.Event()

    def on_signal(signum, _frame):
        stop.set()

    for name in ("SIGINT", "SIGTERM", "SIGHUP"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), on_signal)
    th = threading.Thread(target=httpd.serve_forever, kwargs={"poll_interval": 0.2}, daemon=True)
    th.start()
    lost = _hangup_watch()
    hung_up = False
    try:
        print("seismic-viewer %s: %s  [%d inlines x %d crosslines x %d samples]"
              % (VERSION, ds.meta.get("name"), ds.n_il, ds.n_xl, ds.n_t), flush=True)
        print("listening on http://%s:%d/  (Ctrl-C to stop)" % httpd.server_address[:2], flush=True)
        while not stop.wait(0.5):
            if lost is not None and lost():      # the session that started us is gone: do not stay as an orphan
                hung_up = True
                break
    except OSError:                              # stdout is already dead
        hung_up = True
    finally:
        httpd.shutdown()
        httpd.server_close()
        th.join(timeout=5)
        if hung_up or (lost is not None and lost()):
            try:                                 # nothing can be written any more; keep the exit quiet
                devnull = os.open(os.devnull, os.O_WRONLY)
                os.dup2(devnull, 1)
                os.dup2(devnull, 2)
            except OSError:
                pass
        try:
            print("seismic-viewer stopped", flush=True)
        except OSError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
