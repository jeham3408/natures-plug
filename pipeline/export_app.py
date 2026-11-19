"""Nature's Plug - export the static data files the web app loads.

The app does all screening itself (js/engine.js). This script only prepares inputs:
resampled logs, tops, leak-off tests, mud weights, wellbore lists, map geometry and report quotes.

Run on the machine that holds the raw downloads (see pipeline/README.md):
    NP_DATA=/path/to/raw uv run --with pandas --with pyarrow --with numpy --with shapely python export_app.py [out_dir]
"""
import csv, json, os, re, sys, collections, datetime, shutil
import numpy as np, pandas as pd
from shapely.geometry import shape, box, mapping
from shapely.ops import unary_union

csv.field_size_limit(10**9)
D = os.environ.get("NP_DATA", "./raw").rstrip("/") + "/"
OUT = (sys.argv[1] if len(sys.argv) > 1 else "../data").rstrip("/") + "/"
for sub in ("", "wells", "docs"):
    os.makedirs(OUT + sub, exist_ok=True)
for sub in ("wells", "docs"):
    for f in os.listdir(OUT + sub): os.remove(OUT + sub + "/" + f)

STEP = 0.152
OPEN_STATUS = ["PRODUCING", "CLOSED", "INJECTING", "ONLINE/OPERATIONAL", "PRODUCING/INJECTING", "SUSPENDED"]
SHALE_GROUPS = ["HORDALAND GP", "ROGALAND GP"]
OBM_KEYS = ["OIL", "OBM", "XP-07", "XP07", "VERSA", "ENVIROMUL", "CARBO", "INNOVERT", "RHELIANT", "RHEGUARD", "ANCO VERT",
            "INVERT", "SYNTH", "SBM", "PARADRIL", "PETROFREE", "NOVAPLUS", "NOVATEC", "ULTIDRIL", "ESTER", "PSEUDO", "ENCORE", "BARAECD", "EMS"]
UNKNOWN_MUD = ["DUMMY", "NOT REPORTED", "UNKNOWN", "OTHER"]
KNOWN_USE = {
    "EKOFISK": ["ConocoPhillips", "Best practice applied in the PP&A campaign on Ekofisk Alpha, concluded 2016", "Havtil 2025, ch. 6.1.2"],
    "VALHALL": ["BP Norge / Aker BP", "PP&A of the Valhall DP wells, 2015", "Havtil 2025, ch. 6.2.1"],
    "ULA": ["Aker BP", "Creeping shale as barrier in well construction", "Havtil 2025, ch. 6.2.2"],
    "IVAR AASEN": ["Aker BP", "Creeping shale as barrier in well construction", "Havtil 2025, ch. 6.2.2"],
    "BALDER": ["Vår Energi", "PP&A of wells in the Balder area, track record from three leak-off tested wells", "Havtil 2025, ch. 6.4"],
    "HULDRA": ["Equinor", "PP&A of wells in the Huldra field, 2016", "Havtil 2025, ch. 6.3.1"],
}
LITH = {30000: "Sandstone", 65030: "Sandstone/shale", 65000: "Shale", 80000: "Marl", 74000: "Dolomite", 70000: "Limestone", 70032: "Chalk",
        88000: "Halite", 86000: "Anhydrite", 99000: "Tuff", 90000: "Coal", 93000: "Basement"}


def mud_class(s):
    s = str(s).upper().strip()
    if not s or s == "NAN" or any(k in s for k in UNKNOWN_MUD): return "unknown"
    return "OBM" if any(k in s for k in OBM_KEYS) else "WBM"


def clean(o):
    if isinstance(o, dict): return {k: clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)): return [clean(v) for v in o]
    if isinstance(o, np.integer): return int(o)
    if isinstance(o, (np.floating, float)): return None if (o != o or o in (np.inf, -np.inf)) else float(o)
    if isinstance(o, np.bool_): return bool(o)
    return o


def dump(obj, path):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(clean(obj), f, ensure_ascii=False, separators=(",", ":"))
    return os.path.getsize(path)


