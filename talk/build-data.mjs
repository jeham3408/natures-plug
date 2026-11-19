// Builds talk/data.js for the 3D slides:  node talk/build-data.mjs
//
// Everything the slides show is computed here with the app's own engine (js/engine.js) from the app's own
// data files, so the slides cannot drift from the app. The script checks its shortcuts against the engine
// and stops if a number differs.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadData } from "../tools/load.mjs";
import { computeAll, assessControl, runs, DEFAULTS, LOG, FM, SHALE_GROUPS } from "../js/engine.js";
import { title } from "../js/util.js";

const here = dirname(fileURLToPath(import.meta.url));
const data = loadData();
const R = computeAll(data, DEFAULTS);
const { wb, controls, layer1 } = data;
const n = wb.name.length;

// ---- map projection: Lambert conformal conic, kilometres, x east and y north of 60 N 4 E
const PROJ = { phi1: 58, phi2: 70, phi0: 60, lam0: 4 };
const D = Math.PI / 180;
const tq = (p) => Math.tan(Math.PI / 4 + (p * D) / 2);
const nn = Math.log(Math.cos(PROJ.phi1 * D) / Math.cos(PROJ.phi2 * D)) / Math.log(tq(PROJ.phi2) / tq(PROJ.phi1));
const FF = (Math.cos(PROJ.phi1 * D) * Math.pow(tq(PROJ.phi1), nn)) / nn;
const rho0 = (6371 * FF) / Math.pow(tq(PROJ.phi0), nn);
const proj = (lon, lat) => {
  const rho = (6371 * FF) / Math.pow(tq(lat), nn), th = nn * (lon - PROJ.lam0) * D;
  return [rho * Math.sin(th), rho0 - rho * Math.cos(th)];
};
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const flat = (ring) => { const out = []; for (const [lon, lat] of ring) { const [x, y] = proj(lon, lat); out.push(r1(x), r1(y)); } return out; };

// ---- base map
// geo.json is not part of loadData(), so it is read here
const geo = JSON.parse(readFileSync(join(here, "..", "data", "geo.json"), "utf8"));
const landRings = geo.land.filter((r) => r.length >= 4).map(flat);
const co2 = geo.co2.map((c) => ({ n: c.name, r: c.rings.map(flat) }));

// Quadrant grid as unique line segments; the parallels are cut in four so they follow the projection.
const segs = new Map();
const addSeg = (a, b) => {
  const k1 = a.join(","), k2 = b.join(","), key = k1 < k2 ? k1 + ";" + k2 : k2 + ";" + k1;
  if (!segs.has(key)) segs.set(key, [...a, ...b]);
};
for (const [, w, s, e, nth] of geo.quadrants) {
  const P = (lon, lat) => proj(lon, lat).map(r1);
  for (let i = 0; i < 4; i++) {
    const a = w + ((e - w) * i) / 4, b = w + ((e - w) * (i + 1)) / 4;
    addSeg(P(a, s), P(b, s)); addSeg(P(a, nth), P(b, nth));
  }
  addSeg(P(w, s), P(w, nth)); addSeg(P(e, s), P(e, nth));
}
const quads = [...segs.values()].flat();

// ---- fields
const fieldStats = new Map(R.fields.map((f) => [f.name, f]));
const fields = data.fields.map((f) => {
  const s = fieldStats.get(f.name);
  return {
    n: title(f.name), c: proj(f.c[0], f.c[1]).map(r1), r: f.rings.map(flat),
    left: s ? s.left : 0, log: s ? s.log : [0, 0, 0], fm: s ? s.fm : [0, 0, 0, 0], use: f.use ? 1 : 0,
  };
});
const fieldIndexByName = new Map(data.fields.map((f, i) => [f.name, i]));

// ---- control wells (wells with open logs)
const ctl = controls.map((c, j) => {
  const a = R.ctl[j], [x, y] = c.lat == null ? [null, null] : proj(c.lon, c.lat);
  return { n: c.name, f: c.field ? title(c.field) : "", x: x == null ? null : r2(x), y: y == null ? null : r2(y), a: a.assessed ? 1 : 0, len: a.assessed ? a.longest : 0 };
});

// ---- wellbores left to plug: position, field, nearest assessed control well (index, km), formation-level class
const W = { x: [], y: [], f: [], c: [], d: [], m: [] };
for (let i = 0; i < n; i++) {
  const [x, y] = proj(wb.lon[i], wb.lat[i]);
  W.x.push(r2(x)); W.y.push(r2(y));
  const fname = wb.field[i] >= 0 ? wb.fields[wb.field[i]] : null;
  W.f.push(fname != null && fieldIndexByName.has(fname) ? fieldIndexByName.get(fname) : -1);
  let c = -1, d = 0;
  for (const [dist, j] of data.nb.ctl[i]) { if (R.ctl[j].assessed) { c = j; d = dist; break; } }
  W.c.push(c); W.d.push(c < 0 ? 0 : Math.ceil(d * 1000) / 1000);
  W.m.push(R.cls1[i]);
}

// The slides class a wellbore from W.c, W.d and ctl[].len. Check that shortcut against the engine.
const classify = (minLen, radius) => {
  const t = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const j = W.c[i];
    if (j < 0 || W.d[i] > radius) t[LOG.NONE]++;
    else t[ctl[j].len >= minLen ? LOG.PASS : LOG.FAIL]++;
  }
  return t;
};
const checks = [];
for (const L of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) checks.push([L, 10]);
for (const rad of [5, 8, 12, 15, 20, 25, 30]) checks.push([30, rad]);
checks.push([50, 20], [10, 5]);
for (const [L, rad] of checks) {
  const want = computeAll(data, { ...DEFAULTS, minLen: L, radiusKm: rad }).totals.log, got = classify(L, rad);
  if (want.join() !== got.join()) throw new Error(`shortcut differs from the engine at minLen ${L}, radius ${rad}: ${got} vs ${want}`);
}

