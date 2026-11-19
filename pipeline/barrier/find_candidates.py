"""Find report pages that may describe clay or 'formation' used as an annular well barrier. Output: barrier/candidates.json
(one text window per distinct passage). The passages are then read and classified by hand into barrier_cases.csv."""
import sqlite3, re, json, os
H = os.environ.get("NP_DATA", "/mnt/ssd/Data/force-hackathon-2026") + "/"
con = sqlite3.connect(f"file:{H}diskos/diskos.sqlite?mode=ro", uri=True)
Q1 = ('"formation as barrier" OR "formation as a barrier" OR "shale as barrier" OR "shale as a barrier" OR "creeping shale" OR "creeping formation" OR "formation barrier" '
      'OR "collapsed formation" OR "formation collapse" OR "collapsed shale" OR "shale collapse" OR "formation bond" OR "formation bonding" OR "shale bond" OR "shale bonding" '
      'OR "formation as annular" OR "formation sealing" OR "displaced formation" OR "squeezing shale" OR "squeezing formation" OR "formation creep" OR "shale creep" OR "natural barrier" '
      'OR "formation as well barrier" OR "formation as a well barrier"')
K1 = re.compile(r"(?i)(formation|shale)\s+(as\s+(a\s+)?(well\s+|annular\s+)?barrier|barrier|collapse|bond(ing)?|creep|sealing)|(collapsed|creeping|displaced|squeezing)\s+(formation|shale)|natural barrier")
N1 = re.compile(r"(?i)barrier|qualif|P&A|plug|abandon|bond log|CBL|USIT|annul|behind (the )?casing|casing")
Q2 = ('NEAR(barrier hordaland, 10) OR NEAR(barrier shetland, 10) OR NEAR(barrier rogaland, 10) OR NEAR(barrier nordland, 10) OR NEAR(qualif* formation barrier, 12) '
      'OR NEAR(qualif* shale barrier, 12) OR NEAR(barrier shale collaps*, 12) OR NEAR(shale bond* casing, 8) OR NEAR(formation "good bond" barrier, 15)')
K2 = re.compile(r"(?i)barrier"); N2 = re.compile(r"(?i)hordaland|shetland|rogaland|nordland|shale|formation collaps|qualif")
out, seen = [], set()
for q, key, need in ((Q1, K1, N1), (Q2, K2, N2)):
    for w, wt, item, fn, pg, c in con.execute("select p.wellbore, p.wtype, p.item, p.filename, p.page, p.content from pages_fts join pages p on p.id=pages_fts.rowid where pages_fts match ?", (q,)):
        t = " ".join(c.split())
        for m in key.finditer(t):
            a = max(0, m.start() - 330); ctx = t[a:m.end() + 330]
            if not need.search(ctx): continue
            sig = re.sub(r"\W+", "", ctx[200:420]).lower()[:120]
            if sig in seen: continue
            seen.add(sig); out.append(dict(w=w, wt=wt, item=item, file=fn, page=pg, hit=m.group(0), ctx=ctx)); break
out.sort(key=lambda o: (o["w"], o["page"]))
os.makedirs(H + "barrier", exist_ok=True); json.dump(out, open(H + "barrier/candidates.json", "w"))
print(len(out), "passages in", len({o["w"] for o in out}), "wellbores")
