#!/usr/bin/env python
"""prep_wells.py - put the wells of Nature's Plug on a prepared seismic cube.

    python prep_wells.py --cube DIR --app DIR [--smeaheia-las DIR] [--sleipner-las FILE] [--picks FILE] [--extra FILE ...]

Writes DIR/wells.json for the seismic viewer: for every exploration well of the app (data/layer1.json) that
falls inside the cube, its position in line numbers, a time-depth relation, group tops and the predicted top
of the Green Clay in two-way time, the logs on a regular time grid and the seismic trace at the well.

Time-depth, in order of quality (stored per well as "td_kind"):

  checkshot    the checkshot-corrected sonic log delivered with the Sleipner reference dataset (curve DT-CKS of well
               15/9-13), integrated from sea level. Nothing is assumed and nothing is picked on the seismic.
  calibrated   sonic log integrated below a sea-bed pick on the seismic, with the unlogged interval between the sea
               bed and the first usable sonic sample given the one velocity that makes the result pass through the
               depth-time picks of the dataset's feasibility study (file "Smeaheia well picks", four per well).
               Those picks lie below the clay and agree with the sonic to within 2 ms between themselves, so they
               fix the level of the curve, not its shape.  Wells 32/2-1 and 32/4-1 only.
  sonic        no depth-time data is open.  Same construction, but the unlogged interval gets the velocity found
               for 32/2-1 (about 1890 m/s).  NOT calibrated: a bulk shift of some tens of ms is possible.
  trend        no sonic either.  Sea-bed pick plus the calibrated 32/2-1 curve below the sea bed.  Tops only.

The "OWT" curve that comes with the 32/2-1 LAS file is NOT used: it gives the sediments above the first sonic
sample the velocity of water (1470 m/s) and is about 50 ms late below them.

Sonic samples that record the steel casing instead of the rock (about 57 us/ft) are removed together with
everything above them: in 32/4-1 that is the log down to about 800 m.

Wells that are not in the atlas (another country, for instance) come in with --extra: a file with position, logs, a
time-depth relation and tops, as prep_nini.py writes it.  They are marked "external" and keep their own sources.

Density that was not logged is estimated with Gardner's relation (0.31 * V^0.25, V in m/s) and flagged.
Depths are metres below the kelly bushing; the wells used are near-vertical exploration wells, so measured
depth is taken as vertical depth.  Standard library + numpy + pyproj.
"""
from __future__ import annotations

import argparse
import json
import math
import os

import numpy as np

DT_OUT = 2.0            # ms, time grid of the logs
V_WATER = 1480.0        # m/s
KB_DEFAULT = 25.0       # m, when the kelly bushing height is unknown (wells without logs)
US_FT = 304800.0        # us/ft -> m/s : v = US_FT / dt


def read_las(path):
    """Minimal LAS 2.0 reader for the Petrel exports of the Smeaheia dataset -> (names, 2-D float array)."""
    with open(path, errors="replace") as fh:
        lines = fh.read().split("\n")
    c0 = next(i for i, l in enumerate(lines) if l.startswith("~Curve"))
    p0 = next(i for i, l in enumerate(lines) if l.startswith("~Parameter"))
    a0 = next(i for i, l in enumerate(lines) if l.startswith("~A"))
    names = [l.split(" .")[0].strip() for l in lines[c0 + 1:p0] if l.strip() and not l.startswith("#")]
    rows = [l.split() for l in lines[a0 + 1:] if l.strip()]
    arr = np.array(rows, dtype=float)
    arr[arr == -999.25] = np.nan
    return names, arr


def first_col(names, arr, name):
    """First column called `name` that has data."""
    best = None
    for j, n in enumerate(names):
        if n == name and np.isfinite(arr[:, j]).any():
            if best is None or np.isfinite(arr[:, j]).sum() > np.isfinite(arr[:, best]).sum():
                best = j
    return None if best is None else arr[:, best]


def nan_interp(x, xp, fp):
    """np.interp that ignores NaN in fp and returns NaN outside the valid range and across gaps > 3 samples."""
    xp, fp = np.asarray(xp, float), np.asarray(fp, float)
    ok = np.isfinite(fp) & np.isfinite(xp)
    if ok.sum() < 2:
        return np.full(len(x), np.nan)
    out = np.interp(x, xp[ok], fp[ok], left=np.nan, right=np.nan)
    # blank output samples that fall in a long gap of the input
    idx = np.searchsorted(xp[ok], x)
    idx = np.clip(idx, 1, ok.sum() - 1)
    gap = xp[ok][idx] - xp[ok][idx - 1]
    med = np.nanmedian(np.diff(xp[ok]))
    out[gap > max(6 * med, 5.0)] = np.nan
    return out


