"""Turn the keyword hits from index_diskos.py into evidence the app can show.

For every hit: parse depths quoted in metres, and for exploration wells look up which stratigraphic group each depth
falls in (FactPages formation tops). Also counts mentions per kilometre of formation drilled, by kind of keyword.
Outputs (in derived/): doc_hits.csv, doc_hits_rate_by_group.json
    NP_DATA=/path/to/raw uv run --with pandas python docs_evidence.py
"""
import collections, json, os, re
import pandas as pd

D = os.environ.get("NP_DATA", "./raw").rstrip("/") + "/"
os.makedirs(D + "derived", exist_ok=True)
top = pd.read_csv(D + "factpages/wellbore_formation_top.csv", encoding="utf-8-sig")
grp = top[top.lsuLevel == "GROUP"]
tops = {w: t[["lsuName", "lsuTopDepth", "lsuBottomDepth"]].values.tolist() for w, t in grp.groupby("wlbName")}
num = re.compile(r"(?<![\d.,])(\d{3,4})(?:[.,]\d)?\s*(?:m\b|mrkb|m rkb|m md|meters|metres)", re.I)
SHALE = {"HORDALAND GP", "ROGALAND GP"}

hits = pd.read_csv(D + "diskos/creep_hits.csv", dtype=str, keep_default_na=False)
files = pd.read_csv(D + "diskos/diskos_files.csv", dtype=str, keep_default_na=False)


def parse(row):
    ds = sorted({int(x) for x in num.findall(row.snippet) if 150 <= int(x) <= 6500})
    t = tops.get(row.wellbore); gs = []
    if t and ds:
        for d in ds:
            for n, a, b in t:
                if a <= d < b and n not in gs: gs.append(n)
    return ";".join(map(str, ds)), ";".join(gs), bool(set(gs) & SHALE)


p = [parse(r) for r in hits.itertuples()]
hits["depths_m"] = [x[0] for x in p]; hits["groups"] = [x[1] for x in p]; hits["in_shale"] = [x[2] for x in p]
hits["strong"] = ~hits.kw.str.startswith("overpull")
hits.to_csv(D + "derived/doc_hits.csv", index=False)
print("hits:", len(hits), "| wellbores:", hits.wellbore.nunique(), "| with depth:", int((hits.depths_m != "").sum()), "| with group:", int((hits.groups != "").sum()))


def kind(k):
    k = k.lower()
    if k.startswith(("gumbo", "swelling", "plastic", "mobile", "squeez", "creep", "hole")): return "clay"
    if k.startswith("tight"): return "tight"
    if k.startswith("slough"): return "slough"
    return "overpull"


hits["c"] = hits.kw.map(kind)
have = set(files.wellbore)
gg = grp[grp.wlbName.isin(have)]
thick = (gg.lsuBottomDepth - gg.lsuTopDepth).clip(lower=0).groupby(gg.lsuName).sum() / 1000.0
rows = []
hg = hits[hits.groups != ""]
for c in ["clay", "tight", "overpull"]:
    cnt = collections.Counter(); wl = collections.defaultdict(set)
    for r in hg[hg.c == c].itertuples():
        for x in r.groups.split(";"): cnt[x] += 1; wl[x].add(r.wellbore)
    for x, n in cnt.items():
        if thick.get(x, 0) > 20: rows.append(dict(kind=c, group=x, mentions=n, km=round(float(thick[x]), 1), per_km=round(n / float(thick[x]), 2), wells=len(wl[x])))
json.dump(rows, open(D + "derived/doc_hits_rate_by_group.json", "w"))
for r in sorted((r for r in rows if r["kind"] == "clay"), key=lambda r: -r["per_km"])[:6]: print(" ", r)
