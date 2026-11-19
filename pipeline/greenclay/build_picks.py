"""Turn the mentions into one Top Green Clay depth per wellbore (m TVD below the rig floor where the report gives it).
Only explicit patterns are used; every pick keeps the file, page and text it came from. Output: gc_picks.csv."""
import csv, re, statistics, collections
import os
H = os.environ.get("NP_DATA", "/mnt/ssd/Data/force-hackathon-2026") + "/"
R = list(csv.DictReader(open(H + "greenclay/gc_mentions.csv")))
N = r"(\d{3,4}(?:[.,]\d)?)"
P = [("range", re.compile(r"^\W{0,4}(?:FM|Fm|Formation)?\W{0,4}" + N + r"\s*m?\s*-\s*" + N + r"\s*m?\s*\(\s*" + N + r"\s*m?\s*-\s*" + N + r"\s*m?\s*TVD", re.I)),
     ("md(tvd)", re.compile(r"^\W{0,4}(?:FM|Fm|Formation|formation)?\W{0,6}" + N + r"\s*m?\s*(?:MD|mMD)?\s*[\(/]\s*" + N + r"\s*m?\s*(?:TVD|mTVD)", re.I)),
     ("md/tvd", re.compile(r"^\W{0,3}" + N + r"\s*/\s*" + N + r"(?!\d)")),
     ("at tvd", re.compile(r"^.{0,30}?" + N + r"\s*m?\s*(?:TVD|mTVD)", re.I)),
     ("md md(tvd)", re.compile(r"^\W{0,4}" + N + r"\s*(?:m\s*)?MD\s*\(?\s*" + N + r"\s*(?:m\s*)?TVD", re.I))]
f = lambda s: float(s.replace(",", "."))
cand = collections.defaultdict(list)
for r in R:
    if r["base_word"] == "1": continue
    a = r["after"]
    if re.match(r"\W*(kick\s*off|marker\b)", a, re.I): continue   # a kick-off depth or a marker bed, not the top of the unit
    for name, p in P:
        m = p.search(a)
        if not m: continue
        g = [f(x) for x in m.groups()]
        md, tvd = (g[0], g[2]) if name == "range" else (g[0], g[1]) if len(g) == 2 else (None, g[0])
        if md is not None and not (tvd <= md + 1 and md - tvd < 2500): continue
        if not 500 <= tvd <= 2600: continue
        cand[r["wellbore"]].append((tvd, md, name, r["item"], r["filename"], r["page"], (r["before"][-40:] + " [Green Clay] " + a[:70])))
        break
w = csv.writer(open(H + "greenclay/gc_picks.csv", "w", newline=""))
w.writerow(["wellbore", "tvd", "md", "n_mentions", "spread_m", "pattern", "item", "filename", "page", "text"])
for wb, c in sorted(cand.items()):
    t = sorted(x[0] for x in c); med = statistics.median_low(t)
    best = min(c, key=lambda x: abs(x[0] - med))
    w.writerow([wb, best[0], best[1] if best[1] is not None else "", len(c), round(t[-1] - t[0], 1), best[2], best[3], best[4], best[5], best[6]])
print(len(cand), "wellbores with an explicit Top Green Clay depth")
