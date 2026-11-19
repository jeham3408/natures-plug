#!/usr/bin/env python
"""crop_segy.py - cut a regular box out of a 3-D post-stack SEG-Y file that prep.py cannot read as it is.

    python crop_segy.py SEGY OUT.sgy --il FIRST LAST --xl FIRST LAST [--t-max MS]
                        [--il-byte N] [--xl-byte N] [--x-byte N] [--y-byte N]
                        [--il-step N] [--xl-step N] [--fill-missing] [--force]

Many released surveys are not rectangles: the lines have different lengths, the line and CDP numbers sit in other trace
header bytes than SEG-Y revision 1 uses, the coordinates are whole metres and the samples are IBM floats.  prep.py
insists on a complete, regular, inline-major grid.  This tool reads the trace headers of the whole file once, takes the
traces inside the requested box of inline and crossline numbers and writes them as a new, small SEG-Y file:

  - 4-byte IEEE floats (format code 5), from the first sample to --t-max
  - inline in bytes 189-192, crossline in 193-196, CDP X / Y in bytes 181-188 with coordinate scalar -100 (centimetres)
  - coordinates from a least-squares plane through the header coordinates of the box, so that whole-metre header
    coordinates become an exact grid (the largest misfit is printed and must stay below --coord-tol)
  - the textual header and all other trace header bytes unchanged; the amplitudes are not scaled and not reversed

The source file is opened read-only.  A box that is not completely covered by traces is refused unless --fill-missing
is given; then the missing traces are written as zeros and counted.  OUT.sgy.json records what was done.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np

import prep

TEXT_BYTES, BIN_BYTES, TRACE_HEADER_BYTES = prep.TEXT_BYTES, prep.BIN_BYTES, prep.TRACE_HEADER_BYTES


def log(msg):
    print(msg, flush=True)


def fail(msg):
    raise SystemExit("crop_segy.py: ERROR: " + msg)


def put(header, byte, values, fmt):
    """Write big-endian integers into a (n, 240) uint8 header block at a 1-based SEG-Y byte number."""
    v = np.ascontiguousarray(np.asarray(values).astype(fmt))
    width = v.dtype.itemsize
    header[:, byte - 1:byte - 1 + width] = v.view("u1").reshape(-1, width)


def crop(a):
    src = os.path.abspath(a.segy)
    out = os.path.abspath(a.out)
    if not os.path.isfile(src):
        fail("no such file: %s" % src)
    if src == out:
        fail("the output file must not be the source file")
    if os.path.exists(out) and not a.force:
        fail("%s exists; use --force to overwrite it" % out)
    size = os.path.getsize(src)
    with open(src, "rb") as fh:
        text_raw = fh.read(TEXT_BYTES)
        bin_raw = bytearray(fh.read(BIN_BYTES))
    bh = prep.read_binary_header(bytes(bin_raw))
    if bh["format"] not in (1, 5):
        fail("data sample format code is %d; only 5 (IEEE float) and 1 (IBM float) are supported" % bh["format"])
    ibm = bh["format"] == 1
    n_t, dt_ms = bh["n_samples"], bh["dt_us"] / 1000.0
    if n_t < 2 or dt_ms <= 0:
        fail("binary header has no valid sample count / sample interval")
    offset = TEXT_BYTES + BIN_BYTES
    if bh["revision"] >= 0x0100 and bh["n_ext_text"] > 0:
        offset += TEXT_BYTES * bh["n_ext_text"]
    trace_bytes = TRACE_HEADER_BYTES + 4 * n_t
    n, tail = divmod(size - offset, trace_bytes)
    if tail or n < 1:
        fail("file size %d does not hold a whole number of %d-byte traces (%d stray bytes)" % (size, trace_bytes, tail))
    log("SEG-Y   : %s  (%d traces, %d samples at %.3f ms, format %d)" % (src, n, n_t, dt_ms, bh["format"]))

    # ---- one pass over all trace headers -----------------------------------
    hd = np.dtype({"names": ["il", "xl", "x", "y", "scalar", "delay"],
                   "formats": [">i4", ">i4", ">i4", ">i4", ">i2", ">i2"],
                   "offsets": [a.il_byte - 1, a.xl_byte - 1, a.x_byte - 1, a.y_byte - 1, 70, 108],
                   "itemsize": trace_bytes})
    heads = np.memmap(src, dtype=hd, mode="r", offset=offset, shape=(n,))
    cols = {k: np.empty(n, np.int64) for k in hd.names}
    t0, step = time.time(), 200000
    for p in range(0, n, step):
        block = heads[p:p + step]
        for k in hd.names:
            cols[k][p:p + step] = block[k]
    del heads
    il, xl = cols["il"], cols["xl"]
    log("headers : inline %d..%d (bytes %d-%d), crossline %d..%d (bytes %d-%d), read in %.0f s"
        % (il.min(), il.max(), a.il_byte, a.il_byte + 3, xl.min(), xl.max(), a.xl_byte, a.xl_byte + 3, time.time() - t0))

    # ---- the box ------------------------------------------------------------
    (il0, il1), (xl0, xl1) = a.il, a.xl
    if il1 <= il0 or xl1 <= xl0 or (il1 - il0) % a.il_step or (xl1 - xl0) % a.xl_step:
        fail("--il / --xl must be FIRST LAST with LAST > FIRST and a whole number of steps between them")
    n_il, n_xl = (il1 - il0) // a.il_step + 1, (xl1 - xl0) // a.xl_step + 1
    inside = ((il >= il0) & (il <= il1) & (xl >= xl0) & (xl <= xl1)
              & ((il - il0) % a.il_step == 0) & ((xl - xl0) % a.xl_step == 0))
    idx = np.nonzero(inside)[0]
    if idx.size < 3:
        fail("no traces inside inline %d..%d, crossline %d..%d" % (il0, il1, xl0, xl1))
    i_of, j_of = (il[idx] - il0) // a.il_step, (xl[idx] - xl0) // a.xl_step
    pos = i_of * n_xl + j_of
    # A position held by two traces: tapes streamed one after the other can repeat a whole line.  The first copy is
    # used, and below the samples of every such pair are compared: copies that differ stop the conversion.
    order = np.argsort(pos, kind="stable")
    again = np.nonzero(pos[order][1:] == pos[order][:-1])[0]
    twins = np.column_stack([idx[order][again], idx[order][again + 1]])
    used, first = np.unique(pos, return_index=True)
    slot = np.full(n_il * n_xl, -1, np.int64)
    slot[used] = idx[first]
    n_missing = int(np.count_nonzero(slot < 0))
    if n_missing and not a.fill_missing:
        k = int(np.nonzero(slot < 0)[0][0])
        fail("%d of %d positions in the box have no trace (first: inline %d, crossline %d); choose a box inside "
             "the survey or use --fill-missing" % (n_missing, slot.size, il0 + (k // n_xl) * a.il_step,
                                                    xl0 + (k % n_xl) * a.xl_step))
    for name in ("scalar", "delay"):
        v = cols[name][idx]
        if np.any(v != v[0]):
            fail("trace header %s is not the same for all traces of the box" % name)
    scalar, delay = int(cols["scalar"][idx[0]]), int(cols["delay"][idx[0]])
    n_keep = n_t if a.t_max is None else int(np.floor((a.t_max - delay) / dt_ms + 1e-9)) + 1
    if not 2 <= n_keep <= n_t:
        fail("--t-max %s leaves %d samples; the traces run from %d to %.0f ms" % (a.t_max, n_keep, delay, delay + (n_t - 1) * dt_ms))

    # ---- coordinates: a plane through the header coordinates ---------------
    sc = prep.coord_scale(scalar)
    design = np.column_stack([np.ones(idx.size), i_of, j_of]).astype(np.float64)
    xy = np.column_stack([cols["x"][idx] * sc, cols["y"][idx] * sc])
    plane, *_ = np.linalg.lstsq(design, xy, rcond=None)                 # rows: origin, one inline step, one crossline step
    misfit = float(np.abs(design @ plane - xy).max())
    log("box     : %d inlines %d..%d x %d crosslines %d..%d, %d samples (%d..%.0f ms), %d missing"
        % (n_il, il0, il1, n_xl, xl0, xl1, n_keep, delay, delay + (n_keep - 1) * dt_ms, n_missing))
    log("geometry: origin (%.2f, %.2f), inline step (%.4f, %.4f) m, crossline step (%.4f, %.4f) m; "
        "largest misfit to the header coordinates %.2f m"
        % (plane[0, 0], plane[0, 1], plane[1, 0], plane[1, 1], plane[2, 0], plane[2, 1], misfit))
    if misfit > a.coord_tol:
        fail("the header coordinates (bytes %d-%d / %d-%d) are up to %.2f m away from a regular grid; tolerance "
             "%.2f m" % (a.x_byte, a.x_byte + 3, a.y_byte, a.y_byte + 3, misfit, a.coord_tol))

    # ---- write --------------------------------------------------------------
    bin_raw[3221 - 3201:3223 - 3201] = int(n_keep).to_bytes(2, "big")
    bin_raw[3225 - 3201:3227 - 3201] = (5).to_bytes(2, "big")
    src_dt = np.dtype({"names": ["h", "d"], "formats": [("u1", (TRACE_HEADER_BYTES,)), (">u4" if ibm else ">f4", (n_t,))],
                       "offsets": [0, TRACE_HEADER_BYTES], "itemsize": trace_bytes})
    out_dt = np.dtype([("h", "u1", (TRACE_HEADER_BYTES,)), ("d", ">f4", (n_keep,))])
    traces = np.memmap(src, dtype=src_dt, mode="r", offset=offset, shape=(n,))
    for p, q in twins:
        if not np.array_equal(traces[int(p)]["d"][:n_keep], traces[int(q)]["d"][:n_keep]):
            fail("inline %d, crossline %d occurs twice with different samples (traces %d and %d) - wrong header "
                 "bytes, or two versions in one file" % (il[p], xl[p], p, q))
    if len(twins):
        log("repeats : %d positions occur twice with identical samples (inlines %s); the first copy is used"
            % (len(twins), ", ".join(str(v) for v in np.unique(il[twins[:, 0]])[:12])))
    jj = np.arange(n_xl, dtype=np.float64)
    n_bad, t0 = 0, time.time()
    tmp = out + ".part"
    with open(tmp, "wb") as fh:
        fh.write(text_raw)
        fh.write(bytes(bin_raw))
        for i in range(n_il):
            ids = slot[i * n_xl:(i + 1) * n_xl]
            have = ids >= 0
            block = np.zeros(n_xl, out_dt)
            if have.any():
                got = traces[ids[have]]                                 # the file is sorted, so this reads forwards
                block["h"][have] = got["h"]
                d = got["d"][:, :n_keep]
                d = prep.ibm_to_ieee(d) if ibm else d.astype("<f4")
                finite = np.isfinite(d)
                if not finite.all():
                    n_bad += int(d.size - np.count_nonzero(finite))
                    d = np.where(finite, d, np.float32(0.0))
                block["d"][have] = d
            h = block["h"]
            if not have.all():
                h[~have, 28:30] = np.asarray([3], ">i2").view("u1")     # trace identification code 3 = dummy
            put(h, 71, np.full(n_xl, -100), ">i2")
            put(h, 109, np.full(n_xl, delay), ">i2")
            put(h, 115, np.full(n_xl, n_keep), ">u2")
            put(h, 117, np.full(n_xl, bh["dt_us"]), ">u2")
            put(h, 181, np.rint((plane[0, 0] + i * plane[1, 0] + jj * plane[2, 0]) * 100.0), ">i4")
            put(h, 185, np.rint((plane[0, 1] + i * plane[1, 1] + jj * plane[2, 1]) * 100.0), ">i4")
            put(h, 189, np.full(n_xl, il0 + i * a.il_step), ">i4")
            put(h, 193, xl0 + a.xl_step * np.arange(n_xl), ">i4")
            block.tofile(fh)
            if (i + 1) % 50 == 0 or i + 1 == n_il:
                log("  inlines %4d / %d  (%.0f s)" % (i + 1, n_il, time.time() - t0))
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, out)
    if n_bad:
        log("WARNING: %d non-finite samples were replaced by 0" % n_bad)
    record = {
        "source": {"file": os.path.basename(src), "bytes": size, "traces": int(n), "samples": n_t,
                   "sample_interval_ms": dt_ms, "format_code": bh["format"],
                   "header_bytes": {"inline": a.il_byte, "crossline": a.xl_byte, "x": a.x_byte, "y": a.y_byte},
                   "coordinate_scalar": scalar},
        "box": {"inline": [il0, il1, a.il_step], "crossline": [xl0, xl1, a.xl_step],
                "time_ms": [delay, delay + (n_keep - 1) * dt_ms], "traces": int(slot.size), "missing_filled": n_missing,
                "identical_repeats_dropped": int(len(twins))},
        "geometry": {"origin_xy": [round(float(plane[0, 0]), 3), round(float(plane[0, 1]), 3)],
                     "inline_step_m": [round(float(plane[1, 0]), 6), round(float(plane[1, 1]), 6)],
                     "crossline_step_m": [round(float(plane[2, 0]), 6), round(float(plane[2, 1]), 6)],
                     "largest_misfit_to_header_coordinates_m": round(misfit, 3)},
        "output": {"file": os.path.basename(out), "bytes": os.path.getsize(out), "format_code": 5,
                   "header_bytes": {"inline": 189, "crossline": 193, "x": 181, "y": 185}, "coordinate_scalar": -100,
                   "non_finite_replaced": n_bad},
        "note": "Amplitudes are unchanged (not scaled, not reversed). Textual header unchanged.",
    }
    with open(out + ".json", "w") as fh:
        json.dump(record, fh, indent=1)
    log("done    : %s  (%d bytes)" % (out, os.path.getsize(out)))
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("segy", help="path of the SEG-Y file (opened read-only)")
    ap.add_argument("out", help="path of the SEG-Y file to write")
    ap.add_argument("--il", type=int, nargs=2, required=True, metavar=("FIRST", "LAST"), help="inline numbers of the box")
    ap.add_argument("--xl", type=int, nargs=2, required=True, metavar=("FIRST", "LAST"), help="crossline numbers of the box")
    ap.add_argument("--il-step", type=int, default=1)
    ap.add_argument("--xl-step", type=int, default=1)
    ap.add_argument("--t-max", type=float, default=None, help="last time to keep, ms (default: the whole trace)")
    ap.add_argument("--il-byte", type=int, default=189, help="trace header byte of the inline number in the source (189)")
    ap.add_argument("--xl-byte", type=int, default=193, help="trace header byte of the crossline number in the source (193)")
    ap.add_argument("--x-byte", type=int, default=181, help="trace header byte of the X coordinate in the source (181)")
    ap.add_argument("--y-byte", type=int, default=185, help="trace header byte of the Y coordinate in the source (185)")
    ap.add_argument("--coord-tol", type=float, default=1.0, help="allowed misfit of the header coordinates to a grid, m")
    ap.add_argument("--fill-missing", action="store_true", help="write zeros where the box has no trace")
    ap.add_argument("--force", action="store_true", help="overwrite an existing output file")
    return crop(ap.parse_args(argv))


if __name__ == "__main__":
    sys.exit(main())
