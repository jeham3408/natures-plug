"""Find every place a public well report names the informal unit "Green Clay" and pull out the depths quoted beside it.
Output: gc_mentions.csv, one row per mention, with the numbers that follow and the text around it."""
import sqlite3, re, csv, os
import os
H = os.environ.get("NP_DATA", "/mnt/ssd/Data/force-hackathon-2026") + "/"
con = sqlite3.connect(f"file:{H}diskos/diskos.sqlite?mode=ro", uri=True)
rows = con.execute("select p.wellbore, p.wtype, p.item, p.filename, p.page, p.content from pages_fts join pages p on p.id=pages_fts.rowid where pages_fts match ?",
                   ('"green clay" OR "green clays"',)).fetchall()
pat = re.compile(r"(.{0,80})\b(Green\s+Clays?|GREEN\s+CLAYS?)\b(?!\s*stone)(.{0,90})", re.S)
num = re.compile(r"(?<![\d.,/])(\d{3,4})(?:[.,]\d)?(?![\d/\"]|\s*(?:ms|msec|psi|bar|sg|ppg|%|l/min|lpm|m3|kN|rpm))")
out = csv.writer(open(H + "greenclay/gc_mentions.csv", "w", newline=""))
out.writerow(["wellbore", "wtype", "item", "filename", "page", "top_word", "base_word", "numbers", "before", "after"])
n = 0
for w, wt, item, fn, pg, c in rows:
    for m in pat.finditer(c):
        b, g, a = (" ".join(x.split()) for x in m.groups())
        topw = int(bool(re.search(r"(?i)\b(top|t\.|tgc|bolig)\W*$", b[-12:])) or bool(re.match(r"(?i)\W*(top|@|at\b|:)", a[:8])))
        basew = int(bool(re.search(r"(?i)\b(base|b\.|bottom)\W*(of\s+)?(the\s+)?$", b[-16:])))
        nums = [int(x) for x in num.findall(a[:60]) if 300 <= int(x) <= 3500]
        out.writerow([w, wt, item, fn, pg, topw, basew, " ".join(map(str, nums)), b[-80:], a[:90]]); n += 1
print(n, "mentions")
