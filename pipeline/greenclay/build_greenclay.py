"""Step 3: write data/greenclay.json for the app. Model: the Green Clay reaches from its top down to the top of the Rogaland
Group, and its thickness is a straight-line function of the thickness of the Hordaland Group (fitted to the report sites,
kept inside the range the sites cover). The fixed-height rule (the median over the sites) is kept as a comparison. Everything is recomputed here from gc_picks.csv, gc_mentions.csv,
the app's layer1/controls/wellbores files and FactPages. NP_DATA is the folder with the raw downloads."""
import csv, json, math, os, re, statistics, collections, datetime
import numpy as np
H = os.environ.get("NP_DATA", "/mnt/ssd/Data/force-hackathon-2026") + "/"
APP = os.environ.get("NP_APP", H + "natures-plug/")
G = H + "greenclay/"
km = lambda a, b, c, d: math.hypot((b - d) * 111.32 * math.cos(math.radians(a)), (a - c) * 110.57)
pos = {}
for f in ("factpages/wellbore_development_all.csv", "factpages/wellbore_exploration_all.csv"):
    for r in csv.DictReader(open(H + f, encoding="utf-8-sig")):
        if r.get("wlbNsDecDeg"): pos[r["wlbWellboreName"]] = (float(r["wlbNsDecDeg"]), float(r["wlbEwDecDeg"]), r.get("wlbField") or "")
def find(w):
    s = w
    for _ in range(4):
        if s in pos: return pos[s]
        s2 = re.sub(r"\s*T\d+$", "", s)
        if s2 == s and " " in s: s2 = re.sub(r"(\s[A-Z]+)?(Y\d)?H?$", "", s).strip()
        if s2 == s: break
        s = s2
L1all = json.load(open(APP + "data/layer1.json"))
L1 = [w for w in L1all if w.get("ho") and w.get("ro") and re.search(r"\d$", w["n"])]   # vertical exploration wells: MD is close to TVD
# --- report sites
sites = {}
for p in csv.DictReader(open(G + "gc_picks.csv")):
    q = find(p["wellbore"])
    if not q: continue
    la, lo, fld = q; tvd = float(p["tvd"])
    key = (round(la, 2), round(lo, 2), round(tvd / 20))
    sites.setdefault(key, dict(la=la, lo=lo, field=fld or "35/11 (Fram area)", tvd=tvd, wells=[], item=p["item"], file=p["filename"], page=int(p["page"]), text=p["text"]))["wells"].append(p["wellbore"])
S = []
for s in sites.values():
    d, w = min(((km(s["la"], s["lo"], w["la"], w["lo"]), w) for w in L1), key=lambda x: x[0])
    s.update(ref=w["n"], ref_km=round(d, 2), ho0=w["ho"][0], ro0=w["ro"][0], T=round(w["ro"][0] - s["tvd"], 1))
    f = (s["tvd"] - s["ho0"]) / (s["ro0"] - s["ho0"])
    s["ok"] = bool(d <= 6 and 0.05 < f < 0.98)
    if not s["ok"]: s["why"] = "reference well more than 6 km away" if d > 6 else "quoted depth is not inside the Hordaland Group of the reference well"
    S.append(s)
U = [s for s in S if s["ok"]]
RULE = float(np.median([s["T"] for s in U]))
def fit(tr):
    T = np.array([s["T"] for s in tr]); h = np.array([s["ro0"] - s["ho0"] for s in tr]); c = np.linalg.lstsq(np.c_[np.ones(len(h)), h], T, rcond=None)[0]
    return float(c[0]), float(c[1]), float(T.min()), float(T.max())
def line(m, hth): return min(hth, max(m[2], min(m[3], m[0] + m[1] * hth)))
MODEL = fit(U)
def cv(groups, drop_ref):
    out = collections.defaultdict(list)
    for g in groups:
        tr = [s for s in U if all(s is not t for t in g)]
        if drop_ref: tr = [s for s in tr if s["ref"] != g[0]["ref"]]
        T = np.array([s["T"] for s in tr]); m = fit(tr)
        for s in g:
            hth = s["ro0"] - s["ho0"]
            out["rule"].append((s, s["ro0"] - float(np.median(T))))
            out["line"].append((s, s["ro0"] - line(m, hth)))
            out["nearest"].append((s, s["ro0"] - min(tr, key=lambda t: km(s["la"], s["lo"], t["la"], t["lo"]))["T"]))
            out["middle"].append((s, s["ho0"] + 0.5 * hth))
    return out
fields = sorted({s["field"] for s in U})
by_site, by_field = cv([[s] for s in U], True), cv([[s for s in U if s["field"] == f] for f in fields], False)
stat = lambda v: dict(n=len(v), mae=round(float(np.mean(np.abs(v))), 1), bias=round(float(np.mean(v)), 1), p90=round(float(np.percentile(np.abs(v), 90)), 1))
CV = {name: {k: stat([p - s["tvd"] for s, p in v]) for k, v in o.items()} for name, o in (("site", by_site), ("field", by_field))}
for s, p in by_field["line"]: s["pred"] = round(p, 1); s["err"] = round(p - s["tvd"], 1)
MAE, P90 = CV["field"]["line"]["mae"], CV["field"]["line"]["p90"]
# --- where the unit is named in reports
ment = collections.Counter()
for r in csv.DictReader(open(G + "gc_mentions.csv")): ment[r["wellbore"]] += 1
named = [(find(w)[0], find(w)[1]) for w in ment if find(w)]
named_field = collections.Counter((find(w)[2] or "no field") for w in ment if find(w))
def near_named(la, lo): return min(km(la, lo, a, b) for a, b in named)
def near_site(la, lo): return min(km(la, lo, s["la"], s["lo"]) for s in U)
def predict(ho0, ro0):
    th = line(MODEL, ro0 - ho0)
    return round(ro0 - th), round(th)