// ---- the two wells of the contrast slide
function wellDetail(name) {
  const c = controls.find((x) => x.name === name), a = R.ctl.find((x) => x.name === name), z = a.zones[a.zone];
  const gi = c.groups.map((g) => [title(g[0]).replace(/ Gp$/, ""), g[1], g[2], SHALE_GROUPS.includes(g[0]) ? 1 : 0]);
  // runs of the clay signature inside the Hordaland and Rogaland groups
  const inShale = (md) => c.groups.some((g) => SHALE_GROUPS.includes(g[0]) && md >= g[1] && md < g[2]);
  const flags = Array.from(a.clay, (v, i) => (v && inShale(c.a0 + i) ? 1 : 0));
  const clay = runs(flags, 0).filter((r) => r.len >= 2).map((r) => [c.a0 + r.i0 - 0.5, c.a0 + r.i1 + 0.5]);
  const best = (zz) => { let b = null; for (const r of runs(zz.q, 0)) if (!b || r.len > b.len) b = r; return b ? [c.a0 + b.i0 - 0.5, c.a0 + b.i1 + 0.5] : null; };
  // pore-pressure sweep on a 0.01 grid that contains the default value
  const sweep = { pp: [], zmin: [], len: [], top: [], base: [] };
  const k0 = -Math.floor((z.pp - 1.0) / 0.01 + 1e-9), k1 = Math.floor((1.8 - z.pp) / 0.01 + 1e-9);
  for (let k = k0; k <= k1; k++) {
    const pp = Math.round((z.pp + k * 0.01) * 1000) / 1000;
    const b = assessControl(c, DEFAULTS, { pp }), zz = b.zones[b.zone], bi = best(zz);
    sweep.pp.push(pp); sweep.zmin.push(zz.zminMd); sweep.len.push(zz.longest);
    sweep.top.push(bi ? bi[0] : null); sweep.base.push(bi ? bi[1] : null);
  }
  const i0 = sweep.pp.indexOf(Math.round(z.pp * 1000) / 1000);
  if (i0 < 0 || sweep.len[i0] !== z.longest || sweep.zmin[i0] !== z.zminMd) throw new Error("sweep does not contain the default for " + name);
  return {
    name, field: title(c.field), wd: c.wd, kb: c.kb, td: c.td, groups: gi, clay,
    clayM: a.clayHord + a.clayRog, clayHord: a.clayHord, clayRog: a.clayRog,
    lot: c.lot.map((l) => [l[0], l[2]]), zone: title(z.name).replace(/ Gp$/, " Gp").replace(/ Fm$/, " Fm"), ztop: z.topMd,
    pp: z.pp, zmin: z.zminMd, len: z.longest, best: best(z), pass: z.cls === LOG.PASS ? 1 : 0, i0, sweep,
  };
}
const wells = { fram: wellDetail("35/11-7"), visund: wellDetail("34/8-1") };

// ---- headline numbers, for captions and for the self-test in the page
const T = R.totals;
const totals = {
  left: T.left, log: Array.from(T.log), fm: Array.from(T.fm), strong: T.strong, passFields: T.passFields,
  controls: T.controls, layer1: T.layer1, agree: R.agree, pages: data.validation.doc_totals.pages,
};
const useFields = Object.keys(data.validation.documented_use).map((name) => {
  const f = R.fields.find((x) => x.name === name);
  return { n: title(name), i: fieldIndexByName.get(name), left: f ? f.left : 0, present: f ? f.fm[FM.PRESENT] : 0 };
});

const out = { built: data.meta.built, factpages: data.meta.factpages_date, defaults: { minLen: DEFAULTS.minLen, strongLen: DEFAULTS.strongLen, radiusKm: DEFAULTS.radiusKm }, proj: PROJ, land: landRings, quads, co2, fields, ctl, wb: W, wells, totals, useFields };
const js = "// Generated by talk/build-data.mjs from the app's data and engine. Do not edit by hand.\nwindow.NP_TALK = " + JSON.stringify(out) + ";\n";
writeFileSync(join(here, "data.js"), js);

console.log(`talk/data.js written: ${(js.length / 1024).toFixed(0)} kB`);
console.log(`wellbores ${n} | log pass ${T.log[2]} fail ${T.log[1]} none ${T.log[0]} | fm present ${T.fm[3]} thin ${T.fm[2]} absent ${T.fm[1]} none ${T.fm[0]}`);
console.log(`land rings ${landRings.length} | quadrant segments ${quads.length / 4} | fields ${fields.length} | control wells ${ctl.length} (${ctl.filter((c) => c.a).length} assessed)`);
for (const w of Object.values(wells)) console.log(`${w.name} ${w.field}: zone ${w.zone} ${w.ztop} m, pp ${w.pp}, holds from ${w.zmin} m, longest ${w.len} m, best ${JSON.stringify(w.best)}, clay ${w.clayM} m in ${w.clay.length} runs, sweep ${w.sweep.pp[0]}..${w.sweep.pp.at(-1)}`);
console.log("fields with documented use:", useFields.map((f) => `${f.n} ${f.present}/${f.left}`).join(", "));
console.log(`shortcut checked against the engine for ${checks.length} settings`);