def r1(v, n=1): return None if v is None or v != v else round(float(v), n)
def ri(v): return None if v is None or v != v else int(round(float(v)))
def safe(name): return re.sub(r"[^0-9A-Za-z-]+", "_", str(name)).strip("_")
def s_or_none(v): return v if isinstance(v, str) and v.strip() else None


# ------------------------------------------------------------------ load
logs = pd.read_parquet(D + "force2020/all_wells.parquet").replace(-999.25, np.nan)
exp = pd.read_csv(D + "factpages/wellbore_exploration_all.csv", encoding="utf-8-sig", low_memory=False)
dev = pd.read_csv(D + "factpages/wellbore_development_all.csv", encoding="utf-8-sig", low_memory=False)
top = pd.read_csv(D + "factpages/wellbore_formation_top.csv", encoding="utf-8-sig")
lot = pd.read_csv(D + "factpages/wellbore_casing_and_lot.csv", encoding="utf-8-sig")
mud = pd.read_csv(D + "factpages/wellbore_mud.csv", encoding="utf-8-sig")
fld = pd.read_csv(D + "factpages/field.csv", encoding="utf-8-sig")
for c in ("wlbCasingType", "wlbCasingDiameter", "wlbFormationTestType"): lot[c] = lot[c].astype(str).str.strip()
lot["emw"] = pd.to_numeric(lot.wlbLotMudDencity, errors="coerce")
mud["mw"] = pd.to_numeric(mud.wlbMudWeightAtMD, errors="coerce"); mud["cls"] = mud.wlbMudType.map(mud_class)
mudv = mud[(mud.mw > 1.0) & (mud.mw < 2.4)]
expi = exp.drop_duplicates("wlbWellboreName").set_index("wlbWellboreName")
tops_by = {w: t for w, t in top.groupby("wlbName")}
lot_by = {w: t.sort_values("wlbCasingDepth") for w, t in lot.groupby("wlbName")}
mud_by = {w: t.sort_values("wlbMD") for w, t in mudv.groupby("wlbName")}
mudall_by = {w: t.sort_values("wlbMD") for w, t in mud.groupby("wlbName")}

ns = lambda s: re.sub(r"\s+", "", str(s).upper())
fp_ns = {ns(n): n for n in set(top.wlbName.dropna()) | set(exp.wlbWellboreName.dropna())}
def match(w):
    k = ns(w)
    if k in fp_ns: return fp_ns[k]
    for kk in (k, re.sub(r"T(\d)$", r"ST\1", k)):
        c = [n for q, n in fp_ns.items() if kk.startswith(q)]
        if c: return max(c, key=len)
    return None
logs["FP"] = logs.WELL.map({w: match(w) for w in logs.WELL.unique()})
logs = logs[logs.FP.notna()].copy()
logs["MD"] = logs.DEPTH_MD.fillna(logs.DEPT)


def zones_for(w):
    """Named hydrocarbon-bearing formations with a top (FactPages), shallowest first, with mud weight at the top."""
    if w not in expi.index: return []
    e = expi.loc[w]
    names = [str(e.get(c)).strip().upper() for c in ("wlbFormationWithHc1", "wlbFormationWithHc2", "wlbFormationWithHc3") if isinstance(e.get(c), str)]
    t = tops_by.get(w); m = mud_by.get(w)
    if t is None or not names: return []
    th = t[t.lsuName.str.upper().isin(names) & (t.lsuName != "NO FORMAL NAME")].sort_values("lsuTopDepth").drop_duplicates("lsuName")
    out = []
    for r in th.itertuples():
        mw = float(np.interp(r.lsuTopDepth, m.wlbMD.values, m.mw.values)) if m is not None and len(m) >= 2 else None
        out.append([r.lsuName, float(r.lsuTopDepth), mw])
    return out


