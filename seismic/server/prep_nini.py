#!/usr/bin/env python
"""prep_nini.py - well Nini-4 (Danish North Sea) from open GEUS files, as a well file for prep_wells.py --extra.

    python prep_nini.py --las nini-4_schlumberger.las --dev nini-4_dev_version_1.0.las
                        --vsp Nini-4_Computations.txt [--xrd Appendix_F_WP3_7_data.xlsx] --out nini_wells.json

Nini-4 is not a well of the atlas (it is Danish), but it is the one open well found where the Eocene green clay has a
shear sonic log, a measured time-depth relation and measured smectite contents:

  logs          merged wireline logs of the free GEUS well package NINI-4 (gamma ray, compressional and shear sonic,
                density, resistivity), 802 to 1875 m
  time-depth    the rig-source vertical seismic profile of the same package (CGG, November 2002): 58 levels from 320
                to 1880 m with vertical one-way time below mean sea level.  Measured, so the tie is never shifted.
  position      wellhead and kelly bushing from the deviation file; the hole is vertical to within 10 m
  smectite      X-ray diffraction on cuttings and core, GEUS Report 2022/31 (Schovsbo, Petersen, Weibel and Springer
                2023, doi 10.22008/gpub/34666), Appendix F.  Read from the spreadsheet as published; the values stay
                with the seismic server and are not copied into the repository (the report states no licence).
  tops          NOT official tops.  The same report labels every sample with its formation; a boundary must lie between
                the last sample of one unit and the first of the next.  Inside that bracket the largest step of the
                gamma-ray log is taken; where the logs give no clear step the middle of the bracket is used.  Each top
                carries its bracket.

Standard library + numpy (+ openpyxl for --xrd).  Depths are metres below the kelly bushing.
"""
from __future__ import annotations

import argparse
import json

import numpy as np

V_WATER = 1480.0


def read_las(path):
    """LAS 2.0 -> ({mnemonic: column}, data section header words).  Mnemonic = the text before the first dot."""
    with open(path, errors="replace") as fh:
        lines = fh.read().split("\n")
    c0 = next(i for i, l in enumerate(lines) if l.startswith("~C"))
    a0 = next(i for i, l in enumerate(lines) if l.startswith("~A"))
    end = next(i for i in range(c0 + 1, len(lines)) if lines[i].startswith("~"))
    names = [l.split(".")[0].strip() for l in lines[c0 + 1:end] if l.strip() and not l.startswith("#")]
    arr = np.array([l.split() for l in lines[a0 + 1:] if l.strip()], dtype=float)
    arr[arr == -999.25] = np.nan
    return {n: arr[:, k] for k, n in enumerate(names)}


def read_vsp(path):
    """CGG 'Computations' listing -> rows (measured depth KB, vertical depth KB, vertical depth MSL, one-way ms below MSL)."""
    rows = []
    with open(path, errors="replace") as fh:
        for line in fh:
            parts = line.split()
            if len(parts) != 9:
                continue
            try:
                v = [float(p) for p in parts]
            except ValueError:
                continue
            rows.append((v[0], v[1], v[2], v[7]))
    rows.sort()
    return rows


def step_in(md, v, lo, hi, half=4.0):
    """Depth between lo and hi where the mean of v over `half` metres below differs most from the mean above."""
    best = None
    for z in np.arange(lo, hi + 1e-6, 0.5):
        up, dn = v[(md >= z - half) & (md < z)], v[(md >= z) & (md < z + half)]
        if np.isfinite(up).sum() < 5 or np.isfinite(dn).sum() < 5:
            continue
        d = float(np.nanmean(dn) - np.nanmean(up))
        if best is None or abs(d) > abs(best[1]):
            best = (float(z), d)
    return best