def read_picks(path):
    """Depth-time picks of the feasibility study -> {"32/2-1": [(md, twt_ms), ...], ...} (xlsx of the dataset)."""
    import openpyxl
    out, cur = {}, None
    for row in openpyxl.load_workbook(path, data_only=True, read_only=True).active.iter_rows(values_only=True):
        a = row[0]
        if isinstance(a, str) and a.startswith("NO ") and isinstance(row[3], (int, float)) and isinstance(row[6], (int, float)):
            name = a[3:].replace(" T2", "").strip()
            out.setdefault(name, []).append((float(row[3]), float(row[6])))
    return out


def clean_sonic(md, dt, seabed_md):
    """Sonic in us/ft with impossible values and casing arrivals removed.  Returns (dt, depth below which it is kept)."""
    dt = np.where((dt > 40) & (dt < 250), dt, np.nan)
    ok = np.isfinite(dt)
    cut = None
    if ok.sum() > 20:
        step = float(np.nanmedian(np.diff(md[ok]))) or 0.15
        k = max(3, int(round(3.0 / step)) | 1)                      # 3 m running median
        pad = np.pad(np.where(ok, dt, np.nan), k // 2, mode="edge")
        med = np.nanmedian(np.lib.stride_tricks.sliding_window_view(pad, k), axis=1)
        steel = np.isfinite(med) & (med < 62.0) & (md < seabed_md + 700.0)   # steel is about 57 us/ft; rock that fast is not this shallow
        if steel.any():
            cut = float(md[steel][-1]) + 20.0
            dt = np.where(md <= cut, np.nan, dt)
    return dt, cut


def sonic_td(seabed_md, t_sb, md, dt, zmax, v_gap=None, picks=None):
    """Two-way time on a 0.5 m depth grid from the sea bed: one velocity from the sea bed to the first sonic sample,
    the sonic log below (gaps bridged).  With picks the gap velocity is the one that passes through them (their mean)
    and the remaining misfit is removed as a drift between the picks.  Returns (z, twt, z_first_sonic, v_gap, misfit)."""
    z = np.arange(seabed_md, zmax + 0.5, 0.5)
    dti = nan_interp(z, md, dt)
    ok = np.isfinite(dti)
    z1 = float(z[ok][0])
    slow = np.interp(z, z[ok], dti[ok] / US_FT)                     # s/m, bridged across gaps and held beyond the ends
    tau = 2000.0 * np.concatenate([[0.0], np.cumsum(0.5 * (slow[1:] + slow[:-1]) * np.diff(z))])
    tau1 = tau - np.interp(z1, z, tau)                              # two-way ms below the first sonic sample
    misfit = None
    if picks:
        t_z1 = float(np.mean([t - np.interp(m, z, tau1) for m, t in picks]))
        v_gap = 2000.0 * (z1 - seabed_md) / (t_z1 - t_sb)
    else:
        t_z1 = t_sb + 2000.0 * (z1 - seabed_md) / v_gap
    twt = np.where(z < z1, t_sb + (z - seabed_md) / max(z1 - seabed_md, 1e-6) * (t_z1 - t_sb), t_z1 + tau1)
    if picks:
        pm = np.array([m for m, _ in picks]); res = np.array([t - np.interp(m, z, twt) for m, t in picks])
        misfit = float(np.max(np.abs(res)))
        twt = twt + np.where(z < z1, 0.0, np.interp(z, pm, res))    # drift, constant outside the picks, none above the sonic
    return z, twt, z1, float(v_gap), misfit


def stat_wavelet(traces, dt_ms, t0_ms, t_lo, t_hi, dt_out=2.0, half_ms=100.0):
    """Zero-phase wavelet with the mean amplitude spectrum of the traces between t_lo and t_hi, sampled at dt_out."""
    k0, k1 = int(max(0, (t_lo - t0_ms) / dt_ms)), int(min(traces.shape[1], (t_hi - t0_ms) / dt_ms))
    seg = traces[:, k0:k1].astype(np.float64)
    if seg.shape[1] < 32:
        return None
    seg = seg * np.hanning(seg.shape[1])[None, :]
    nfft = 1 << int(np.ceil(np.log2(seg.shape[1] * 2)))
    amp = np.abs(np.fft.rfft(seg, nfft, axis=1)).mean(axis=0)
    f = np.fft.rfftfreq(nfft, dt_ms / 1000.0)
    amp = np.convolve(amp, np.ones(5) / 5.0, mode="same")           # light smoothing of the spectrum
    amp[f < 3.0] = 0.0
    n_out = int(2 * half_ms / dt_out) + 1
    t = (np.arange(n_out) - n_out // 2) * dt_out / 1000.0
    w = np.array([np.sum(amp * np.cos(2 * np.pi * f * tt)) for tt in t])   # inverse cosine transform = zero phase
    w *= np.hanning(n_out)
    w /= np.max(np.abs(w)) or 1.0
    peak = float(f[np.argmax(amp)])
    return dict(dt=dt_out, w=[round(float(v), 4) for v in w], peak_hz=round(peak, 1))


def bin_mean(tg, t, v, dt):
    """Mean of v in time bins of width dt centred on tg (anti-alias before the logs go on the time grid);
    bins without samples are filled by interpolation, long gaps stay empty."""
    ok = np.isfinite(v) & np.isfinite(t)
    out = np.full(len(tg), np.nan)
    if ok.sum() < 2:
        return out
    idx = np.round((t[ok] - tg[0]) / dt).astype(int)
    m = (idx >= 0) & (idx < len(tg))
    s = np.bincount(idx[m], weights=v[ok][m], minlength=len(tg)); c = np.bincount(idx[m], minlength=len(tg))
    have = c > 0
    out[have] = s[have] / c[have]
    fill = nan_interp(tg, t[ok], v[ok])
    return np.where(have, out, fill)


def seabed_polarity(cube, t_axis, t_expected, half_ms=24.0, step=10):
    """Is the sea bed a positive or a negative number in this cube?  The sea bed is the one reflector that is certain to
    be an increase in acoustic impedance.  For every `step`-th trace the strongest sample within half_ms of the expected
    time is taken; returned are the share of traces where it is positive and the median time of it."""
    k = np.flatnonzero(np.abs(t_axis - t_expected) <= half_ms)
    if k.size < 3:
        return None
    sub = np.asarray(cube[::step, ::step, k[0]:k[-1] + 1], dtype=np.float64).reshape(-1, k.size)
    sub = sub[np.any(sub != 0, axis=1)]
    if sub.shape[0] < 50:
        return None
    q = np.argmax(np.abs(sub), axis=1)
    strongest = sub[np.arange(sub.shape[0]), q]
    return dict(t_expected=round(float(t_expected), 1), window_ms=half_ms, traces=int(sub.shape[0]),
                positive_share=round(float((strongest > 0).mean()), 3), median_time=float(np.median(t_axis[k][q])))


def rnd(a, nd):
    return [None if not np.isfinite(v) else round(float(v), nd) for v in a]


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--cube", required=True)
    ap.add_argument("--app", required=True, help="Nature's Plug folder (with data/layer1.json, data/wells/, data/greenclay.json)")
    ap.add_argument("--smeaheia-las", default=None, help="folder with the LAS files '32 2-1' and '32 4-1' of the Smeaheia dataset")
    ap.add_argument("--sleipner-las", default=None, help="'159-13 Logs.las' of the Sleipner 2019 reference dataset (well 15/9-13)")
    ap.add_argument("--picks", default=None, help="'Smeaheia well picks Feasibility phase.xlsx' of the Smeaheia dataset")
    ap.add_argument("--extra", action="append", default=[], help="file with wells outside the atlas (see prep_nini.py); may be repeated")
    a = ap.parse_args(argv)

    import pyproj
    to_utm = pyproj.Transformer.from_crs(4230, 23031, always_xy=True)      # ED50 geographic -> ED50 / UTM 31N
    to_geo = pyproj.Transformer.from_crs(23031, 4230, always_xy=True)

    meta = json.load(open(os.path.join(a.cube, "meta.json")))
    cube = np.load(os.path.join(a.cube, "cube_ixt.npy"), mmap_mode="r")
    n_il, n_xl, n_t = cube.shape
    ox, oy = meta["origin_xy"]
    A = np.array([[meta["il_axis_m"][0], meta["xl_axis_m"][0]], [meta["il_axis_m"][1], meta["xl_axis_m"][1]]])
    Ainv = np.linalg.inv(A)
    t_axis = meta["t0_ms"] + meta["dt_ms"] * np.arange(n_t)

    def to_grid(x, y):
        i, j = Ainv @ np.array([x - ox, y - oy])
        return float(i), float(j)

    layer1 = json.load(open(os.path.join(a.app, "data", "layer1.json")))
    gc = json.load(open(os.path.join(a.app, "data", "greenclay.json")))["ex"]
    gc_top = dict(zip(gc["n"], gc["top"]))

    # ---- reference: sonic of 32/2-1 tied to the feasibility-study picks -> shallow velocity and a regional trend ----
    las = {}
    if a.smeaheia_las:
        for nm, fn in (("32/2-1", "32 2-1"), ("32/4-1", "32 4-1")):
            p = os.path.join(a.smeaheia_las, fn)
            if os.path.isfile(p):
                las[nm] = read_las(p)
    sleipner = None
    if a.sleipner_las and os.path.isfile(a.sleipner_las):          # OpenWorks export: curve names on the ~A line
        with open(a.sleipner_las, errors="replace") as fh:
            lines = fh.read().split("\n")
        a0 = next(i for i, l in enumerate(lines) if l.startswith("~A"))
        cols = lines[a0].split()[1:]
        arr = np.array([l.split() for l in lines[a0 + 1:] if l.strip()], dtype=float)
        arr[arr == -999.25] = np.nan
        sleipner = {c: arr[:, k] for k, c in enumerate(cols)}
    picks = read_picks(a.picks) if a.picks else {}
    if "32/2-1" not in las or "32/2-1" not in picks:
        raise SystemExit("the 32/2-1 LAS and the well picks file of the Smeaheia dataset are needed (--smeaheia-las, --picks)")
    REF_SEABED_MD, REF_SEABED_TWT = 377.0, 480.0                    # 32/2-1: sea bed below KB, and its time on GN1101
    names, arr = las["32/2-1"]
    ref_dt, _ = clean_sonic(arr[:, 0], first_col(names, arr, "AC"), REF_SEABED_MD)
    rz, rt, _, V_GAP, _ = sonic_td(REF_SEABED_MD, REF_SEABED_TWT, arr[:, 0], ref_dt, 1270.0, picks=picks["32/2-1"])
    ref_z, ref_t = rz - REF_SEABED_MD, (rt - REF_SEABED_TWT) / 2.0   # one-way ms below the sea bed
    v_deep = (ref_z[-1] - ref_z[-200]) / ((ref_t[-1] - ref_t[-200]) / 1000.0)
    print("shallow velocity from 32/2-1 and its picks: %.0f m/s" % V_GAP)

    def trend_owt(zb):
        """One-way time (ms) from the sea bed down to zb metres below it: calibrated 32/2-1 curve, extended linearly."""
        zb = np.asarray(zb, float)
        t = np.interp(zb, ref_z, ref_t)
        deeper = zb > ref_z[-1]
        t = np.where(deeper, ref_t[-1] + (zb - ref_z[-1]) / v_deep * 1000.0, t)
        return t

    wells = []

    def emit(name, field, x, y, fi, fj, i, j, trace, kb, seabed_md, t_sb, td_kind, note, td_md, td_twt, logs, src, top_list, atlas,
             v_gap_used=None, casing_cut=None, more=None):
        """One well of the output: tops in two-way time, the logs on the time grid, the wavelet around the well."""
        def twt_of(md):
            return float(np.interp(md, td_md, td_twt)) if td_md[0] <= md <= td_md[-1] else None

        tops = []
        for top in top_list:
            t = twt_of(top["md"])
            if t is not None:
                tops.append(dict(top, twt=round(t, 1)))
        tops.sort(key=lambda r: r["md"])

        every = 20 if len(td_md) > 3000 else 10 if len(td_md) > 300 else 1      # measured levels are kept as they are
        out = dict(name=name, field=field, il=round(meta["il0"] + fi * meta["il_step"], 2),
                   xl=round(meta["xl0"] + fj * meta["xl_step"], 2), x=round(x, 1), y=round(y, 1), kb=kb,
                   seabed_md=seabed_md, seabed_twt=round(t_sb, 1), td_kind=td_kind, td_note=note, tops=tops,
                   td=dict(md=rnd(td_md[::every], 1), twt=rnd(td_twt[::every], 1)),
                   v_gap=None if v_gap_used is None else round(v_gap_used), casing_cut=casing_cut,
                   seis=dict(il=meta["il0"] + i * meta["il_step"], xl=meta["xl0"] + j * meta["xl_step"],
                             trace=[round(float(v), 3) for v in trace]),
                   log_source=src, logs=None, atlas=atlas)
        if more:
            out.update(more)
        if logs is not None:
            md = logs["md"]
            ok = (md >= td_md[0]) & (md <= td_md[-1])
            twt_md = np.interp(md, td_md, td_twt)
            have = [k for k in ("gr", "dt", "rhob", "rdep", "dts") if logs.get(k) is not None and np.isfinite(logs[k][ok]).any()]
            if have:
                t_lo = min(np.nanmin(twt_md[ok & np.isfinite(logs[k])]) for k in have)
                t_hi = max(np.nanmax(twt_md[ok & np.isfinite(logs[k])]) for k in have)
                tg = np.arange(math.ceil(t_lo / DT_OUT) * DT_OUT, t_hi, DT_OUT)
                L = dict(t0=float(tg[0]), dt=DT_OUT, n=len(tg), md=rnd(np.interp(tg, twt_md[ok], md[ok]), 1))
                on_grid = {k: bin_mean(tg, twt_md[ok], logs[k][ok], DT_OUT) for k in have}
                for k in have:                                  # "dt" is the time step above, so the sonic log is stored as "dtc"
                    L["dtc" if k == "dt" else k] = rnd(on_grid[k], 3)
                # velocity, density (measured or Gardner) and acoustic impedance for the synthetic
                dt_t = on_grid["dt"] if "dt" in have else np.full(len(tg), np.nan)
                vp = US_FT / dt_t
                rho_m = on_grid["rhob"] if "rhob" in have else np.full(len(tg), np.nan)
                gard = 0.31 * np.power(vp, 0.25)
                rho = np.where(np.isfinite(rho_m), rho_m, gard)
                L["vp"] = rnd(vp, 0)
                L["rho_used"] = rnd(rho, 3)
                L["rho_gardner"] = [bool(np.isfinite(v) and not np.isfinite(m)) for v, m in zip(vp, rho_m)]
                L["ai"] = rnd(vp * rho, 0)
                if "dts" in have:
                    vs = US_FT / on_grid["dts"]
                    L["vpvs"] = rnd(vp / vs, 3)
                out["logs"] = L
                # wavelet with the amplitude spectrum of the seismic around the well, over the logged interval
                blk = np.asarray(cube[max(i - 3, 0):i + 4, max(j - 3, 0):j + 4, :], dtype=np.float32).reshape(-1, n_t)
                blk = blk[np.any(blk != 0, axis=1)]
                finite_ai = np.flatnonzero(np.isfinite(vp))
                if blk.size and finite_ai.size:
                    out["wavelet"] = stat_wavelet(blk, meta["dt_ms"], meta["t0_ms"], tg[finite_ai[0]], tg[finite_ai[-1]])
        wells.append(out)

    for w in layer1:
        x, y = to_utm.transform(w["lo"], w["la"])
        fi, fj = to_grid(x, y)
        if not (0 <= fi <= n_il - 1 and 0 <= fj <= n_xl - 1):
            continue
        i, j = int(round(fi)), int(round(fj))
        trace = np.asarray(cube[i, j, :], dtype=np.float32)
        if not np.any(trace):
            continue                                                 # outside the live part of the survey
        name = w["n"]
        seabed_md = (w.get("no") or [None])[0]
        logs = None
        kb = None
        src = None
        if name == "15/9-13" and sleipner is not None:               # logs of the Sleipner reference dataset
            dck = sleipner["DT-CKS"]
            logs = dict(md=sleipner["DEPTH"], gr=sleipner["GR"], dt=np.where((dck > 40) & (dck < 250), dck, np.nan),
                        rhob=sleipner["RHOB"], rdep=None, dts=None)
            kb = 25.0
            src = "Sleipner 2019 reference dataset (the Sleipner Group)"
        elif name in las:                                            # logs that come with the Smeaheia dataset
            names, arr = las[name]
            md = arr[:, 0]
            if name == "32/2-1":
                logs = dict(md=md, gr=first_col(names, arr, "GR"), dt=first_col(names, arr, "AC"),
                            rhob=first_col(names, arr, "DEN"), rdep=first_col(names, arr, "RDEP"),
                            dts=first_col(names, arr, "ACS"))
                kb = 26.0
            else:
                logs = dict(md=md, gr=first_col(names, arr, "GR"), dt=first_col(names, arr, "HAC"),
                            rhob=first_col(names, arr, "DEN"), rdep=first_col(names, arr, "HRD"), dts=None)
                kb = 24.0
            src = "Smeaheia dataset (Gassnova and Equinor)"
        else:
            p = os.path.join(a.app, "data", "wells", name.replace("/", "_").replace(" ", "_") + ".json")
            if os.path.isfile(p):
                d = json.load(open(p))
                f = lambda k: np.array([np.nan if v is None else v for v in d[k]], float)
                logs = dict(md=f("tvd"), gr=f("gr"), dt=f("dtc"), rhob=f("rhob"), rdep=f("rdep"), dts=None)
                kb = float(d.get("kb") or KB_DEFAULT)
                if seabed_md is None and d.get("wd") is not None:
                    seabed_md = float(d["wd"]) + kb
                src = "FORCE 2020 well logs (CC BY 4.0)"
        if seabed_md is None:
            continue
        if kb is None:
            kb = KB_DEFAULT

        # ---- sea-bed time: strongest event near the expected time ----
        t_exp = 2000.0 * (seabed_md - kb) / V_WATER
        win = (t_axis > t_exp - 45) & (t_axis < t_exp + 45)
        if not win.any():
            continue
        # the sea bed is the first strong event of the trace; its polarity is the polarity of the strongest
        # sample in the window, and the EARLIEST such extremum that reaches 35 % of it is taken
        kw = np.flatnonzero(win)
        sgn = 1.0 if trace[kw][np.argmax(np.abs(trace[kw]))] > 0 else -1.0
        av = sgn * trace
        strong = [q for q in kw[1:-1] if av[q] >= 0.35 * av[kw].max() and av[q] >= av[q - 1] and av[q] >= av[q + 1]]
        k = strong[0] if strong else kw[np.argmax(av[kw])]
        t_sb = float(t_axis[k])

        # ---- time-depth ----
        td_kind, note, casing_cut, v_gap_used, misfit = "trend", "", None, None, None
        zmax = max(w.get("sh", [0, 0])[1] if w.get("sh") else 0, (logs["md"][-1] if logs is not None else 0), seabed_md + 1500)
        if name == "15/9-13" and sleipner is not None:
            okc = np.isfinite(logs["dt"]) & (logs["md"] >= kb)
            zc, sc = logs["md"][okc], logs["dt"][okc] / US_FT              # s/m from sea level down
            td_md = zc
            td_twt = 2000.0 * np.concatenate([[0.0], np.cumsum(0.5 * (sc[1:] + sc[:-1]) * np.diff(zc))])
            td_kind = "checkshot"
            sb_cs = float(np.interp(seabed_md, td_md, td_twt))
            note = ("Checkshot-corrected sonic log delivered with the Sleipner reference dataset (curve DT-CKS), integrated from "
                    "sea level to %.0f m. Nothing is picked on the seismic: this curve puts the sea bed at %.0f ms, and the "
                    "seismic shows it at %.0f ms." % (zc[-1], sb_cs, t_sb))
        elif logs is not None and np.isfinite(clean_sonic(logs["md"], logs["dt"], seabed_md)[0]).sum() > 50:
            logs["dt"], casing_cut = clean_sonic(logs["md"], logs["dt"], seabed_md)
            pk = picks.get(name)
            td_md, td_twt, z1, v_gap_used, misfit = sonic_td(seabed_md, t_sb, logs["md"], logs["dt"], zmax, v_gap=V_GAP, picks=pk)
            cas = (" Sonic above %.0f m records the steel casing and is not used." % casing_cut) if casing_cut else ""
            if pk:
                td_kind = "calibrated"
                note = ("Sea bed picked on the seismic at %.0f ms. Sonic integrated below %.0f m and tied to %d depth-time picks of the "
                        "dataset's feasibility study (%.0f to %.0f m, largest misfit before the tie %.1f ms). That fixes the velocity "
                        "between the sea bed and the first sonic sample at %.0f m/s.%s"
                        % (t_sb, z1, len(pk), pk[0][0], pk[-1][0], misfit, v_gap_used, cas))
            else:
                td_kind = "sonic"
                note = ("No open checkshot or depth-time table. Sea bed picked on the seismic at %.0f ms; sonic integrated below %.0f m; "
                        "above that %.0f m/s, the value found in 32/2-1. Not calibrated: a bulk shift of some tens of ms is possible.%s"
                        % (t_sb, z1, V_GAP, cas))
        else:
            td_md = np.arange(seabed_md, zmax + 1.0, 1.0)
            td_twt = t_sb + 2.0 * trend_owt(td_md - seabed_md)
            note = ("No open checkshot or sonic. Sea bed picked on the seismic at %.0f ms, then the calibrated 32/2-1 "
                    "curve below the sea bed. Tops are approximate." % t_sb)

        top_list = [dict(name="Top " + label, key=key, md=w[key][0])
                    for key, label in (("no", "Nordland Gp"), ("ho", "Hordaland Gp"), ("ro", "Rogaland Gp"), ("sh", "Shetland Gp")) if w.get(key)]
        g = gc_top.get(name)
        if g is not None and w.get("ho") and w.get("ro") and w["ho"][0] < g < w["ro"][0]:
            top_list.append(dict(name="Green Clay top (predicted)", key="gc", md=float(g)))
        emit(name, w.get("f"), x, y, fi, fj, i, j, trace, kb, seabed_md, t_sb, td_kind, note, td_md, td_twt, logs, src, top_list,
             ("well=" if w.get("lg") else "exploration=") + name, v_gap_used, casing_cut)

    # ---- wells that are not in the atlas: position, logs, time-depth and tops come ready-made (prep_nini.py) ----
    extra_sources, n_atlas, flat_seabed = [], len(wells), None
    for path in a.extra:
        ex = json.load(open(path))
        used = False
        for e in ex["wells"]:
            if e.get("epsg", 23031) != 23031:
                raise SystemExit("%s: well %s is not in ED50 / UTM zone 31N (EPSG:23031)" % (path, e["name"]))
            fi, fj = to_grid(e["x"], e["y"])
            if not (0 <= fi <= n_il - 1 and 0 <= fj <= n_xl - 1):
                continue
            i, j = int(round(fi)), int(round(fj))
            trace = np.asarray(cube[i, j, :], dtype=np.float32)
            if not np.any(trace):
                continue
            col = lambda v: None if v is None else np.array([np.nan if q is None else q for q in v], float)
            c = e.get("curves") or {}
            logs = dict(md=col(e["md"]), gr=col(c.get("gr")), dt=col(c.get("dt")), rhob=col(c.get("rhob")), rdep=col(c.get("rdep")),
                        dts=col(c.get("dts"))) if e.get("md") else None
            td_md, td_twt = col(e["td"]["md"]), col(e["td"]["twt"])
            lon, lat = to_geo.transform(e["x"], e["y"])
            if e.get("water_depth") is not None and flat_seabed is None:
                flat_seabed = 2000.0 * float(e["water_depth"]) / V_WATER    # sea-bed time from a water depth, not from the seismic
            more = dict(external=True, country=e.get("country"), lon=round(lon, 5), lat=round(lat, 5), about=e.get("about"),
                        td_label=e["td"].get("label"),
                        points=e.get("points") or [], points_about=e.get("points_about"), tops_about=e.get("tops_about"))
            emit(e["name"], e.get("field"), e["x"], e["y"], fi, fj, i, j, trace, e["kb"], e["seabed_md"],
                 float(np.interp(e["seabed_md"], td_md, td_twt)), e["td"]["kind"], e["td"]["note"], td_md, td_twt, logs,
                 e.get("log_source"), e.get("tops") or [], None, more=more)
            used = True
        if used:
            extra_sources += ex.get("sources", [])

    wells.sort(key=lambda r: (r["logs"] is None, r["name"]))

    # ---- places where an operator's own report gives a depth for the top of the Green Clay ----
    sites = []
    for s in json.load(open(os.path.join(a.app, "data", "greenclay.json"))).get("sites", []):
        x, y = to_utm.transform(s["lo"], s["la"])
        fi, fj = to_grid(x, y)
        if not (0 <= fi <= n_il - 1 and 0 <= fj <= n_xl - 1) or not wells:
            continue
        near = min(wells, key=lambda r: math.hypot(r["x"] - x, r["y"] - y))
        md, tw = np.array(near["td"]["md"], float), np.array(near["td"]["twt"], float)
        sites.append(dict(il=round(meta["il0"] + fi * meta["il_step"], 1), xl=round(meta["xl0"] + fj * meta["xl_step"], 1),
                          tvd=s["tvd"], twt=round(float(np.interp(s["tvd"], md, tw)), 1), td_from=near["name"],
                          km_to_td_well=round(math.hypot(near["x"] - x, near["y"] - y) / 1000.0, 1),
                          wells=s.get("wells"), file=s.get("file"), page=s.get("page"), field=s.get("field")))
    atlas_sources = ["Well positions, group tops: Norwegian Offshore Directorate FactPages (NLOD 2.0)",
                     "Logs: FORCE 2020 well log dataset (CC BY 4.0); 32/2-1 and 32/4-1: Smeaheia dataset; 15/9-13: Sleipner 2019 reference dataset (the Sleipner Group)",
                     "Depth-time picks of 32/2-1 and 32/4-1 and seismic: Smeaheia dataset, Gassnova SF and Equinor ASA (CO2 DataShare)",
                     "Green Clay top: Nature's Plug predictor (from open well reports)"]
    res = dict(cube=meta.get("name"), dt_ms=meta["dt_ms"], t0_ms=meta["t0_ms"], n_t=n_t,
               sources=(atlas_sources if n_atlas or not extra_sources else []) + extra_sources,
               wells=wells, gc_sites=sites)
    # ---- polarity: what the documents say (meta.json) and what the sea bed shows.  Only where a water depth is known
    # independently of the seismic; the sea bed is taken as level over the cube, which holds for a box of a few km.
    if flat_seabed is not None:
        chk = seabed_polarity(cube, t_axis, flat_seabed)
        documented = meta.get("polarity")
        used = documented or 1
        if chk and max(chk["positive_share"], 1.0 - chk["positive_share"]) >= 0.8:
            used = 1 if chk["positive_share"] >= 0.5 else -1
        res["polarity"] = dict(documented=documented, documented_note=meta.get("polarity_note"), seabed=chk, used=used)
        print("polarity: documented %s, sea bed positive in %s of %s traces at %s ms (expected %s) -> used %+d" % (
            documented, chk and chk["positive_share"], chk and chk["traces"], chk and chk["median_time"], chk and chk["t_expected"], used))
    p = os.path.join(a.cube, "wells.json")
    with open(p, "w") as fh:
        json.dump(res, fh, separators=(",", ":"))
    # tell the app which wells lie inside a cube, and where the cube is (data/seismic_wells.json, merged over the cubes)
    idx_path = os.path.join(a.app, "data", "seismic_wells.json")
    ds_id = os.path.basename(os.path.normpath(a.cube))
    idx = {"wells": {}, "cubes": {}}
    if os.path.isfile(idx_path):
        old = json.load(open(idx_path))
        if "wells" in old and "cubes" in old:
            idx["wells"] = {k: v for k, v in old["wells"].items() if v.get("ds") != ds_id}
            idx["cubes"] = {k: v for k, v in old["cubes"].items() if k != ds_id}
    for r in wells:
        if r["name"] not in idx["wells"] or r["logs"] is not None:
            idx["wells"][r["name"]] = dict(ds=ds_id, cube=meta.get("name"), td=r["td_kind"])
            if r.get("external"):                               # not in the atlas: the app needs to know where and what it is
                idx["wells"][r["name"]]["ext"] = dict(lo=r["lon"], la=r["lat"], country=r.get("country"), field=r.get("field"),
                                                      about=r.get("about"), logs=r.get("log_source"))
    corners = []                                                         # outline of the cube in ED50 longitude, latitude
    for ci, cj in ((0, 0), (n_il - 1, 0), (n_il - 1, n_xl - 1), (0, n_xl - 1)):
        cx, cy = np.array([ox, oy]) + A @ np.array([ci, cj])
        lon, lat = to_geo.transform(cx, cy)
        corners.append([round(lon, 5), round(lat, 5)])
    short = (meta.get("name") or ds_id).split(",")[0].replace(" 3D", "")
    idx["cubes"][ds_id] = dict(name=meta.get("name"), short=short, outline=corners, licence=meta.get("licence"), attribution=meta.get("attribution"))
    idx = dict(wells=dict(sorted(idx["wells"].items())), cubes=dict(sorted(idx["cubes"].items())))
    with open(idx_path, "w") as fh:
        json.dump(idx, fh, separators=(",", ":"))
    for r in wells:
        print("%-12s IL %7.1f XL %7.1f  seabed %6.1f ms  td=%-15s logs=%s  tops=%s" % (
            r["name"], r["il"], r["xl"], r["seabed_twt"], r["td_kind"] + ("/%d" % r["v_gap"] if r.get("v_gap") else ""),
            "-" if r["logs"] is None else ",".join(k for k in ("gr", "dtc", "rhob", "rdep", "dts") if k in r["logs"]),
            " ".join("%s@%.0f" % (t["key"], t["twt"]) for t in r["tops"])))
    print("Green Clay report sites inside the cube: %d" % len(sites))
    print("wrote %s (%d wells, %.1f MB)" % (p, len(wells), os.path.getsize(p) / 1e6))


if __name__ == "__main__":
    main()