def mud_in_shale(w, g):
    ma = mudall_by.get(w); sh = g[g.lsuName.isin(SHALE_GROUPS)]
    if ma is None or not len(sh): return "unknown"
    x = ma[(ma.wlbMD >= sh.lsuTopDepth.min()) & (ma.wlbMD <= sh.lsuBottomDepth.max()) & (ma.cls != "unknown")]
    return "unknown" if x.empty else "WBM" if (x.cls == "WBM").all() else "OBM" if (x.cls == "OBM").all() else "mixed"


# ------------------------------------------------------------------ report quotes
hits = pd.read_csv(D + "derived/doc_hits.csv", dtype=str, keep_default_na=False)
def kind(k):
    k = k.lower()
    if k.startswith(("gumbo", "swelling", "plastic", "mobile", "squeez", "creep", "hole")): return 0   # clay-specific
    if k.startswith("tight"): return 1
    if k.startswith("slough"): return 2
    return 3                                                                                           # overpull, reaming
hits["kind"] = hits.kw.map(kind)
hits["has_depth"] = hits.depths_m != ""
hits["shale"] = hits.in_shale == "True"
hits = hits.sort_values(["wellbore", "kind", "shale", "has_depth", "filename", "page"], ascending=[True, True, False, False, True, True])
hits_by = {w: t for w, t in hits.groupby("wellbore", sort=False)}
pa = pd.read_csv(D + "diskos/pa_hits.csv", dtype=str, keep_default_na=False)
def pa_rank(k):
    k = k.lower()
    if "bond" in k or k in ("cbl", "usit"): return 0
    if "cement" in k and "top" in k or k == "toc": return 1
    if "plug" in k or "abandon" in k or "p&a" in k.replace(" ", ""): return 2
    return 3
pa["rank"] = pa.kw.map(pa_rank); pa["n"] = pa.n_matches.astype(int)
pa = pa.sort_values(["wellbore", "rank", "n"], ascending=[True, True, False])
pa_by = {w: t for w, t in pa.groupby("wellbore", sort=False)}
files = pd.read_csv(D + "diskos/diskos_files.csv", dtype=str, keep_default_na=False)
for c in ("pages", "pa_pages", "creep_hits"): files[c] = files[c].astype(int)
fb = files.groupby("wellbore").agg(files=("filename", "size"), pages=("pages", "sum"), pa_pages=("pa_pages", "sum"))
hcount = hits.groupby("wellbore").agg(hits=("kw", "size"), clay=("kind", lambda s: int((s == 0).sum())), shale=("shale", "sum"))


def doc_summary(w):
    if w not in fb.index: return None
    return [int(fb.files[w]), int(fb.pages[w]), int(fb.pa_pages[w]), int(hcount.hits.get(w, 0)), int(hcount.clay.get(w, 0)), int(hcount.shale.get(w, 0))]


def doc_payload(w, nh=30, npa=15):
    t = hits_by.get(w); p = pa_by.get(w); seen = set(); hs = []
    if t is not None:
        for r in t.itertuples():
            key = (r.filename, r.page, r.kw.split()[0])
            if key in seen: continue
            seen.add(key)
            hs.append(dict(k=r.kw, c=int(r.kind), d=[int(x) for x in r.depths_m.split(";") if x][:6], g=[x for x in r.groups.split(";") if x], t=r.item, f=r.filename, p=int(r.page), s=r.snippet[:420]))
            if len(hs) >= nh: break
    ps = []
    if p is not None:
        for r in p.head(npa).itertuples(): ps.append(dict(k=r.kw, t=r.item, f=r.filename, p=int(r.page), s=r.snippet[:360]))
    return dict(name=w, summary=doc_summary(w), hits=hs, pa=ps)


