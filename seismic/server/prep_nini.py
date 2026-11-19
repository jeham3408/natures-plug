#!/usr/bin/env python
"""prep_nini.py - the Danish wells Nini-4 and Nini-5 from open GEUS files, as a well file for prep_wells.py --extra.

    python prep_nini.py --out nini_wells.json
        [--nini4-las nini-4_schlumberger.las --nini4-dev nini-4_dev_version_1.0.las --nini4-vsp Nini-4_Computations.txt]
        [--xrd Appendix_F_WP3_7_data.xlsx]
        [--nini5-las nini-5_schlumberger.las --nini5-dev nini-5_dev_version_1.0.las --nini5-vsp "Nini-5 VSP Computations.xlsx"]

The two wells are not in the atlas (they are Danish), but they are the open wells found where the Eocene clay of the
Horda Formation has a shear sonic log and a measured time-depth relation, and Nini-4 also measured smectite contents:

  logs          merged wireline logs of the free GEUS well packages NINI-4 and NINI-5 (gamma ray, compressional and
                shear sonic, density, resistivity)
  time-depth    the rig-source vertical seismic profile of each well: measured levels with vertical one-way time below
                mean sea level, joined by straight lines.  Measured, so the tie is never shifted.  (The Nini-5 table is
                an .xls file; convert it once with `soffice --headless --convert-to xlsx`.)
  position      wellhead and kelly bushing from the deviation file; both holes are vertical to within 15 m
  tops          the operator's lithostratigraphic tops, from the final well reports in the same packages (scanned;
                read by OCR and checked: measured depth minus depth below sea level equals the kelly bushing height in
                every row).  The reports also give a two-way time for each top, which is kept as a check on the
                time-depth relation used here.
  smectite      Nini-4 only: X-ray diffraction on cuttings and core, GEUS Report 2022/31 (Schovsbo, Petersen, Weibel and
                Springer 2023, doi 10.22008/gpub/34666), Appendix F.  Read from the spreadsheet as published; the
                values stay with the seismic server and are not copied into the repository (the report states no
                licence).  Its formation labels are those of the report and follow a later lithostratigraphy than the
                operator's tops.

Standard library + numpy (+ openpyxl for the spreadsheets).  Depths are metres below the kelly bushing.
"""
from __future__ import annotations

import argparse
import json

import numpy as np

V_WATER = 1480.0

# Lithostratigraphic tops as the operator reported them: (name, key for the app, metres below the kelly bushing,
# two-way time in ms below mean sea level as printed in the report, or None).
TOPS = {
    "Nini-4": dict(
        source="Final well report Nini-4 and Nini-4A, DONG E&P, 1 July 2003 (GEUS file 25314), table 7.2",
        tops=[("Top Nordland Gp (sea bed)", "no", 96.8, None), ("Top Hordaland Gp", "ho", 509.6, 539.6),
              ("Top Horda Fm", "hd", 1701.8, 1592.0), ("Top Frigg Sand", "fs", 1771.9, 1663.8),
              ("Top Rogaland Gp (Balder Fm)", "ro", 1784.8, 1666.0), ("Top Chalk Gp", "sh", 1856.9, 1724.7)]),
    "Nini-5": dict(
        source="Final well report Nini-5, Nini-5A and Nini-5B, DONG Energy, 20 December 2007 (GEUS file 27397), table 3.6.4",
        tops=[("Top Hordaland Gp (Lark Fm)", "ho", 447.0, None), ("Top Horda Fm", "hd", 1617.0, 1509.0),
              ("Top Rogaland Gp (Balder Fm)", "ro", 1660.0, 1548.0), ("Top Chalk Gp", "sh", 1793.0, 1655.0)]),
}


def read_las(path):
    """LAS 2.0 -> {mnemonic: column}.  Mnemonic = the text before the first dot."""
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
    """CGG 'Computations' listing of Nini-4 -> rows (measured depth KB, vertical depth KB, vertical depth MSL, one-way ms below MSL)."""
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


def read_vsp_xlsx(path):
    """'Rig source VSP computations' sheet of Nini-5 -> the same rows.  A level row holds eleven numbers: receiver,
    measured depth, vertical depth, depth below datum, offset, picked time, vertical time, datum correction, vertical
    time from datum (s), average and RMS velocity."""
    import openpyxl
    rows = []
    for r in openpyxl.load_workbook(path, data_only=True, read_only=True).worksheets[0].iter_rows(values_only=True):
        v = [c for c in r if c is not None]
        if len(v) == 11 and all(isinstance(c, (int, float)) for c in v):
            rows.append((float(v[1]), float(v[2]), float(v[3]), 1000.0 * float(v[8])))
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


def rnd(arr, nd):
    return [None if not np.isfinite(v) else round(float(v), nd) for v in arr]


