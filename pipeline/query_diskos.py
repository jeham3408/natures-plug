#!/usr/bin/env python3
"""Search the Diskos report texts (SQLite + FTS5).

  python3 query_diskos.py '"tight hole"' --well 34/8-1
  python3 query_diskos.py 'cement AND plug* AND abandon*' --type DEVELOPMENT --limit 20
  python3 query_diskos.py --well 31/4-5 --item COMPLETION_REPORT --limit 5 --full
FTS5 syntax: "exact phrase", AND / OR / NOT, prefix*  NEAR(a b, 10)
"""
import argparse, os, sqlite3, textwrap
ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("query", nargs="?"); ap.add_argument("--well"); ap.add_argument("--type"); ap.add_argument("--item")
ap.add_argument("--limit", type=int, default=15); ap.add_argument("--full", action="store_true")
a = ap.parse_args()
DB = os.path.join(os.environ.get("NP_DATA", "./raw"), "diskos", "diskos.sqlite")
con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
args = []
if a.query:
    sql = "select p.wellbore, p.item, p.filename, p.page, snippet(pages_fts, 0, '[', ']', ' ... ', 48), p.content from pages_fts join pages p on p.id = pages_fts.rowid where pages_fts match ?"; args.append(a.query)
else:
    sql = "select p.wellbore, p.item, p.filename, p.page, substr(p.content, 1, 400), p.content from pages p where 1=1"
if a.well: sql += " and p.wellbore = ?"; args.append(a.well)
if a.type: sql += " and p.wtype = ?"; args.append(a.type.upper())
if a.item: sql += " and p.item = ?"; args.append(a.item.upper())
sql += (" order by rank" if a.query else " order by p.filename, p.page") + " limit ?"; args.append(a.limit)
n = 0
for w, item, fn, pg, snip, content in con.execute(sql, args):
    n += 1; print(f"\n== {w} | {item} | {fn} p.{pg}"); print(textwrap.fill(content if a.full else snip, 110))
print(f"\n{n} result(s)")