# ------------------------------------------------------------------ control wells (logs)
controls = []; sizes = collections.Counter()
for w, d in logs.groupby("FP"):
    d = d.sort_values("MD").reset_index(drop=True)
    e = expi.loc[w] if w in expi.index else None
    md = d.MD.values; zl = d.Z_LOC.values; okz = ~np.isnan(zl)
    kb = float(e.wlbKellyBushElevation) if e is not None and pd.notna(e.wlbKellyBushElevation) else float(md[okz][0] + zl[okz][0])
    tk = kb - zl[okz]; mk = md[okz]
    def md2tvd(x, mk=mk, tk=tk):
        x = np.asarray(x, dtype=float); y = np.interp(x, mk, tk)
        k = max(2, min(len(mk) - 1, int(50 / STEP)))
        slope = float(np.clip((tk[-1] - tk[-k]) / max(1e-6, mk[-1] - mk[-k]), 0.3, 1.0))
        y = np.where(x < mk[0], tk[0] - (mk[0] - x), y)
        return np.where(x > mk[-1], tk[-1] + (x - mk[-1]) * slope, y)
    t = tops_by.get(w, top.iloc[0:0])
    g = t[t.lsuLevel == "GROUP"].sort_values("lsuTopDepth"); f = t[t.lsuLevel == "FORMATION"].sort_values("lsuTopDepth")
    zs = zones_for(w)
    la = lot_by.get(w, lot.iloc[0:0]); lv = la[la.emw > 1.0]
    # 1 m bins over the whole logged interval
    b0 = int(np.floor(md.min())); b1 = int(np.floor(md.max()))
    d["bin"] = np.floor(md).astype(int)
    agg = d.groupby("bin").agg(GR=("GR", "median"), RDEP=("RDEP", "median"), RMED=("RMED", "median"), DTC=("DTC", "median"), RHOB=("RHOB", "median"), NPHI=("NPHI", "median"),
                               CALI=("CALI", "median"), BS=("BS", "median"), LITH=("FORCE_2020_LITHOFACIES_LITHOLOGY", lambda s: s.mode().iat[0] if s.notna().any() else np.nan))
    agg = agg.reindex(range(b0, b1 + 1))
    centers = np.arange(b0, b1 + 1) + 0.5; tvd = md2tvd(centers)
    def arr(col, n): return [r1(v, n) for v in agg[col].values]
    groups = [[r.lsuName, float(r.lsuTopDepth), float(r.lsuBottomDepth), r1(md2tvd([r.lsuTopDepth])[0]), r1(md2tvd([r.lsuBottomDepth])[0])] for r in g.itertuples()]
    zones = [[n, zt, r1(md2tvd([zt])[0]), r1(mw, 3)] for n, zt, mw in zs]
    lots = [[float(r.wlbCasingDepth), r1(md2tvd([r.wlbCasingDepth])[0]), float(r.emw), r.wlbFormationTestType or "LOT"] for r in lv.itertuples()]
    deep = [z[1] for z in zones] + [r.lsuBottomDepth for r in g.itertuples() if r.lsuName in SHALE_GROUPS]
    cut = int(min(b1, (max(deep) + 30) if deep else b1))
    ncut = max(1, cut - b0 + 1)
    meta = dict(id=safe(w), name=w, lat=r1(e.wlbNsDecDeg, 5) if e is not None else None, lon=r1(e.wlbEwDecDeg, 5) if e is not None else None, kb=r1(kb),
                wd=r1(e.wlbWaterDepth) if e is not None else None, td=r1(e.wlbTotalDepth) if e is not None else None, incl=r1(e.wlbMaxInclation) if e is not None else None,
                year=ri(e.wlbCompletionYear) if e is not None else None, operator=s_or_none(e.wlbDrillingOperator) if e is not None else None,
                content=s_or_none(e.wlbContent) if e is not None else None, field=s_or_none(e.wlbField) if e is not None else None,
                npdid=ri(e.wlbNpdidWellbore) if e is not None else None, mud=mud_in_shale(w, g), groups=groups, zones=zones, lot=lots, docs=doc_summary(w))
    controls.append(dict(meta, a0=b0 + 0.5, n=ncut, tvd=[r1(v) for v in tvd[:ncut]], gr=[ri(v) for v in agg.GR.values[:ncut]],
                         rdep=[r1(v, 2) for v in agg.RDEP.values[:ncut]], dtc=[ri(v) for v in agg.DTC.values[:ncut]]))
    casing = [dict(type=r.wlbCasingType, dia=r.wlbCasingDiameter, md=float(r.wlbCasingDepth), tvd=r1(md2tvd([r.wlbCasingDepth])[0]), emw=float(r.emw) if r.emw == r.emw and r.emw > 1.0 else None,
                   test=r.wlbFormationTestType or None) for r in la.itertuples() if pd.notna(r.wlbCasingDepth)]
    ma = mudall_by.get(w, mud.iloc[0:0])
    muds = [[float(r.wlbMD), r1(r.mw, 2) if r.mw == r.mw and r.mw > 0 else None, str(r.wlbMudType).strip(), r.cls] for r in ma.itertuples() if pd.notna(r.wlbMD)]
    detail = dict(meta, formations=[[r.lsuName, float(r.lsuTopDepth), float(r.lsuBottomDepth)] for r in f.itertuples()], casing=casing, mudlist=muds,
                  a0=b0 + 0.5, n=len(centers), tvd=[r1(v) for v in tvd], gr=arr("GR", 1), rdep=arr("RDEP", 3), rmed=arr("RMED", 3), dtc=arr("DTC", 1), rhob=arr("RHOB", 3),
                  nphi=arr("NPHI", 3), cali=arr("CALI", 2), bs=arr("BS", 2), lith=[ri(v) for v in agg.LITH.values], quotes=doc_payload(w, 60, 20))
    for k in ("rmed", "dtc", "rhob", "nphi", "cali", "bs", "lith"):
        if all(v is None for v in detail[k]): detail[k] = None
    sizes["wells"] += dump(detail, OUT + "wells/" + safe(w) + ".json")