def read_xrd(path, well="Nini-4"):
    """Rows of the main sheet of Appendix F for one well -> list of dicts (depths in m MD as published)."""
    import openpyxl
    ws = openpyxl.load_workbook(path, data_only=True, read_only=True)["all_NINI4data"]
    rows = list(ws.iter_rows(values_only=True))
    head = next(k for k, r in enumerate(rows) if r and "Smectite (%)" in r)
    col = {str(v).strip(): k for k, v in enumerate(rows[head]) if v is not None}
    num = lambda v: float(v) if isinstance(v, (int, float)) else None
    out = []
    for r in rows[head + 1:]:
        if not r or r[col["Well"]] != well:
            continue
        top, base = num(r[col["Depth top (m, md)"]]), num(r[col["Depth base (m, md)"]])
        if base is None:
            continue
        out.append(dict(lab=r[col["Laboratory number"]], material=r[col["Material"]], formation=str(r[col["Formation"]]).strip(),
                        md_top=top if top is not None else base, md_base=base,
                        smectite=num(r[col["Smectite (%)"]]), clay=num(r[col["Sum Clay (%)"]]),
                        illite=num(r[col["Muscovite / illite (%)"]]), kaolinite=num(r[col["Kaolinite (%)"]]),
                        quartz=num(r[col["Quartz (%)"]])))
    out.sort(key=lambda s: (s["md_top"], s["md_base"]))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--las", required=True)
    ap.add_argument("--dev", required=True)
    ap.add_argument("--vsp", required=True)
    ap.add_argument("--xrd", default=None)
    ap.add_argument("--water-depth", type=float, default=59.0, help="m; from the survey sheet of the VSP report (59)")
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)

    dev = read_las(a.dev)
    kb = -float(dev["TVD"][0])                                   # TVD is below sea level; the first row is the rotary table
    x, y = float(dev["UTMX"][0]), float(dev["UTMY"][0])
    drift = float(np.max(np.hypot(dev["UTMX"] - x, dev["UTMY"] - y)))
    stretch = float(np.max(np.abs(dev["MD"] - (dev["TVD"] + kb))))
    seabed_md = kb + a.water_depth

    logs = read_las(a.las)
    md = logs["DEPT"]
    dt = np.where((logs["DTCO"] > 40) & (logs["DTCO"] < 250), logs["DTCO"], np.nan)
    dts = np.where((logs["DTSM"] > 80) & (logs["DTSM"] < 800) & np.isfinite(dt), logs["DTSM"], np.nan)
    rho = np.where((logs["RHOZ"] > 1.5) & (logs["RHOZ"] < 3.1), logs["RHOZ"], np.nan)
    gr, rt = logs["GR"], np.where(logs["RT"] > 0, logs["RT"], np.nan)

    # ---- time-depth: the measured levels, joined by straight lines -------------
    vsp = read_vsp(a.vsp)
    if len(vsp) < 10:
        raise SystemExit("prep_nini.py: fewer than 10 VSP levels read from %s" % a.vsp)
    z = np.array([r[0] for r in vsp])
    t2 = 2.0 * np.array([r[3] for r in vsp])
    if np.any(np.diff(z) <= 0) or np.any(np.diff(t2) <= 0):
        raise SystemExit("prep_nini.py: the VSP levels are not increasing in depth and time")
    v_last = 2000.0 * (z[-1] - z[-6]) / (t2[-1] - t2[-6])       # below the deepest level: the velocity of its last 50 m
    z_end = max(float(np.nanmax(md)), float(z[-1])) + 5.0
    td_md = np.concatenate([[kb, seabed_md], z, [z_end]])
    td_twt = np.concatenate([[0.0, 2000.0 * a.water_depth / V_WATER], t2, [t2[-1] + 2000.0 * (z_end - z[-1]) / v_last]])
    note = ("Rig-source vertical seismic profile of the well (CGG, November 2002, in the free GEUS well package): %d measured "
            "levels from %.0f to %.0f m, times vertical and below mean sea level, joined by straight lines. Above the first "
            "level only the sea bed (%.0f m of water at %.0f m/s) is used. Nothing is picked on the seismic and nothing is "
            "shifted." % (len(vsp), z[0], z[-1], a.water_depth, V_WATER))

    # ---- tops: brackets from the formation labels of the samples, placed with the gamma-ray log ----
    xrd = read_xrd(a.xrd) if a.xrd else []
    tops = []
    if xrd:
        def bracket(above, below):
            up = [s["md_base"] for s in xrd if s["formation"] in above]
            dn = [s["md_top"] for s in xrd if s["formation"] in below]
            return (max(up), min(dn)) if up and dn else None

        def add(name, key, br, use_log):
            if br is None:
                return
            lo, hi = br
            st = step_in(md, gr, lo, hi) if use_log else None
            if st is not None and abs(st[1]) >= 15.0:
                tops.append(dict(name=name, key=key, md=round(st[0], 1), bracket=[lo, hi], how="gamma-ray step of %+.0f API inside the bracket" % st[1]))
            else:
                tops.append(dict(name=name + " (approx.)", key=key, md=round(0.5 * (lo + hi), 1), bracket=[lo, hi], how="middle of the bracket"))
        add("Top Lark Fm", "ho", bracket({"Nolde sand"}, {"Lark Fm L3"}), True)
        add("Top Lark L2", "l2", bracket({"Lark Fm L3"}, {"Lark Fm L2"}), False)
        add("Top Lark L1", "l1", bracket({"Lark Fm L2"}, {"Lark Fm L1"}), False)
        add("Top Horda Fm", "hd", bracket({"Lark Fm L1"}, {"Horda"}), True)
        add("Top Sele Fm", "ro", bracket({"Horda"}, {"Sele"}), False)

    twt = lambda d: float(np.interp(d, td_md, td_twt))
    points = [dict(s, md=round(0.5 * (s["md_top"] + s["md_base"]), 2), twt=round(twt(0.5 * (s["md_top"] + s["md_base"])), 1))
              for s in xrd if s["smectite"] is not None]

    rnd = lambda arr, nd: [None if not np.isfinite(v) else round(float(v), nd) for v in arr]
    keep = np.isfinite(gr) | np.isfinite(dt) | np.isfinite(rho)
    keep &= md >= seabed_md
    well = dict(
        name="Nini-4", country="Denmark", field="Nini West", epsg=23031, x=x, y=y, kb=round(kb, 2), seabed_md=round(seabed_md, 2),
        water_depth=a.water_depth,
        about=("Danish well of 2002 on the Nini West oil field, studied as a CO2 store in Project Greensand. Shown because it has "
               "what the open Norwegian wells in this app lack together: a shear sonic log, a vertical seismic profile and "
               "smectite measured on samples of the Eocene clay (the Horda Formation, which GEUS describes as greenish grey to greyish green mudstone). "
               "Vertical to within %.0f m; measured depth and vertical depth differ by at most %.1f m." % (drift, stretch)),
        md=rnd(md[keep], 3), curves=dict(gr=rnd(gr[keep], 2), dt=rnd(dt[keep], 3), dts=rnd(dts[keep], 3), rhob=rnd(rho[keep], 4), rdep=rnd(rt[keep], 4)),
        td=dict(kind="checkshot", label="Vertical seismic profile, %d measured levels" % len(vsp), md=rnd(td_md, 2), twt=rnd(td_twt, 2), note=note),
        tops=tops, points=points,
        points_about=("Smectite by X-ray diffraction on cuttings (depth interval) and core (one depth). GEUS Report 2022/31, "
                      "Appendix F: Schovsbo, Petersen, Weibel and Springer 2023, doi 10.22008/gpub/34666."),
        tops_about=("Not official tops. GEUS Report 2022/31 labels every sample with its formation; each top lies between the last "
                    "sample of one unit and the first of the next, at the largest gamma-ray step in that bracket or, without a clear "
                    "step, in its middle."),
        log_source="Free GEUS well package NINI-4 (merged wireline logs), GEUS terms for free Danish subsurface data",
    )
    res = dict(sources=["Nini-4 logs, deviation and vertical seismic profile: free well package NINI-4, Geological Survey of Denmark and Greenland (GEUS)",
                        "Seismic: NODAB-97 3D (CGG 1997-1999), free seismic package of GEUS; both under GEUS's terms for free Danish subsurface data (2023-09-19)",
                        "Smectite and formation labels: GEUS Report 2022/31, Schovsbo et al. 2023, doi 10.22008/gpub/34666"],
               wells=[well])
    with open(a.out, "w") as fh:
        json.dump(res, fh, separators=(",", ":"))
    print("Nini-4: KB %.1f m, wellhead (%.1f, %.1f), drift %.1f m, MD-TVD at most %.2f m" % (kb, x, y, drift, stretch))
    print("logs  : %d samples %.1f..%.1f m; sonic %d, shear %d, density %d" % (keep.sum(), md[keep][0], md[keep][-1], np.isfinite(dt).sum(), np.isfinite(dts).sum(), np.isfinite(rho).sum()))
    print("VSP   : %d levels %.0f..%.0f m, two-way %.1f..%.1f ms; velocity used below the last level %.0f m/s" % (len(vsp), z[0], z[-1], t2[0], t2[-1], v_last))
    for t in tops:
        print("top   : %-24s %7.1f m  %7.1f ms  bracket %s  (%s)" % (t["name"], t["md"], twt(t["md"]), t["bracket"], t["how"]))
    for p in points:
        print("xrd   : %-8s %-18s %7.1f-%7.1f m  %6.1f ms  smectite %5.1f %%  clay %5.1f %%" % (p["material"], p["formation"], p["md_top"], p["md_base"], p["twt"], p["smectite"], p["clay"] or float("nan")))
    print("wrote", a.out)


if __name__ == "__main__":
    main()
