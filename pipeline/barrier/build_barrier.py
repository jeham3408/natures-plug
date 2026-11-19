"""Attach the report file, the position and the field to each hand-classified case in barrier_cases.csv.
Writes ../../data/barrier.json; tools/barrier.mjs then adds what the atlas and the Green Clay model say at each well.
NP_DATA is the folder with the raw downloads (FactPages tables and the report index)."""
import csv, json, os, re, sqlite3
H = os.environ.get("NP_DATA", "/mnt/ssd/Data/force-hackathon-2026") + "/"
here = os.path.dirname(os.path.abspath(__file__))
con = sqlite3.connect(f"file:{H}diskos/diskos.sqlite?mode=ro", uri=True)
pos = {}
for f in ("factpages/wellbore_development_all.csv", "factpages/wellbore_exploration_all.csv"):
    for r in csv.DictReader(open(H + f, encoding="utf-8-sig")):
        if r.get("wlbNsDecDeg"): pos[r["wlbWellboreName"]] = (float(r["wlbNsDecDeg"]), float(r["wlbEwDecDeg"]), r.get("wlbField") or "", r.get("wlbStatus") or "")
def find(w):
    s = w
    for _ in range(4):
        if s in pos: return pos[s]
        s2 = re.sub(r"\s*T\d+$", "", s)
        if s2 == s and " " in s: s2 = re.sub(r"(\s[A-Z]+)?(Y\d)?H?$", "", s).strip()
        if s2 == s: break
        s = s2
out = []
for c in csv.DictReader(open(os.path.join(here, "barrier_cases.csv"), encoding="utf-8")):
    hit = con.execute("select wellbore, item, filename, page from pages where content like ? and page = ? and (wellbore = ? or ? = 1) order by (wellbore = ?) desc limit 1",
                      ("%" + c["phrase"] + "%", int(c["page"]), c["wellbore"], int(c["wellbore"] in ("34/7-P-7", "34/7-B-3 HT3")), c["wellbore"])).fetchone()
    assert hit, "source page not found for " + c["wellbore"]
    p = find(c["wellbore"]); assert p, "no position for " + c["wellbore"]
    out.append(dict(w=c["wellbore"], area=c["area"], unit=c["unit"], gc=int(c["green_clay"]), outcome=c["outcome"], how=c["how"], summary=c["summary"],
                    src=dict(w=hit[0], item=hit[1], file=hit[2], page=hit[3]), la=p[0], lo=p[1], field=p[2], status=p[3]))
json.dump(dict(cases=out), open(os.path.join(here, "..", "..", "data", "barrier.json"), "w"), ensure_ascii=False, indent=1)
print(len(out), "cases")
for o in out: print(" ", o["w"], "|", o["outcome"], "|", o["src"]["w"], o["src"]["file"][:60], "p", o["src"]["page"], "|", o["field"], o["status"])
