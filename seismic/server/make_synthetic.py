#!/usr/bin/env python
"""make_synthetic.py - write a small, fully documented synthetic test cube.

Output: <out>/cube_ixt.npy, <out>/cube_tix.npy, <out>/meta.json in the
seismic-viewer dataset layout (default <out> = data/synthetic next to this
file).  The cube is deterministic (fixed seed) and contains features that
exercise every function of the viewer; everything that was put in is
recorded in meta["truth"].

    python make_synthetic.py [--out DIR] [--n-il 61] [--n-xl 301] [--n-t 501]

THIS IS NOT REAL DATA.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

import dsp

HERE = os.path.dirname(os.path.abspath(__file__))
SEED = 20261119

# geometry (mimics the Adele survey)
IL0, IL_STEP, XL0, XL_STEP = 4175, 2, 5670, 1
T0_MS, DT_MS = 1500.0, 4.0
IL_AXIS_M = [0.0, 37.5]        # one stored inline step: 37.5 m to the north
XL_AXIS_M = [-12.5, 0.0]       # one crossline step: 12.5 m to the WEST
ORIGIN_XY = [573238.90, 8477109.08]
CRS = "GDA94 / MGA zone 51 (EPSG:28351) - synthetic, coordinates borrowed from Adele"

# the letter "F": rows listed from NORTH to SOUTH, columns from WEST to EAST
F_PATTERN = ["XXXXX",
             "X....",
             "XXXX.",
             "X....",
             "X....",
             "X....",
             "X...."]
F_BLOCK_IL, F_BLOCK_XL = 2, 6          # one pattern cell = 2 inlines x 6 crosslines = 75 m x 75 m
F_IL_INDEX0, F_XL_INDEX0 = 40, 40      # southern-most inline index, eastern-most crossline index
F_T_MS, F_AMP, F_FREQ = 2700.0, 4.0, 30.0

TONE = {"il_index": [2, 6], "xl_index": [4, 12], "amp": 1.0, "f_hz": 30.0}


def ricker(t_s, f_hz):
    """Ricker wavelet with peak (dominant) frequency f_hz, unit peak amplitude."""
    a = (np.pi * f_hz * t_s) ** 2
    return (1.0 - 2.0 * a) * np.exp(-a)


def f_mask(n_il, n_xl):
    """Boolean (n_il, n_xl) map mask of the letter F and its cells in line numbers."""
    mask = np.zeros((n_il, n_xl), dtype=bool)
    cells = []
    n_rows, n_cols = len(F_PATTERN), len(F_PATTERN[0])
    xl_west = F_XL_INDEX0 + n_cols * F_BLOCK_XL - 1          # highest crossline index = west edge
    for r, row in enumerate(F_PATTERN):                      # r = 0 is the NORTH end
        ia = F_IL_INDEX0 + (n_rows - 1 - r) * F_BLOCK_IL
        ib = ia + F_BLOCK_IL - 1
        for c, ch in enumerate(row):                         # c = 0 is the WEST side
            if ch != "X":
                continue
            jb = xl_west - c * F_BLOCK_XL
            ja = jb - F_BLOCK_XL + 1
            mask[ia:ib + 1, ja:jb + 1] = True
            cells.append({"il": [IL0 + ia * IL_STEP, IL0 + ib * IL_STEP],
                          "xl": [XL0 + ja * XL_STEP, XL0 + jb * XL_STEP]})
    return mask, cells


def build(n_il=61, n_xl=301, n_t=501, seed=SEED):
    """Return (cube float32 (n_il, n_xl, n_t), truth dict)."""
    if n_il < 56 or n_xl < 80 or n_t < 400:
        raise SystemExit("synthetic cube must be at least 56 x 80 x 400 (il, xl, t)")
    rng = np.random.default_rng(seed)
    t = T0_MS + DT_MS * np.arange(n_t)                       # ms
    t_end = float(t[-1])
    east = XL_AXIS_M[0] * np.arange(n_xl)                    # local metres, origin = first trace
    north = IL_AXIS_M[1] * np.arange(n_il)
    E, N = np.meshgrid(east, north)                          # (n_il, n_xl)
    fi = np.arange(n_il)[:, None] / (n_il - 1.0)
    fj = np.arange(n_xl)[None, :] / (n_xl - 1.0)

    # ---- structure: gentle dip + one normal fault -------------------------
    dip_xl_ms, dip_il_ms = 40.0, 16.0                        # total relief across the cube
    shift_dip = dip_xl_ms * fj + dip_il_ms * fi              # ms, later = deeper
    strike_az = 30.0                                         # fault strikes N30E
    dipdir = np.deg2rad(strike_az + 90.0)                    # dips towards azimuth 120 (ESE)
    nvec = np.array([np.sin(dipdir), np.cos(dipdir)])        # (east, north)
    p0 = np.array([east[n_xl // 2], north[n_il // 2]])
    t_ref = 0.5 * (T0_MS + t_end)
    heave_m_per_ms = 0.25
    throw_ms = 36.0
    dist = nvec[0] * (E - p0[0]) + nvec[1] * (N - p0[1])     # m, positive on the down-dip side
    hanging = dist[:, :, None] > heave_m_per_ms * (t[None, None, :] - t_ref)
    shift = shift_dip[:, :, None] + throw_ms * hanging       # (n_il, n_xl, n_t) ms
    tau = t[None, None, :] - shift                           # "stratigraphic time" of every sample

    # ---- 1-D reflectivity series -> non-stationary wavelets -----------------
    dtf = 0.5
    tau_f = np.arange(T0_MS - 250.0, t_end + 250.0 + dtf, dtf)
    f_top, f_bot = 45.0, 12.0

    def f_dom(tk):
        return f_top + (f_bot - f_top) * np.clip((tk - T0_MS) / (t_end - T0_MS), 0.0, 1.0)

    thin_tau, thin_f, thin_amp = T0_MS + 300.0, 60.0, 1.6
    thick_top = T0_MS + 0.73 * (t_end - T0_MS)
    thick_base = thick_top + 130.0
    thick_f, thick_amp = 10.0, 1.6
    quiet = [(thin_tau - 40.0, thin_tau + 40.0), (thick_top - 80.0, thick_base + 70.0)]

    spikes = []
    tk = float(tau_f[0]) + 10.0
    while True:
        tk += rng.uniform(16.0, 70.0)
        if tk > tau_f[-1] - 10.0:
            break
        r = rng.uniform(0.25, 1.0) * rng.choice([-1.0, 1.0])
        if any(a <= tk <= b for a, b in quiet):
            continue
        spikes.append((tk, r))
    ref = np.zeros_like(tau_f)
    for tk, r in spikes:
        ref += r * ricker((tau_f - tk) / 1000.0, f_dom(tk))
    ref += thin_amp * ricker((tau_f - thin_tau) / 1000.0, thin_f)
    ref += thick_amp * ricker((tau_f - thick_top) / 1000.0, thick_f)
    ref -= thick_amp * ricker((tau_f - thick_base) / 1000.0, thick_f)

    cube = np.interp(tau.ravel(), tau_f, ref).reshape(tau.shape)

    # ---- bright sinuous channel on one horizon ------------------------------
    ch_tau, ch_f, ch_amp = T0_MS + 800.0, 28.0, 2.5
    ch_halfwidth, ch_edge = 110.0, 25.0
    ch_mid = north[n_il // 2]
    ch_swing = 0.2 * (north[-1] - north[0])
    ch_wavelength, ch_phase = 1500.0, 0.6
    u = -E                                                    # metres WEST of the origin
    arg = 2.0 * np.pi * u / ch_wavelength + ch_phase
    centre = ch_mid + ch_swing * np.sin(arg)
    slope = ch_swing * np.cos(arg) * 2.0 * np.pi / ch_wavelength
    d_perp = np.abs(N - centre) / np.sqrt(1.0 + slope ** 2)
    ch_profile = 0.5 * (1.0 - np.tanh((d_perp - ch_halfwidth) / ch_edge))
    ch_ref = ricker((tau_f - ch_tau) / 1000.0, ch_f)
    cube += ch_amp * ch_profile[:, :, None] * np.interp(tau.ravel(), tau_f, ch_ref).reshape(tau.shape)

    # ---- asymmetric map marker: the letter F, flat in time -------------------
    mask, cells = f_mask(n_il, n_xl)
    cube += F_AMP * mask[:, :, None] * ricker((t - F_T_MS) / 1000.0, F_FREQ)[None, None, :]

    # ---- weak white noise ---------------------------------------------------
    noise_sigma = 0.03
    cube += noise_sigma * rng.standard_normal(cube.shape)
    cube = cube.astype(np.float32)

    # ---- pure-tone block (exact, no noise) ----------------------------------
    ia, ib = TONE["il_index"]
    ja, jb = TONE["xl_index"]
    tone = (TONE["amp"] * np.cos(2.0 * np.pi * TONE["f_hz"] * t / 1000.0)).astype(np.float32)
    cube[ia:ib + 1, ja:jb + 1, :] = tone[None, None, :]

    ic, jc = n_il // 2, n_xl // 2
    truth = {
        "seed": seed,
        "note": "trace(il, xl, t) = R(t - shift(il, xl, t)) + channel + F marker + noise; "
                "the pure-tone block overwrites everything inside it",
        "structure": {
            "shift_ms": "shift = %.1f*(xl_index/(n_xl-1)) + %.1f*(il_index/(n_il-1)) + throw_ms*[hanging wall]"
                        % (dip_xl_ms, dip_il_ms),
            "dip": "horizons get later (deeper) towards the WEST (increasing crossline, %.0f ms across the cube) "
                   "and towards the NORTH (increasing inline, %.0f ms)" % (dip_xl_ms, dip_il_ms),
        },
        "fault": {
            "type": "normal", "strike_azimuth_deg": strike_az, "dip_direction_azimuth_deg": strike_az + 90.0,
            "throw_ms": throw_ms, "heave_m_per_ms": heave_m_per_ms,
            "passes_through": {"il": IL0 + ic * IL_STEP, "xl": XL0 + jc * XL_STEP, "t_ms": t_ref},
            "hanging_wall": "the ESE side (lower crossline numbers / lower inline numbers); "
                            "its horizons are throw_ms LATER than on the WNW footwall",
            "definition": "hanging wall where n.(p - p0) > heave_m_per_ms*(t - t_ref), "
                          "n = unit vector towards the dip direction, p = local (east, north) in m",
        },
        "background": {
            "n_reflectors": len(spikes),
            "wavelet": "Ricker, dominant frequency falling linearly from %.0f Hz at %.0f ms to %.0f Hz at %.0f ms "
                       "(stratigraphic time)" % (f_top, T0_MS, f_bot, t_end),
            "f_top_hz": f_top, "f_bottom_hz": f_bot,
        },
        "thin_bed": {"tau_ms": thin_tau, "f_hz": thin_f, "amp": thin_amp,
                     "note": "single %.0f Hz Ricker in a quiet zone of +-40 ms; time at a trace = tau_ms + shift"
                             % thin_f},
        "thick_package": {"tau_top_ms": thick_top, "tau_base_ms": thick_base, "f_hz": thick_f, "amp": thick_amp,
                          "note": "top (+) and base (-) %.0f Hz Rickers in a quiet zone; time = tau + shift" % thick_f},
        "channel": {
            "tau_ms": ch_tau, "f_hz": ch_f, "amp": ch_amp, "half_width_m": ch_halfwidth,
            "centre_line": "north_m = %.1f + %.1f*sin(2*pi*west_m/%.0f + %.2f), west_m = 12.5*xl_index, "
                           "north_m = 37.5*il_index" % (ch_mid, ch_swing, ch_wavelength, ch_phase),
            "note": "runs east-west along one horizon (positive Ricker peak); time at a trace = tau_ms + shift, "
                    "so a single time slice shows only part of it, an RMS map over ~100 ms shows more",
        },
        "f_marker": {
            "t_ms": F_T_MS, "f_hz": F_FREQ, "amp": F_AMP, "flat_in_time": True,
            "il": [IL0 + F_IL_INDEX0 * IL_STEP,
                   IL0 + (F_IL_INDEX0 + len(F_PATTERN) * F_BLOCK_IL - 1) * IL_STEP],
            "xl": [XL0 + F_XL_INDEX0 * XL_STEP,
                   XL0 + (F_XL_INDEX0 + len(F_PATTERN[0]) * F_BLOCK_XL - 1) * XL_STEP],
            "size_m": {"east_west": len(F_PATTERN[0]) * F_BLOCK_XL * 12.5,
                       "north_south": len(F_PATTERN) * F_BLOCK_IL * 37.5},
            "pattern_north_up_west_left": F_PATTERN,
            "cells": cells,
            "orientation": "In a correct map (north up, east right) the F reads normally: stem on the WEST side "
                           "(= HIGHEST crossline numbers), top bar at the NORTH end (= HIGHEST inline numbers), "
                           "arms pointing EAST (towards lower crossline numbers).  In the raw /api/slice image "
                           "(rows = inline increasing downward, columns = crossline increasing to the right) "
                           "it therefore appears rotated by 180 degrees.",
        },
        "tone_block": {
            "il": [IL0 + ia * IL_STEP, IL0 + ib * IL_STEP], "xl": [XL0 + ja * XL_STEP, XL0 + jb * XL_STEP],
            "amp": TONE["amp"], "f_hz": TONE["f_hz"],
            "definition": "trace(t) = amp*cos(2*pi*f_hz*t_ms/1000) for every sample, t_ms = absolute two-way time; "
                          "exact (float32), no noise",
        },
        "noise": {"type": "white Gaussian", "sigma": noise_sigma},
    }
    return cube, truth


def write_dataset(out_dir, cube, truth):
    """Write cube_ixt.npy, cube_tix.npy and meta.json for the synthetic cube."""
    os.makedirs(out_dir, exist_ok=True)
    n_il, n_xl, n_t = cube.shape
    cube = np.ascontiguousarray(cube, dtype="<f4")
    np.save(os.path.join(out_dir, "cube_ixt.npy"), cube)
    np.save(os.path.join(out_dir, "cube_tix.npy"), np.ascontiguousarray(cube.transpose(2, 0, 1)))
    dt_s = DT_MS / 1000.0
    stats, spectrum = dsp.cube_statistics(cube, dt_s, seed=0)
    amp = {"min": float(cube.min()), "max": float(cube.max())}
    amp.update(stats)
    lines = [
        "SYNTHETIC TEST CUBE for seismic-viewer - NOT REAL DATA",
        "Generated by make_synthetic.py, seed %d" % truth["seed"],
        "%d inlines %d..%d step %d, %d crosslines %d..%d step %d"
        % (n_il, IL0, IL0 + (n_il - 1) * IL_STEP, IL_STEP, n_xl, XL0, XL0 + (n_xl - 1) * XL_STEP, XL_STEP),
        "%d samples, %.0f..%.0f ms two-way time, sample interval %.0f ms"
        % (n_t, T0_MS, T0_MS + (n_t - 1) * DT_MS, DT_MS),
        "Layered reflectivity, Ricker 45 -> 12 Hz, one normal fault, channel, letter F, tone block",
        "See meta.json \"truth\" for the exact content",
    ]
    header = [("C%2d %s" % (i + 1, lines[i] if i < len(lines) else "")).ljust(80)[:80] for i in range(40)]
    meta = {
        "name": "SYNTHETIC TEST CUBE",
        "synthetic": True,
        "attribution": "Synthetic test data generated by make_synthetic.py (not real data)",
        "licence": "CC0 1.0 (synthetic, no rights reserved)",
        "doi": None,
        "n_il": n_il, "n_xl": n_xl, "n_t": n_t,
        "il0": IL0, "il_step": IL_STEP, "xl0": XL0, "xl_step": XL_STEP,
        "t0_ms": T0_MS, "dt_ms": DT_MS, "domain": "time", "nyquist_hz": 500.0 / DT_MS,
        "il_axis_m": IL_AXIS_M, "xl_axis_m": XL_AXIS_M,
        "origin_xy": ORIGIN_XY, "crs": CRS,
        "amp": amp,
        "spectrum": spectrum,
        "textual_header": header,
        "truth": truth,
    }
    tmp = os.path.join(out_dir, "meta.json.tmp")
    with open(tmp, "w") as fh:
        json.dump(meta, fh, indent=1)
    os.replace(tmp, os.path.join(out_dir, "meta.json"))
    return meta


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=os.path.join(HERE, "data", "synthetic"))
    ap.add_argument("--n-il", type=int, default=61)
    ap.add_argument("--n-xl", type=int, default=301)
    ap.add_argument("--n-t", type=int, default=501)
    ap.add_argument("--seed", type=int, default=SEED)
    a = ap.parse_args(argv)
    cube, truth = build(a.n_il, a.n_xl, a.n_t, a.seed)
    meta = write_dataset(a.out, cube, truth)
    print("wrote %s: %d x %d x %d (il, xl, t), amp p999 = %.3f, rms = %.3f"
          % (a.out, meta["n_il"], meta["n_xl"], meta["n_t"], meta["amp"]["p999"], meta["amp"]["rms"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
