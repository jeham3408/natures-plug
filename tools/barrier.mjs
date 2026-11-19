// Add to data/barrier.json what the atlas and the Green Clay model say at each documented case:  node tools/barrier.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { loadData } from "./load.mjs";
import { computeAll, DEFAULTS, LOG, FM, distKm } from "../js/engine.js";

const file = new URL("../data/barrier.json", import.meta.url);
const B = JSON.parse(readFileSync(file, "utf8")), G = JSON.parse(readFileSync(new URL("../data/greenclay.json", import.meta.url), "utf8"));
const data = loadData(), r = computeAll(data, DEFAULTS), R = G.rule;
const LOGN = { [LOG.PASS]: "pass", [LOG.FAIL]: "fail" }, FMN = { [FM.PRESENT]: "present", [FM.THIN]: "thin", [FM.ABSENT]: "absent" };
const nearest = (la, lo, list, lat, lon, ok) => {
  let best = null;
  list.forEach((x, j) => { if (!ok(j)) return; const d = distKm(la, lo, +lat(x), +lon(x)); if (d <= DEFAULTS.radiusKm && (!best || d < best.km)) best = { j, km: d }; });
  return best;
};
const vertical = (w) => w.ho && w.ro && /\d$/.test(w.n);
for (const c of B.cases) {
  const a = nearest(c.la, c.lo, data.controls, (x) => x.lat, (x) => x.lon, (j) => r.ctl[j].assessed);
  const f = nearest(c.la, c.lo, data.layer1, (x) => x.la, (x) => x.lo, (j) => r.l1[j].assessed);
  const g = nearest(c.la, c.lo, data.layer1, (x) => x.la, (x) => x.lo, (j) => vertical(data.layer1[j]));
  c.log = a ? { cls: LOGN[r.ctl[a.j].cls], well: data.controls[a.j].name, km: +a.km.toFixed(1) } : null;
  c.fm = f ? { cls: FMN[r.l1[f.j].cls], well: data.layer1[f.j].n, km: +f.km.toFixed(1) } : null;
  if (g) {
    const w = data.layer1[g.j], h = w.ro[0] - w.ho[0], th = Math.min(h, Math.max(R.tmin, Math.min(R.tmax, R.a + R.b * h)));
    c.gcm = { top: Math.round(w.ro[0] - th), base: Math.round(w.ro[0]), well: w.n, km: +g.km.toFixed(1) };
  } else c.gcm = null;
}
const tally = {};
for (const c of B.cases) { const k = `${c.outcome}|${c.log ? c.log.cls : "none"}|${c.fm ? c.fm.cls : "none"}`; tally[k] = (tally[k] || 0) + 1; }
B.radiusKm = DEFAULTS.radiusKm; B.minLen = DEFAULTS.minLen;
writeFileSync(file, JSON.stringify(B, null, 1) + "\n");
for (const c of B.cases) console.log(c.w.padEnd(16), c.outcome.padEnd(8), "log:", (c.log ? `${c.log.cls} (${c.log.well}, ${c.log.km} km)` : "none").padEnd(28), "formation:", (c.fm ? `${c.fm.cls} (${c.fm.well}, ${c.fm.km} km)` : "none").padEnd(30), "GC model:", c.gcm ? `${c.gcm.top}-${c.gcm.base}` : "none");
console.log(tally);
