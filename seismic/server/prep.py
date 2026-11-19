#!/usr/bin/env python
"""prep.py - convert a 3-D post-stack SEG-Y cube to the seismic-viewer dataset layout.

    python prep.py SEGY [--out DIR] [--md5 HEX] [--expect-bytes N]
                        [--allow-partial] [--max-inlines N] [--force]

Writes into DIR (default: data/adele next to this file)

    cube_ixt.npy   float32 little-endian (n_il, n_xl, n_t)
    cube_tix.npy   float32 little-endian (n_t, n_il, n_xl)   same numbers, time-major
    meta.json      geometry, statistics, spectrum, textual header

The SEG-Y file is opened READ-ONLY with numpy.memmap and a structured dtype
(240-byte trace header + n_t big-endian IEEE float32 samples); segyio is not
used.  Everything is taken from the file itself: sample interval, samples per
trace and format code from the binary header; inline, crossline, CDP X/Y,
coordinate scalar and delay from every trace header.  While converting, EVERY
trace header is verified: the traces must form a complete, regular,
inline-major / crossline-minor grid with coordinates on an affine grid, the
same scalar and the same start time.  The conversion stops with a clear
message otherwise.

The file size must match the header arithmetic (3600 + traces * (240 + 4 n_t)
with a whole number of inlines).  A file that fails this check (e.g. a
download in progress) is refused unless --allow-partial is given; then only
the complete inlines present are converted and meta.json gets "partial": true.
Use --expect-bytes and/or --md5 to be certain that a download is complete.

Restartable: progress is kept in DIR/prep_state.json; a second run continues
where the first stopped (use --force to start again).  Memory use is bounded
by --chunk-mb (default 256 MB of trace data per step).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time

import numpy as np

import dsp

HERE = os.path.dirname(os.path.abspath(__file__))
TEXT_BYTES, BIN_BYTES, TRACE_HEADER_BYTES = 3200, 400, 240


def log(msg):
    print(msg, flush=True)


def fail(msg):
    raise SystemExit("prep.py: ERROR: " + msg)


# --------------------------------------------------------------------------
# SEG-Y reading
# --------------------------------------------------------------------------
def decode_textual_header(raw):
    """3200 bytes -> list of 40 strings (EBCDIC cp037 or ASCII, detected)."""
    ebcdic = raw.count(b"\x40") > raw.count(b"\x20")      # which code's SPACE is more common?
    text = raw.decode("cp037", "replace") if ebcdic else raw.decode("ascii", "replace")
    text = "".join(ch if (ch.isprintable() and ord(ch) < 127) else " " for ch in text)
    return [text[i:i + 80].rstrip() for i in range(0, 3200, 80)]


def read_binary_header(raw):
    """400 bytes -> dict with the fields that matter here (1-based SEG-Y byte numbers)."""
    def u2(byte):
        return int(np.frombuffer(raw, dtype=">u2", count=1, offset=byte - 3201)[0])

    def i2(byte):
        return int(np.frombuffer(raw, dtype=">i2", count=1, offset=byte - 3201)[0])
    return {"dt_us": u2(3217), "n_samples": u2(3221), "format": i2(3225),
            "revision": u2(3501), "fixed_length": i2(3503), "n_ext_text": i2(3505)}


def ibm_to_ieee(u):
    """4-byte IBM hexadecimal floats (SEG-Y format code 1), given as unsigned integers -> float32."""
    u = np.asarray(u, dtype=np.uint32)
    sign = np.where(u >> 31, -1.0, 1.0)
    exponent = ((u >> 24) & 0x7F).astype(np.int32) - 64
    mantissa = (u & 0x00FFFFFF).astype(np.float64) / float(1 << 24)
    return (sign * mantissa * np.power(16.0, exponent)).astype("<f4")


def trace_dtype(n_samples, il_byte, xl_byte, x_byte, y_byte, ibm=False):
    """Structured dtype of one trace: selected header fields + the samples (IBM floats are read as raw integers)."""
    return np.dtype({
        "names": ["scalar", "delay", "ns", "dt", "x", "y", "il", "xl", "data"],
        "formats": [">i2", ">i2", ">u2", ">u2", ">i4", ">i4", ">i4", ">i4", (">u4" if ibm else ">f4", (n_samples,))],
        "offsets": [70, 108, 114, 116, x_byte - 1, y_byte - 1, il_byte - 1, xl_byte - 1, TRACE_HEADER_BYTES],
        "itemsize": TRACE_HEADER_BYTES + 4 * n_samples,
    })


def coord_scale(scalar):
    """SEG-Y coordinate scalar: negative = divide by |s|, positive = multiply, 0 = 1."""
    s = int(scalar)
    return 1.0 if s == 0 else (1.0 / -s if s < 0 else float(s))


def md5_of(path, size):
    """Streaming md5 with progress."""
    h = hashlib.md5()
    done, t0, last = 0, time.time(), 0.0
    with open(path, "rb") as fh:
        while True:
            buf = fh.read(16 * 1024 * 1024)
            if not buf:
                break
            h.update(buf)
            done += len(buf)
            if time.time() - last > 5:
                last = time.time()
                log("  md5: %5.1f %%  (%.0f MB/s)" % (100.0 * done / max(size, 1), done / 1e6 / max(last - t0, 1e-3)))
    return h.hexdigest()


# --------------------------------------------------------------------------
# state handling (restart)
# --------------------------------------------------------------------------
def write_json_atomic(path, obj, indent=None):
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(obj, fh, indent=indent)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)


def open_cube(path, shape, resume):
    """Open (resume) or create a .npy float32 cube as a writable memmap."""
    if resume and os.path.isfile(path):
        mm = np.lib.format.open_memmap(path, mode="r+")
        if mm.shape == tuple(shape) and mm.dtype == np.dtype("<f4"):
            return mm
        del mm
    mm = np.lib.format.open_memmap(path, mode="w+", dtype=np.dtype("<f4"), shape=tuple(shape))
    try:                                        # reserve the disk space now (fails early if the disk is full)
        fd = os.open(path, os.O_RDWR)
        try:
            os.posix_fallocate(fd, 0, os.path.getsize(path))
        finally:
            os.close(fd)
    except (AttributeError, OSError) as e:
        if isinstance(e, OSError) and e.errno == 28:
            fail("not enough disk space for %s" % path)
    return mm


# --------------------------------------------------------------------------
# main conversion
# --------------------------------------------------------------------------
def convert(a):
    path = os.path.abspath(a.segy)
    if not os.path.isfile(path):
        fail("no such file: %s" % path)
    out_dir = os.path.abspath(a.out or os.path.join(HERE, "data", "adele"))
    if a.allow_partial and not a.out:
        fail("--allow-partial needs an explicit --out folder (a partial cube must not land in data/adele)")
    size = os.path.getsize(path)
    log("SEG-Y   : %s  (%d bytes)" % (path, size))
    log("output  : %s" % out_dir)
    if size < TEXT_BYTES + BIN_BYTES + TRACE_HEADER_BYTES:
        fail("file is too small to be a SEG-Y file")

    with open(path, "rb") as fh:
        text_raw = fh.read(TEXT_BYTES)
        bin_raw = fh.read(BIN_BYTES)
    textual = decode_textual_header(text_raw)
    bh = read_binary_header(bin_raw)
    log("binary header: sample interval %d us, %d samples/trace, format code %d, revision 0x%04x"
        % (bh["dt_us"], bh["n_samples"], bh["format"], bh["revision"]))
    if bh["format"] not in (1, 5):
        fail("data sample format code is %d; only 5 (4-byte IEEE float) and 1 (4-byte IBM float) are supported" % bh["format"])
    ibm = bh["format"] == 1
    n_t = bh["n_samples"]
    if n_t < 2 or bh["dt_us"] <= 0:
        fail("binary header has no valid sample count / sample interval")
    offset = TEXT_BYTES + BIN_BYTES
    if bh["revision"] >= 0x0100 and bh["n_ext_text"] > 0:
        offset += TEXT_BYTES * bh["n_ext_text"]
        log("skipping %d extended textual header(s)" % bh["n_ext_text"])
    dtype = trace_dtype(n_t, a.il_byte, a.xl_byte, a.x_byte, a.y_byte, ibm)
    trace_bytes = dtype.itemsize
    n_avail, tail = divmod(size - offset, trace_bytes)
    if n_avail < 2:
        fail("file holds fewer than 2 complete traces")
    mm = np.memmap(path, dtype=dtype, mode="r", offset=offset, shape=(n_avail,))

    # ---- grid from the first inline ----------------------------------------
    il0, xl0 = int(mm[0]["il"]), int(mm[0]["xl"])
    n_xl = None
    pos = 0
    while pos < n_avail and n_xl is None:
        il = np.asarray(mm["il"][pos:pos + 4096])
        change = np.nonzero(il != il0)[0]
        if change.size:
            n_xl = pos + int(change[0])
        pos += il.size
    if n_xl is None:
        fail("only one inline (%d) found in the %d complete traces present - nothing to convert" % (il0, n_avail))
    if n_xl < 2:
        fail("the inline number (bytes %d-%d) changes after one trace: the file is not sorted inline-major, "
             "or the header byte positions are wrong" % (a.il_byte, a.il_byte + 3))
    xl_step = int(mm[1]["xl"]) - xl0
    il_step = int(mm[n_xl]["il"]) - il0
    if xl_step == 0 or il_step == 0:
        fail("crossline / inline numbers do not change as expected (xl step %d, il step %d)" % (xl_step, il_step))
    n_il_file, rest = divmod(n_avail, n_xl)
    size_ok = (tail == 0 and rest == 0)
    expected = offset + n_il_file * n_xl * trace_bytes
    log("grid    : first inline %d has %d crosslines %d..%d step %d; inline step %d; %d complete inline(s) present"
        % (il0, n_xl, xl0, xl0 + (n_xl - 1) * xl_step, xl_step, il_step, n_il_file))
    problems = []
    if not size_ok:
        problems.append("file size %d does not match the header arithmetic: %d + %d inlines x %d crosslines x "
                        "%d bytes = %d (%d stray bytes, last inline incomplete)"
                        % (size, offset, n_il_file, n_xl, trace_bytes, expected, size - expected))
    if a.expect_bytes is not None and size != a.expect_bytes:
        problems.append("file size %d differs from --expect-bytes %d (%.1f %% present)"
                        % (size, a.expect_bytes, 100.0 * size / a.expect_bytes))
    complete = not problems
    if problems and not a.allow_partial:
        fail("the SEG-Y file looks INCOMPLETE:\n  - " + "\n  - ".join(problems) +
             "\n  Wait for the download to finish, or use --allow-partial --out DIR to convert the complete "
             "inlines that are present.")
    for p in problems:
        log("WARNING (--allow-partial): " + p)
    if complete:
        log("file size matches header arithmetic: %d + %d x %d x %d bytes" % (offset, n_il_file, n_xl, trace_bytes))
        if a.expect_bytes is None:
            log("note: without --expect-bytes / --md5 a download that stopped exactly on an inline boundary "
                "cannot be told from a complete file")

    md5_hex = None
    if a.md5:
        if not complete:
            log("md5 check skipped (file is incomplete)")
        else:
            log("computing md5 ...")
            md5_hex = md5_of(path, size)
            if md5_hex.lower() != a.md5.strip().lower():
                fail("md5 MISMATCH: file %s, expected %s" % (md5_hex, a.md5.strip().lower()))
            log("md5 OK: %s" % md5_hex)

    n_il = n_il_file
    if a.max_inlines is not None:
        if a.max_inlines < 2:
            fail("--max-inlines must be at least 2")
        n_il = min(n_il, a.max_inlines)
    if n_il < 2:
        fail("fewer than 2 complete inlines present")
    partial = (not complete) or n_il < n_il_file

    # ---- geometry model ----------------------------------------------------
    first = mm[0]
    scalar, delay = int(first["scalar"]), int(first["delay"])
    sc = coord_scale(scalar)

    def xy(i):
        return np.array([float(mm[i]["x"]) * sc, float(mm[i]["y"]) * sc])
    origin = xy(0)
    xl_axis = (xy(n_xl - 1) - origin) / (n_xl - 1)
    il_axis = (xy((n_il - 1) * n_xl) - origin) / (n_il - 1)
    if not (np.hypot(*xl_axis) > 0 and np.hypot(*il_axis) > 0):
        fail("CDP coordinates (bytes %d-%d / %d-%d) do not change along the lines; cannot build the map geometry"
             % (a.x_byte, a.x_byte + 3, a.y_byte, a.y_byte + 3))
    dt_ms = bh["dt_us"] / 1000.0
    t0_ms = float(delay)
    for name, v in (("ns", int(first["ns"])), ("dt", int(first["dt"]))):
        ref = n_t if name == "ns" else bh["dt_us"]
        if v not in (0, ref):
            fail("trace header %s = %d contradicts the binary header (%d)" % (name, v, ref))
    log("geometry: origin (%.2f, %.2f), one inline step = (%.4f, %.4f) m, one crossline step = (%.4f, %.4f) m, "
        "scalar %d" % (origin[0], origin[1], il_axis[0], il_axis[1], xl_axis[0], xl_axis[1], scalar))
    log("time    : %d samples, %.3f ms sampling, first sample at %.1f ms" % (n_t, dt_ms, t0_ms))
    log("convert : %d inlines x %d crosslines x %d samples%s"
        % (n_il, n_xl, n_t, "  (PARTIAL)" if partial else ""))

    # ---- state / restart ---------------------------------------------------
    os.makedirs(out_dir, exist_ok=True)
    state_path = os.path.join(out_dir, "prep_state.json")
    ixt_path, tix_path = os.path.join(out_dir, "cube_ixt.npy"), os.path.join(out_dir, "cube_tix.npy")
    meta_path = os.path.join(out_dir, "meta.json")
    signature = {"source": path, "offset": offset, "n_il": n_il, "n_xl": n_xl, "n_t": n_t,
                 "il0": il0, "il_step": il_step, "xl0": xl0, "xl_step": xl_step}
    state = None
    if os.path.isfile(state_path) and not a.force:
        try:
            with open(state_path) as fh:
                state = json.load(fh)
        except (OSError, ValueError):
            state = None
        if state is not None and state.get("signature") != signature:
            log("existing prep_state.json belongs to a different conversion - starting again")
            state = None
    if state is None:
        if os.path.isfile(meta_path) and not a.force:
            fail("%s already holds a dataset (meta.json) without matching prep_state.json; "
                 "use --force to overwrite it" % out_dir)
        for p in (meta_path,):
            if os.path.isfile(p):
                os.remove(p)
        state = {"signature": signature, "inlines_done": 0, "amp_min": None, "amp_max": None,
                 "n_nonfinite": 0, "finished": False}
    if state.get("finished") and os.path.isfile(meta_path):
        log("already converted (meta.json present); use --force to convert again")
        return 0
    resume = state["inlines_done"] > 0
    if resume:
        for p in (ixt_path, tix_path):
            if not os.path.isfile(p):
                log("%s is missing - starting again from the first inline" % os.path.basename(p))
                state.update({"inlines_done": 0, "amp_min": None, "amp_max": None, "n_nonfinite": 0})
                resume = False
                break
    if resume:
        log("resuming after %d of %d inlines" % (state["inlines_done"], n_il))
    ixt = open_cube(ixt_path, (n_il, n_xl, n_t), resume)
    tix = open_cube(tix_path, (n_t, n_il, n_xl), resume)
    if not resume:
        write_json_atomic(state_path, state)

    # ---- one pass over the traces: verify headers, write both cubes ---------
    chunk = max(1, int(a.chunk_mb * 1e6 // (n_xl * trace_bytes)))
    xl_expect = xl0 + xl_step * np.arange(n_xl, dtype=np.int64)
    jj = np.arange(n_xl, dtype=np.float64)
    amp_min = float("inf") if state["amp_min"] is None else state["amp_min"]
    amp_max = float("-inf") if state["amp_max"] is None else state["amp_max"]
    n_bad = int(state["n_nonfinite"])
    coord_warned = False
    t_start = time.time()
    start_il = state["inlines_done"]
    for ia in range(start_il, n_il, chunk):
        ib = min(n_il, ia + chunk)
        block = mm[ia * n_xl:ib * n_xl]
        nb = ib - ia

        def where(flat_index):
            k = int(flat_index)
            return "trace %d (inline position %d, crossline position %d)" % (ia * n_xl + k, ia + k // n_xl, k % n_xl)
        il = np.asarray(block["il"]).astype(np.int64).reshape(nb, n_xl)
        il_expect = il0 + il_step * np.arange(ia, ib, dtype=np.int64)
        bad = np.nonzero((il != il_expect[:, None]).ravel())[0]
        if bad.size:
            k = bad[0]
            fail("irregular grid: %s has inline %d, expected %d (grid must be complete, regular and sorted "
                 "inline-major)" % (where(k), il.ravel()[k], il_expect[k // n_xl]))
        xl = np.asarray(block["xl"]).astype(np.int64).reshape(nb, n_xl)
        bad = np.nonzero((xl != xl_expect[None, :]).ravel())[0]
        if bad.size:
            k = bad[0]
            fail("irregular grid: %s has crossline %d, expected %d" % (where(k), xl.ravel()[k], xl_expect[k % n_xl]))
        for name, ref in (("scalar", scalar), ("delay", delay)):
            v = np.asarray(block[name])
            bad = np.nonzero(v != ref)[0]
            if bad.size:
                fail("%s: trace header %s = %d differs from the first trace (%d)"
                     % (where(bad[0]), name, int(v[bad[0]]), ref))
        ns = np.asarray(block["ns"])
        bad = np.nonzero((ns != 0) & (ns != n_t))[0]
        if bad.size:
            fail("%s: %d samples in the trace header, binary header says %d" % (where(bad[0]), int(ns[bad[0]]), n_t))
        ii = np.arange(ia, ib, dtype=np.float64)[:, None]
        for name, c in (("x", 0), ("y", 1)):
            got = np.asarray(block[name]).astype(np.float64).reshape(nb, n_xl) * sc
            model = origin[c] + ii * il_axis[c] + jj[None, :] * xl_axis[c]
            err = np.abs(got - model)
            if err.max() > a.coord_tol:
                k = int(np.argmax(err))
                msg = ("%s: CDP %s = %.2f is %.2f m away from the regular grid (%.2f); tolerance %.2f m"
                       % (where(k), name.upper(), got.ravel()[k], err.ravel()[k], model.ravel()[k], a.coord_tol))
                if not a.coord_warn_only:
                    fail(msg + "  (use --coord-warn-only to continue anyway)")
                if not coord_warned:
                    log("WARNING: " + msg)
                    coord_warned = True
        data = (ibm_to_ieee(block["data"]) if ibm else np.asarray(block["data"]).astype("<f4")).reshape(nb, n_xl, n_t)
        finite = np.isfinite(data)
        if not finite.all():
            n_bad += int(data.size - np.count_nonzero(finite))
            data[~finite] = 0.0
        del finite
        amp_min = min(amp_min, float(data.min()))
        amp_max = max(amp_max, float(data.max()))
        ixt[ia:ib] = data
        tix[:, ia:ib, :] = data.transpose(2, 0, 1)
        del data, block
        ixt.flush()
        tix.flush()
        state.update({"inlines_done": ib, "amp_min": amp_min, "amp_max": amp_max, "n_nonfinite": n_bad})
        write_json_atomic(state_path, state)
        el = time.time() - t_start
        rate = (ib - start_il) / max(el, 1e-6)
        log("  inlines %4d / %d  (%5.1f %%)  %.1f inlines/s  ETA %.0f s"
            % (ib, n_il, 100.0 * ib / n_il, rate, (n_il - ib) / max(rate, 1e-9)))
    if n_bad:
        log("WARNING: %d non-finite samples were replaced by 0" % n_bad)
    del tix
    ixt.flush()

    # ---- statistics, spectrum, meta ----------------------------------------
    log("statistics and spectrum from a fixed-seed random sample of traces ...")
    stats, spectrum = dsp.cube_statistics(ixt, dt_ms / 1000.0, seed=0)
    amp = {"min": amp_min, "max": amp_max}
    amp.update(stats)
    del ixt
    meta = {
        "name": a.name, "synthetic": False, "attribution": a.attribution, "licence": a.licence,
        "doi": a.doi or None,
        "n_il": n_il, "n_xl": n_xl, "n_t": n_t,
        "il0": il0, "il_step": il_step, "xl0": xl0, "xl_step": xl_step,
        "t0_ms": t0_ms, "dt_ms": dt_ms, "domain": "time", "nyquist_hz": 500.0 / dt_ms,
        "il_axis_m": [round(float(il_axis[0]), 6), round(float(il_axis[1]), 6)],
        "xl_axis_m": [round(float(xl_axis[0]), 6), round(float(xl_axis[1]), 6)],
        "origin_xy": [round(float(origin[0]), 3), round(float(origin[1]), 3)],
        "crs": a.crs,
        "amp": amp,
        "spectrum": spectrum,
        "textual_header": textual,
        "partial": bool(partial),
        "segy": {"file": os.path.basename(path), "bytes": size, "md5": md5_hex,
                 "format_code": bh["format"], "sample_interval_us": bh["dt_us"], "n_samples": n_t,
                 "revision": bh["revision"], "coordinate_scalar": scalar, "delay_ms": delay,
                 "n_traces_converted": n_il * n_xl, "n_inlines_in_file": n_il_file,
                 "n_nonfinite_replaced": n_bad,
                 "header_bytes": {"inline": a.il_byte, "crossline": a.xl_byte, "cdp_x": a.x_byte,
                                  "cdp_y": a.y_byte, "scalar": 71, "delay": 109}},
    }
    write_json_atomic(meta_path, meta, indent=1)
    state["finished"] = True
    write_json_atomic(state_path, state)
    log("amplitude: min %.4g, max %.4g, rms %.4g, p999 %.4g" % (amp_min, amp_max, amp["rms"], amp["p999"]))
    log("done: %s  [%d x %d x %d]%s" % (out_dir, n_il, n_xl, n_t, "  PARTIAL" if partial else ""))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("segy", help="path of the SEG-Y file (opened read-only)")
    ap.add_argument("--out", default=None, help="output folder (default: data/adele next to prep.py)")
    ap.add_argument("--md5", default=None, help="expected md5 of the SEG-Y file (streamed; mismatch = error)")
    ap.add_argument("--expect-bytes", type=int, default=None, help="expected size of the complete SEG-Y file")
    ap.add_argument("--allow-partial", action="store_true",
                    help="convert the complete inlines of an incomplete file (needs --out)")
    ap.add_argument("--max-inlines", type=int, default=None, help="convert only the first N inlines")
    ap.add_argument("--force", action="store_true", help="ignore earlier progress / overwrite an existing dataset")
    ap.add_argument("--chunk-mb", type=float, default=256.0, help="trace data per step in MB (default 256)")
    ap.add_argument("--coord-tol", type=float, default=0.5, help="allowed deviation from the regular map grid, m")
    ap.add_argument("--coord-warn-only", action="store_true", help="coordinate deviations only give a warning")
    ap.add_argument("--il-byte", type=int, default=189, help="trace header byte of the inline number (189)")
    ap.add_argument("--xl-byte", type=int, default=193, help="trace header byte of the crossline number (193)")
    ap.add_argument("--x-byte", type=int, default=181, help="trace header byte of CDP X (181)")
    ap.add_argument("--y-byte", type=int, default=185, help="trace header byte of CDP Y (185)")
    ap.add_argument("--name", default="Adele 3D PSTM full offset (FORCE 2020 fault-detection blind cube)")
    ap.add_argument("--attribution", default="Data courtesy of Geoscience Australia")
    ap.add_argument("--licence", default="CC BY 4.0")
    ap.add_argument("--doi", default="10.5281/zenodo.4299758")
    ap.add_argument("--crs", default="GDA94 / MGA zone 51 (EPSG:28351)")
    return convert(ap.parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