controls.sort(key=lambda c: c["name"])
sizes["controls"] = dump(controls, OUT + "controls.json")
ctl_names = {c["name"] for c in controls}

# ------------------------------------------------------------------ layer 1: exploration wells with group tops
grp_all = top[top.lsuLevel == "GROUP"]
KEYS = {"NORDLAND GP": "no", "HORDALAND GP": "ho", "ROGALAND GP": "ro", "SHETLAND GP": "sh", "CROMER KNOLL GP": "ck", "VIKING GP": "vi"}
layer1 = []; docs_written = set()
for w in sorted(set(grp_all.wlbName) & set(expi.index)):
    e = expi.loc[w]; g = grp_all[grp_all.wlbName == w]
    if pd.isna(e.wlbNsDecDeg): continue
    ratio = 1.0
    if pd.notna(e.wlbFinalVerticalDepth) and pd.notna(e.wlbTotalDepth) and e.wlbTotalDepth > 0:
        r0 = float(e.wlbFinalVerticalDepth) / float(e.wlbTotalDepth)
        if 0.5 < r0 <= 1.0: ratio = r0
    row = dict(n=w, la=r1(e.wlbNsDecDeg, 5), lo=r1(e.wlbEwDecDeg, 5), y=ri(e.wlbCompletionYear), r=round(ratio, 3), c=s_or_none(e.wlbContent), f=s_or_none(e.wlbField), id=ri(e.wlbNpdidWellbore))
    for gn, key in KEYS.items():
        x = g[g.lsuName == gn]
        if len(x): row[key] = [float(x.lsuTopDepth.min()), float(x.lsuBottomDepth.max())]
    la = lot_by.get(w)
    row["lot"] = [[float(r.wlbCasingDepth), float(r.emw)] for r in la.itertuples() if r.emw == r.emw and r.emw > 1.0] if la is not None else []
    row["z"] = [[n, zt, r1(mw, 3)] for n, zt, mw in zones_for(w)]
    row["mud"] = mud_in_shale(w, g)
    row["d"] = doc_summary(w)
    row["lg"] = 1 if w in ctl_names else 0
    layer1.append(row)
    if row["d"] and w not in ctl_names:
        sizes["docs"] += dump(doc_payload(w), OUT + "docs/" + safe(w) + ".json"); docs_written.add(w)