# --- exploration wells with both group tops
ex = dict(n=[], la=[], lo=[], ho=[], ro=[], top=[], th=[], ks=[], kn=[], dev=[])
for w in L1all:
    if not (w.get("ho") and w.get("ro")): continue
    top, th = predict(w["ho"][0], w["ro"][0])
    for k, v in (("n", w["n"]), ("la", w["la"]), ("lo", w["lo"]), ("ho", w["ho"][0]), ("ro", w["ro"][0]), ("top", top), ("th", th),
                 ("ks", round(near_site(w["la"], w["lo"]), 1)), ("kn", round(near_named(w["la"], w["lo"]), 1)), ("dev", 0 if re.search(r"\d$", w["n"]) else 1)): ex[k].append(v)
# --- wellbores left to plug: take the nearest vertical exploration well within 10 km
wb = json.load(open(APP + "data/wellbores.json"))
WB = dict(top=[], th=[], ref=[], rk=[], kn=[], ks=[], own=[])
refnames = [w["n"] for w in L1]
for i, name in enumerate(wb["name"]):
    la, lo = wb["lat"][i], wb["lon"][i]
    d, j = min(((km(la, lo, w["la"], w["lo"]), j) for j, w in enumerate(L1)), key=lambda x: x[0])
    if d <= 10:
        top, th = predict(L1[j]["ho"][0], L1[j]["ro"][0]); WB["top"].append(top); WB["th"].append(th); WB["ref"].append(j); WB["rk"].append(round(d, 1))
    else:
        WB["top"].append(None); WB["th"].append(None); WB["ref"].append(None); WB["rk"].append(None)
    WB["kn"].append(round(near_named(la, lo), 1)); WB["ks"].append(round(near_site(la, lo), 1)); WB["own"].append(ment.get(name, 0))
cls = lambda top, kn: "none" if top is None else ("named" if kn <= 10 else "rule")
counts = collections.Counter(cls(t, k) for t, k in zip(WB["top"], WB["kn"]))
# --- log check: is the predicted interval the low-resistivity part of the Hordaland Group?
C = json.load(open(APP + "data/controls.json")); HB = list(range(-100, 801, 10)); profs = collections.defaultdict(list); chk = []
for c in C:
    g = {x[0]: x for x in c["groups"]}
    if "HORDALAND GP" not in g or "ROGALAND GP" not in g: continue
    ho0, ro0 = g["HORDALAND GP"][3], g["ROGALAND GP"][3]; tvd = np.array(c["tvd"], float); h = ro0 - tvd
    for k in ("gr", "rdep", "dtc"):
        v = np.array([np.nan if x is None else x for x in c[k]], float)
        if k == "rdep": v = np.log10(np.where(v > 0, v, np.nan))
        inH = (tvd >= ho0) & (tvd < ro0) & np.isfinite(v)
        if inH.sum() < 200: continue
        z = (v - v[inH].mean()) / (v[inH].std() + 1e-9)
        pr = []
        for a in HB:
            m = (h >= a) & (h < a + 10) & np.isfinite(z)
            pr.append(float(z[m].mean()) if m.any() and a <= ro0 - ho0 else np.nan)
        profs[k].append(pr)
        th = line(MODEL, ro0 - ho0)
        if k == "rdep" and ro0 - ho0 >= th + 150:
            lo_ = z[(h >= 0) & (h < th) & np.isfinite(z)]; up = z[(h >= th) & (h < min(th * 2, ro0 - ho0)) & np.isfinite(z)]
            if len(lo_) > 50 and len(up) > 50: chk.append((c["name"], float(lo_.mean() - up.mean())))
stack = {k: [None if not np.isfinite(x) else round(float(x), 3) for x in np.nanmedian(np.array(v), axis=0)] for k, v in profs.items()}
out = dict(
    built=datetime.datetime.now().isoformat(timespec="seconds"),
    rule=dict(height=RULE, a=round(MODEL[0], 1), b=round(MODEL[1], 4), tmin=MODEL[2], tmax=MODEL[3], mae=MAE, p90=P90, sites=len(U), sites_all=len(S), fields=len(fields), wellbores=sum(len(s["wells"]) for s in U),
              mentions=sum(ment.values()), named_wellbores=len(ment), named_field=named_field.most_common(12)),
    cv=CV, sites=S, ex=ex, wb=WB, refnames=refnames, counts=dict(counts),
    logs=dict(hb=HB, stack=stack, n={k: len(v) for k, v in profs.items()}, check=dict(n=len(chk), lower=sum(d < 0 for _, d in chk), median=round(float(np.median([d for _, d in chk])), 2))))
json.dump(out, open(APP + "data/greenclay.json", "w"), separators=(",", ":"), allow_nan=False)
print("model: thickness = %.0f + %.3f x Hordaland thickness, kept within %.0f-%.0f m" % MODEL); print("fixed height: %.0f m | sites %d of %d, fields %d | field-out MAE %.0f m, 90%% within %.0f m" % (RULE, len(U), len(S), len(fields), MAE, P90))
print("cv", json.dumps(CV)); print("wellbores left:", dict(counts), "| exploration wells:", len(ex["n"]))
print("log check: lower resistivity in the predicted interval in %d of %d log wells, median difference %.2f sd" % (out["logs"]["check"]["lower"], len(chk), out["logs"]["check"]["median"]))
print("named by field:", named_field.most_common(12)); print(os.path.getsize(APP + "data/greenclay.json"), "bytes")
