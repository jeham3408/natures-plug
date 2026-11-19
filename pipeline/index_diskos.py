"""Build a searchable SQLite copy of the Diskos report texts (Zenodo 10775273) plus keyword evidence files.
Outputs (in diskos/): diskos.sqlite (pages + FTS5), creep_hits.csv, pa_hits.csv, diskos_files.csv. Takes about 16 minutes.
    NP_DATA=/path/to/raw python3 index_diskos.py
"""
import csv, re, sqlite3, time, os, sys
csv.field_size_limit(10**9)
D = os.environ.get("NP_DATA", "./raw").rstrip("/") + "/"
src = D + "diskos/Norway_Diskos_reports.csv"
db = D + "diskos/diskos.sqlite"
for p in (db, db + "-journal", db + "-wal", db + "-shm"):
    if os.path.exists(p): os.remove(p)
con = sqlite3.connect(db)
con.executescript("""
pragma journal_mode=off; pragma synchronous=off; pragma temp_store=memory; pragma cache_size=-300000;
create table pages(id integer primary key, wellbore text, wtype text, grp text, item text, title text, filename text, page integer, nat integer, content text);
""")
creep = re.compile(r"tight hole|tight spots?|tight section|squeez\w* (?:shale|clay|formation|hole)|swelling (?:clay|shale)s?|gumbo|plastic (?:clay|shale)s?|mobile (?:clay|shale)s?|creep\w*|hole (?:was |is )?closing|sloughing|overpull|had to be reamed", re.I)
pa = re.compile(r"cement plugs?|plug(?:ged)? and abandon\w*|permanent(?:ly)? (?:plug|abandon)\w*|\bP ?& ?A\b|top of cement|\bTOC\b|bond logs?|\bCBL\b|\bUSIT\b|leak[- ]off|\bX?LOT\b|formation integrity", re.I)
t0 = time.time(); n = 0; batch = []; files = {}
fh = open(D + "diskos/creep_hits.csv", "w", newline="", encoding="utf-8"); hw = csv.writer(fh)
hw.writerow(["wellbore", "wtype", "grp", "item", "filename", "page", "kw", "snippet"])
fp = open(D + "diskos/pa_hits.csv", "w", newline="", encoding="utf-8"); pw = csv.writer(fp)
pw.writerow(["wellbore", "wtype", "item", "filename", "page", "kw", "n_matches", "snippet"])
nh = npa = 0
with open(src, newline="", encoding="utf-8", errors="ignore") as f:
    for row in csv.DictReader(f):
        n += 1
        w = (row.get("WELLBORE NAME") or "").strip()
        wt = (row.get("TYPE") or "").split(",")[0].strip()
        grp = (row.get("INFO ITEM GROUP TYPE") or "").strip(); item = (row.get("INFO ITEM TYPE") or "").strip()
        title = (row.get("DESCRIPTION") or row.get("TITLE") or "").strip()[:300]
        fn = row.get("filename") or ""
        try: pg = int(float(row.get("page") or 0))
        except ValueError: pg = 0
        nat = 1 if (row.get("content_could_be_natural_language") or "").strip().lower() == "true" else 0
        txt = row.get("content") or ""
        batch.append((n, w, wt, grp, item, title, fn, pg, nat, txt))
        fi = files.get(fn)
        if fi is None: fi = files[fn] = [w, wt, grp, item, title, 0, 0, 0, 0]
        fi[5] += 1; fi[6] += nat
        seen = set()
        for m in creep.finditer(txt):
            a = max(0, m.start() - 230); b = min(len(txt), m.end() + 230); key = m.start() // 150
            if key in seen: continue
            seen.add(key)
            hw.writerow([w, wt, grp, item, fn, pg, m.group(0).lower(), " ".join(txt[a:b].split())]); nh += 1; fi[7] += 1
        ms = list(pa.finditer(txt))
        if ms:
            m = ms[0]; a = max(0, m.start() - 160); b = min(len(txt), m.end() + 200)
            pw.writerow([w, wt, item, fn, pg, m.group(0).lower(), len(ms), " ".join(txt[a:b].split())]); npa += 1; fi[8] += 1
        if len(batch) >= 20000:
            con.executemany("insert into pages values(?,?,?,?,?,?,?,?,?,?)", batch); batch = []
            if n % 200000 == 0: print(f"{n} pages, {nh} creep hits, {npa} pa pages, {round(time.time() - t0)} s", flush=True)
if batch: con.executemany("insert into pages values(?,?,?,?,?,?,?,?,?,?)", batch)
con.commit(); fh.close(); fp.close()
with open(D + "diskos/diskos_files.csv", "w", newline="", encoding="utf-8") as f:
    wr = csv.writer(f); wr.writerow(["filename", "wellbore", "wtype", "grp", "item", "title", "pages", "natural_pages", "creep_hits", "pa_pages"])
    for fn, v in files.items(): wr.writerow([fn] + v)
print(f"rows done: {n} pages, {len(files)} files, {nh} creep hits, {npa} pa pages, {round(time.time() - t0)} s", flush=True)
con.executescript("create index ix_pages_wellbore on pages(wellbore); create index ix_pages_file on pages(filename, page);")
print("indexes done", round(time.time() - t0), "s", flush=True)
con.executescript("""
create virtual table pages_fts using fts5(content, content='pages', content_rowid='id', tokenize='unicode61 remove_diacritics 2');
insert into pages_fts(pages_fts) values('rebuild');
""")
con.commit()
print("fts done", round(time.time() - t0), "s", flush=True)
print("test:", con.execute("select count(*) from pages_fts where pages_fts match '\"tight hole\"'").fetchone(), flush=True)
con.close(); print("ALL DONE", round(time.time() - t0), "s", flush=True)