sizes["layer1"] = dump(layer1, OUT + "layer1.json")

# ------------------------------------------------------------------ wellbores left to plug
todo = dev[dev.wlbStatus.isin(OPEN_STATUS) & dev.wlbNsDecDeg.notna()].copy().reset_index(drop=True)
def idx_list(series):
    vals = sorted({v for v in series if isinstance(v, str) and v.strip()}); m = {v: i for i, v in enumerate(vals)}
    return vals, [m.get(v, -1) if isinstance(v, str) else -1 for v in series]
fields_l, fi = idx_list(todo.wlbField); status_l, si = idx_list(todo.wlbStatus); purpose_l, pi = idx_list(todo.wlbPurpose)
content_l, ci = idx_list(todo.wlbContent); oper_l, oi = idx_list(todo.wlbDrillingOperator)
wb = dict(fields=fields_l, statuses=status_l, purposes=purpose_l, contents=content_l, operators=oper_l,
          name=todo.wlbWellboreName.tolist(), field=fi, status=si, purpose=pi, content=ci, operator=oi,
          subsea=[1 if str(v).upper() == "YES" else 0 for v in todo.wlbSubSea], year=[ri(v) for v in todo.wlbCompletionYear],
          lat=[r1(v, 5) for v in todo.wlbNsDecDeg], lon=[r1(v, 5) for v in todo.wlbEwDecDeg], tvd=[ri(v) for v in todo.wlbFinalVerticalDepth], md=[ri(v) for v in todo.wlbTotalDepth],
          wd=[ri(v) for v in todo.wlbWaterDepth], npdid=[ri(v) for v in todo.wlbNpdidWellbore], docs=[doc_summary(w) for w in todo.wlbWellboreName])
sizes["wellbores"] = dump(wb, OUT + "wellbores.json")
for w in todo.wlbWellboreName:
    if w in fb.index and w not in docs_written:
        sizes["docs"] += dump(doc_payload(w), OUT + "docs/" + safe(w) + ".json"); docs_written.add(w)

# ------------------------------------------------------------------ map geometry
def rings(geom, tol, minarea=0.0):
    geom = geom.simplify(tol, preserve_topology=True)
    polys = [geom] if geom.geom_type == "Polygon" else list(getattr(geom, "geoms", []))
    out = []
    for p in polys:
        if p.geom_type != "Polygon" or p.is_empty or p.area < minarea: continue
        out.append([[round(x, 4), round(y, 4)] for x, y in p.exterior.coords])
    return out
BBOX = box(-6.0, 53.0, 36.0, 76.0)
land = json.load(open(D + "geo/ne_10m_land.geojson"))
parts = []
for ft in land["features"]:
    gm = shape(ft["geometry"])
    if gm.intersects(BBOX): parts.append(gm.intersection(BBOX))
land_rings = rings(unary_union(parts), 0.008, 0.0004)
fgeo = json.load(open(D + "geo/fields.geojson"))
fmeta = fld.drop_duplicates("fldName").set_index("fldName")
left = todo.wlbField.value_counts()
fields_out = []; seen = set()
for ft in fgeo["features"]:
    p = ft["properties"]; name = p["fldName"]; gm = shape(ft["geometry"]) if ft["geometry"] else None
    if gm is None: continue
    rr = rings(gm, 0.0015)
    if name in seen:
        next(x for x in fields_out if x["name"] == name)["rings"].extend(rr); continue
    seen.add(name); c = gm.representative_point(); b = gm.bounds
    fields_out.append(dict(name=name, operator=p.get("cmpLongName"), activity=p.get("fldCurrentActivitySatus"), hc=p.get("fldHcType"), area=p.get("fldMainArea"),
                           year=p.get("fldDiscoveryYear"), npdid=p.get("fldNpdidField"), left=int(left.get(name, 0)), use=KNOWN_USE.get(name),
                           c=[round(c.x, 4), round(c.y, 4)], bbox=[round(v, 4) for v in b], rings=rr))