def build_well(name, las, dev, vsp, water_depth, field, about, vsp_about, package, xrd=None):
    """One well of the output file, from its merged logs, its deviation file and its VSP levels."""
    dev = read_las(dev)
    kb = -float(dev["TVD"][0])                                   # TVD is below sea level; the first row is the rotary table
    x, y = float(dev["UTMX"][0]), float(dev["UTMY"][0])
    drift = float(np.max(np.hypot(dev["UTMX"] - x, dev["UTMY"] - y)))
    stretch = float(np.max(np.abs(dev["MD"] - (dev["TVD"] + kb))))
    seabed_md = kb + water_depth

    logs = read_las(las)
    md = logs["DEPT"]
    dt = np.where((logs["DTCO"] > 40) & (logs["DTCO"] < 250), logs["DTCO"], np.nan)
    dts = np.where((logs["DTSM"] > 80) & (logs["DTSM"] < 800) & np.isfinite(dt), logs["DTSM"], np.nan)
    rho = np.where((logs["RHOZ"] > 1.5) & (logs["RHOZ"] < 3.1), logs["RHOZ"], np.nan)
    gr, rt = logs["GR"], np.where(logs["RT"] > 0, logs["RT"], np.nan)

    # ---- time-depth: the measured levels, joined by straight lines -------------
    if len(vsp) < 10:
        raise SystemExit("prep_nini.py: fewer than 10 VSP levels for %s" % name)
    z = np.array([r[0] for r in vsp])
    t2 = 2.0 * np.array([r[3] for r in vsp])
    if np.any(np.diff(z) <= 0) or np.any(np.diff(t2) <= 0):
        raise SystemExit("prep_nini.py: the VSP levels of %s are not increasing in depth and time" % name)
    v_last = 2000.0 * (z[-1] - z[-6]) / (t2[-1] - t2[-6])       # below the deepest level: the velocity over its last five intervals
    z_end = max(float(np.nanmax(md)), float(z[-1])) + 5.0
    td_md = np.concatenate([[kb, seabed_md], z, [z_end]])
    td_twt = np.concatenate([[0.0, 2000.0 * water_depth / V_WATER], t2, [t2[-1] + 2000.0 * (z_end - z[-1]) / v_last]])
    twt = lambda d: float(np.interp(d, td_md, td_twt))
    note = ("Rig-source vertical seismic profile of the well (%s): %d measured levels from %.0f to %.0f m, times vertical and "
            "below mean sea level, joined by straight lines. Above the first level only the sea bed (%.1f m of water at "
            "%.0f m/s) is used. Nothing is picked on the seismic and nothing is shifted." % (vsp_about, len(vsp), z[0], z[-1], water_depth, V_WATER))

    # ---- tops: the operator's, with the two-way time the report prints beside them as a check ----
    tops, tops_about = [], None
    if name in TOPS:
        check = []
        for label, key, top_md, t_report in TOPS[name]["tops"]:
            top = dict(name=label, key=key, md=top_md)
            if t_report is not None:
                top["twt_report"] = t_report
                check.append((key, twt(top_md) - t_report))
            tops.append(top)
        tops_about = "Tops as the operator reported them: %s." % TOPS[name]["source"]
        if check:
            near = [abs(c) for _, c in check if abs(c) <= 4.0]
            far = [(k, c) for k, c in check if abs(c) > 4.0]
            tops_about += (" The report prints a two-way time beside each top. The time-depth relation used here gives the same "
                           "time to within %.1f ms for %d of these %d tops" % (max(near) if near else 0.0, len(near), len(check)))
            tops_about += "." if not far else "; for %s it is %s." % (
                " and ".join(next(t["name"] for t in tops if t["key"] == k) for k, _ in far),
                " and ".join("%.0f ms %s" % (abs(c), "later" if c > 0 else "earlier") for _, c in far))
        hd = next((t for t in tops if t["key"] == "hd"), None)
        if hd is not None:
            st = step_in(md, gr, hd["md"] - 15.0, hd["md"] + 15.0)
            if st is not None:
                print("%s: largest gamma-ray step within 15 m of the reported top of the Horda Formation (%.1f m): %+.0f API at %.1f m"
                      % (name, hd["md"], st[1], st[0]))
        for t in tops:
            if t.get("twt_report") is not None:
                print("%s: %-28s %7.1f m   report %7.1f ms   this time-depth relation %7.1f ms   %+5.1f" % (
                    name, t["name"], t["md"], t["twt_report"], twt(t["md"]), twt(t["md"]) - t["twt_report"]))

    points = [dict(s, md=round(0.5 * (s["md_top"] + s["md_base"]), 2), twt=round(twt(0.5 * (s["md_top"] + s["md_base"])), 1))
              for s in (xrd or []) if s["smectite"] is not None]

    keep = (np.isfinite(gr) | np.isfinite(dt) | np.isfinite(rho)) & (md >= seabed_md)
    print("%s: KB %.1f m, wellhead (%.1f, %.1f), drift %.1f m, MD-TVD at most %.2f m; logs %.1f..%.1f m (sonic %d, shear %d, density %d); "
          "VSP %d levels %.0f..%.0f m, two-way %.1f..%.1f ms" % (name, kb, x, y, drift, stretch, md[keep][0], md[keep][-1], np.isfinite(dt).sum(),
                                                               np.isfinite(dts).sum(), np.isfinite(rho).sum(), len(vsp), z[0], z[-1], t2[0], t2[-1]))
    return dict(
        name=name, country="Denmark", field=field, epsg=23031, x=x, y=y, kb=round(kb, 2), seabed_md=round(seabed_md, 2),
        water_depth=water_depth,
        about=about + " Vertical to within %.0f m; measured depth and vertical depth differ by at most %.1f m." % (drift, stretch),
        md=rnd(md[keep], 3), curves=dict(gr=rnd(gr[keep], 2), dt=rnd(dt[keep], 3), dts=rnd(dts[keep], 3), rhob=rnd(rho[keep], 4), rdep=rnd(rt[keep], 4)),
        td=dict(kind="checkshot", label="Vertical seismic profile, %d measured levels" % len(vsp), md=rnd(td_md, 2), twt=rnd(td_twt, 2), note=note),
        tops=tops, tops_about=tops_about, points=points,
        points_about=("Smectite by X-ray diffraction on cuttings (depth interval) and core (one depth). GEUS Report 2022/31, "
                      "Appendix F: Schovsbo, Petersen, Weibel and Springer 2023, doi 10.22008/gpub/34666. The formation names "
                      "are the report's and follow a later lithostratigraphy than the operator's tops above.") if points else None,
        log_source="Free GEUS well package %s (merged wireline logs), GEUS terms for free Danish subsurface data" % package,
    )


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    for w in ("nini4", "nini5"):
        ap.add_argument("--%s-las" % w, default=None)
        ap.add_argument("--%s-dev" % w, default=None)
        ap.add_argument("--%s-vsp" % w, default=None)
    ap.add_argument("--xrd", default=None, help="Appendix_F_WP3_7_data.xlsx of GEUS Report 2022/31 (Nini-4 samples)")
    ap.add_argument("--nini4-water-depth", type=float, default=59.0, help="m; survey sheet of the VSP report and GEUS well data summary (59.0)")
    ap.add_argument("--nini5-water-depth", type=float, default=56.3, help="m; GEUS well data summary sheet (56.3)")
    ap.add_argument("--out", required=True)
    a = ap.parse_args(argv)

    wells = []
    if a.nini4_las:
        wells.append(build_well(
            "Nini-4", a.nini4_las, a.nini4_dev, read_vsp(a.nini4_vsp), a.nini4_water_depth, "Nini West",
            "Danish appraisal well of 2002 on the Nini West oil field, studied as a CO2 store in Project Greensand. Shown because it "
            "has what the open Norwegian wells in this app lack together: a shear sonic log, a vertical seismic profile and "
            "smectite measured on samples of the Eocene clay (the Horda Formation, pale greenish grey claystone in the operator's "
            "report).", "CGG, November 2002, in the free GEUS well package", "NINI-4", xrd=read_xrd(a.xrd) if a.xrd else None))
    if a.nini5_las:
        wells.append(build_well(
            "Nini-5", a.nini5_las, a.nini5_dev, read_vsp_xlsx(a.nini5_vsp), a.nini5_water_depth, "Nini East",
            "Danish appraisal well of 2007 on Nini East, 12 km north-east of Nini-4. It has a shear sonic log and a vertical seismic "
            "profile, but no smectite samples. The rock-mechanics tests published for this well (SINTEF 2009, GEUS file 35990) were "
            "made on Sele shale below the Horda Formation, not on the Horda clay.", "June 2007, in the free GEUS well package", "NINI-5"))
    if not wells:
        raise SystemExit("prep_nini.py: give the files of at least one well")
    sources = ["Logs, deviation, vertical seismic profiles and final well reports: free well packages %s, Geological Survey of Denmark and "
               "Greenland (GEUS)" % " and ".join("NINI-" + w["name"][-1] for w in wells),
               "Seismic: NODAB-97 3D (CGG 1997-1999), free seismic package of GEUS; all under GEUS's terms for free Danish subsurface data (2023-09-19)"]
    if any(w["points"] for w in wells):
        sources.append("Smectite and the formation names of the samples: GEUS Report 2022/31, Schovsbo et al. 2023, doi 10.22008/gpub/34666")
    with open(a.out, "w") as fh:
        json.dump(dict(sources=sources, wells=wells), fh, separators=(",", ":"))
    for w in wells:
        for p in w["points"]:
            print("xrd   : %-8s %-18s %7.1f-%7.1f m  %6.1f ms  smectite %5.1f %%" % (p["material"], p["formation"], p["md_top"], p["md_base"], p["twt"], p["smectite"]))
    print("wrote", a.out)


if __name__ == "__main__":
    main()