for name in fields_l:
    if name not in seen:
        s = todo[todo.wlbField == name]; m = fmeta.loc[name] if name in fmeta.index else None
        fields_out.append(dict(name=name, operator=m.cmpLongName if m is not None else None, activity=m.fldCurrentActivitySatus if m is not None else None,
                               hc=m.fldHcType if m is not None else None, area=s.wlbMainArea.mode().iat[0], year=None, npdid=ri(m.fldNpdidField) if m is not None else None,
                               left=int(len(s)), use=KNOWN_USE.get(name), c=[round(float(s.wlbEwDecDeg.median()), 4), round(float(s.wlbNsDecDeg.median()), 4)],
                               bbox=[round(float(s.wlbEwDecDeg.min()), 4), round(float(s.wlbNsDecDeg.min()), 4), round(float(s.wlbEwDecDeg.max()), 4), round(float(s.wlbNsDecDeg.max()), 4)], rings=[]))
sizes["fields"] = dump(fields_out, OUT + "fields.json")
quads = []
for ft in json.load(open(D + "geo/quadrants.geojson"))["features"]:
    if not ft["geometry"]: continue
    b = shape(ft["geometry"]).bounds; quads.append([ft["properties"]["qadName"], round(b[0], 3), round(b[1], 3), round(b[2], 3), round(b[3], 3)])
co2 = []
for ft in json.load(open(D + "geo/co2_licences.geojson"))["features"]:
    if not ft["geometry"]: continue
    p = ft["properties"]; co2.append(dict(name=p.get("baaName"), operator=p.get("cmpLongName"), rings=rings(shape(ft["geometry"]), 0.003)))
sizes["geo"] = dump(dict(land=land_rings, quadrants=quads, co2=co2), OUT + "geo.json")

# ------------------------------------------------------------------ validation + meta
rates = json.load(open(D + "derived/doc_hits_rate_by_group.json"))
sizes["validation"] = dump(dict(documented_use=KNOWN_USE, doc_rates=rates,
                                doc_totals=dict(pages=int(files.pages.sum()), files=int(len(files)), wellbores=int(files.wellbore.nunique()), hits=int(len(hits)),
                                                clay_hits=int((hits.kind == 0).sum()), pa_pages=int(len(pa)))), OUT + "validation.json")
sizes["meta"] = dump(dict(built=datetime.datetime.now().isoformat(timespec="seconds"), factpages_date="2026-11-17", lith=LITH,
                          defaults=dict(rdepMax=1.3, grMin=40, dtcMin=135, gas=0.2, overbalance=0.05, ppFloor=1.03, minLen=30, strongLen=50, radiusKm=10, bridge=0, formationMin=50),
                          counts=dict(wellbores=len(todo), controls=len(controls), layer1=len(layer1), fields=len(fields_out), docs=len(docs_written)),
                          sources=[["FORCE 2020 well log and lithofacies dataset", "https://zenodo.org/records/4351156", "CC BY 4.0"],
                                   ["FactPages and FactMaps, Norwegian Offshore Directorate", "https://factpages.sodir.no/", "NLOD 2.0"],
                                   ["Diskos report texts, FORCE", "https://zenodo.org/records/10775273", "CC BY 4.0"],
                                   ["Natural Earth land polygons", "https://www.naturalearthdata.com/", "Public domain"]]), OUT + "meta.json")
print({k: round(v / 1e6, 2) for k, v in sizes.items()}, "MB | total", round(sum(sizes.values()) / 1e6, 1), "MB")
print("controls:", len(controls), "| with zones:", sum(1 for c in controls if c["zones"]), "| layer1:", len(layer1), "| wellbores:", len(todo), "| docs files:", len(docs_written), "| land rings:", len(land_rings), "| fields with outline:", sum(1 for f in fields_out if f["rings"]), "of", len(fields_out), "| quadrants:", len(quads), "| co2:", len(co2))
