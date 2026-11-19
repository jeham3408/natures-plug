// Nature's Plug - screening engine. Pure functions, no DOM, shared by the app and the tests.
//
// Three checks per control well (a well with open logs):
//   rock      ductile-clay log signature at 1 m resolution
//   pressure  leak-off test (EMW) at that depth >= reservoir pressure with a gas column up to it
//   length    longest continuous run of rock AND pressure, along hole
// Each wellbore that is left to plug inherits the result of the nearest assessed control well.
// This ranks where to look. It does not verify a barrier.

export const DEFAULTS = Object.freeze({
  rdepMax: 1.3,      // ohm.m, deep resistivity below this
  grMin: 40,         // API, gamma ray above this
  dtcMin: 135,       // us/ft, sonic above this (ignored where the curve is missing)
  gas: 0.2,          // g/cm3, gradient of the gas column
  overbalance: 0.05, // g/cm3, subtracted from mud weight to estimate pore pressure
  ppFloor: 1.03,     // g/cm3, lowest pore pressure used
  minLen: 30,        // m, continuous length needed to pass
  strongLen: 50,     // m, reported as "strong"
  radiusKm: 10,      // km, how far a control well is allowed to speak for a wellbore
  bridge: 0,         // m, gaps up to this length do not break an interval
  formationMin: 50,  // m of Hordaland/Rogaland inside the pressure window (formation level)
  zoneMode: "shallowest", // which named hydrocarbon zone to isolate: "shallowest" | "deepest"
});

export const SHALE_GROUPS = ["HORDALAND GP", "ROGALAND GP"];
export const LOG = { NONE: 0, FAIL: 1, PASS: 2 };
export const FM = { NONE: 0, ABSENT: 1, THIN: 2, PRESENT: 3 };

/** Piecewise-linear interpolation, flat outside the data. xs ascending. */
export function interp(x, xs, ys) {
  const n = xs.length;
  if (n === 0) return NaN;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  const dx = xs[hi] - xs[lo];
  return dx === 0 ? ys[hi] : ys[lo] + ((x - xs[lo]) / dx) * (ys[hi] - ys[lo]);
}

/** Distance in km between two points given in decimal degrees (flat-earth approximation, fine below ~100 km). */
export function distKm(lat1, lon1, lat2, lon2) {
  const dy = (lat2 - lat1) * 111.2;
  const dx = (lon2 - lon1) * 111.2 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/** Required equivalent mud weight at depth tvd to hold a reservoir at resTvd with pore pressure pp under a gas column. */
export function requiredEmw(tvd, resTvd, pp, gas) {
  return gas + ((pp - gas) * resTvd) / Math.max(tvd, 1);
}

/** Runs of true values in a boolean-ish array. Returns [{i0, i1, len}] with len in samples; gaps <= bridge are bridged. */
export function runs(flags, bridge = 0) {
  const out = [];
  let start = -1, last = -1;
  for (let i = 0; i < flags.length; i++) {
    if (!flags[i]) continue;
    if (start === -1) { start = i; last = i; continue; }
    if (i - last - 1 > bridge) { out.push({ i0: start, i1: last, len: last - start + 1 }); start = i; }
    last = i;
  }
  if (start !== -1) out.push({ i0: start, i1: last, len: last - start + 1 });
  return out;
}

function groupIndex(c) {
  if (c._g) return c._g;
  const g = new Int8Array(c.n).fill(-1);
  for (let k = 0; k < c.groups.length; k++) {
    const [, top, base] = c.groups[k];
    const i0 = Math.max(0, Math.ceil(top - c.a0)), i1 = Math.min(c.n - 1, Math.ceil(base - c.a0) - 1);
    for (let i = i0; i <= i1; i++) g[i] = k;
  }
  c._g = g;
  return g;
}

/** Ductile-clay flag per 1 m sample. */
export function clayFlags(c, P) {
  const f = new Uint8Array(c.n), dtc = c.dtc;
  for (let i = 0; i < c.n; i++) {
    const r = c.rdep[i], g = c.gr[i], d = dtc ? dtc[i] : null;
    if (r == null || g == null) continue;
    if (r < P.rdepMax && g > P.grMin && (d == null || d > P.dtcMin)) f[i] = 1;
  }
  return f;
}

/** Hydrocarbon zones a well can be tested against: named, with a mud weight and a leak-off test above them. */
export function usableZones(zones, lotMd) {
  const out = [];
  for (let k = 0; k < zones.length; k++) {
    const z = zones[k], mw = z[z.length - 1], top = z[1];
    if (mw == null) continue;
    if (!lotMd.some((m) => m < top)) continue;
    out.push(k);
  }
  return out;
}

function whyNot(zones, lotMd) {
  if (!zones.length) return "No named hydrocarbon zone in FactPages (dry well, or the zone has no top)";
  if (!lotMd.length || zones.every((z) => z[z.length - 1] == null)) return "No leak-off test or mud weight in FactPages";
  return "No leak-off test above the reservoir top";
}

/**
 * The zone the screen is run against: the shallowest (or deepest) named zone that has a mud weight.
 * Returns -1 when that zone cannot be tested, so a well is never judged against an easier zone by accident.
 */
export function targetZone(zones, usable, mode) {
  const withMw = zones.map((z, k) => k).filter((k) => zones[k][zones[k].length - 1] != null);
  if (!withMw.length) return -1;
  const want = mode === "deepest" ? withMw[withMw.length - 1] : withMw[0];
  return usable.includes(want) ? want : -1;
}

/**
 * Assess one control well. `ov` may hold per-well overrides: { zone: index, pp: number }.
 * Returns clay statistics for every well, and the pressure result where the well can be assessed.
 */
export function assessControl(c, P = DEFAULTS, ov = null) {
  const clay = clayFlags(c, P), gi = groupIndex(c);
  const shaleIdx = c.groups.map((g, k) => (SHALE_GROUPS.includes(g[0]) ? k : -1)).filter((k) => k >= 0);
  const inShale = new Uint8Array(c.n);
  let clayHord = 0, clayRog = 0;
  for (let i = 0; i < c.n; i++) {
    const k = gi[i];
    if (k < 0 || !shaleIdx.includes(k)) continue;
    inShale[i] = 1;
    if (clay[i]) { if (c.groups[k][0] === "HORDALAND GP") clayHord++; else clayRog++; }
  }
  const clayRuns = runs(clay.map((v, i) => v && inShale[i]), P.bridge);
  const res = {
    name: c.name, assessed: false, reason: null, cls: LOG.NONE,
    clayHord, clayRog, clayLongest: clayRuns.reduce((m, r) => Math.max(m, r.len), 0),
    clay, zones: [], zone: -1,
  };
  const lotMd = c.lot.map((l) => l[0]);
  const usable = usableZones(c.zones, lotMd);
  const pick = ov && ov.zone != null && usable.includes(ov.zone) ? ov.zone : targetZone(c.zones, usable, P.zoneMode);
  if (pick < 0) { res.reason = whyNot(c.zones, lotMd); return res; }

  const order = c.lot.map((l, i) => i).sort((a, b) => c.lot[a][1] - c.lot[b][1]);
  const xs = order.map((i) => c.lot[i][1]), ys = order.map((i) => c.lot[i][2]);
  const minLot = xs[0];

  const one = (k, ppOverride) => {
    const [zname, ztop, ztvd, mw] = c.zones[k];
    const pp = ppOverride != null ? ppOverride : Math.max(P.ppFloor, mw - P.overbalance);
    const nz = Math.max(0, Math.min(c.n, Math.ceil(ztop - c.a0)));
    const ok = new Uint8Array(c.n), q = new Uint8Array(c.n);
    const req = new Float32Array(nz), avail = new Float32Array(nz);
    let zminI = -1, windowM = 0, net = 0;
    for (let i = 0; i < nz; i++) {
      const tvd = c.tvd[i];
      avail[i] = interp(tvd, xs, ys);
      req[i] = requiredEmw(tvd, ztvd, pp, P.gas);
      if (avail[i] >= req[i] && tvd >= minLot) {
        ok[i] = 1; windowM++;
        if (zminI < 0) zminI = i;
        if (clay[i]) { q[i] = 1; net++; }
      }
    }
    const rs = runs(q, P.bridge);
    let best = null;
    for (const r of rs) if (!best || r.len > best.len) best = r;
    const intervals = rs.filter((r) => r.len >= 5).map((r) => ({
      top: c.a0 + r.i0 - 0.5, base: c.a0 + r.i1 + 0.5, len: r.len, group: gi[r.i0] >= 0 ? c.groups[gi[r.i0]][0] : null,
    }));
    const longest = best ? best.len : 0;
    return {
      k, name: zname, topMd: ztop, topTvd: ztvd, mw, pp, ok, q, req, avail, nz,
      zminMd: zminI < 0 ? null : c.a0 + zminI - 0.5, zminTvd: zminI < 0 ? null : c.tvd[zminI],
      windowM, net, longest, intervals,
      bestGroup: best && gi[best.i0] >= 0 ? c.groups[gi[best.i0]][0] : null,
      cls: longest >= P.minLen ? LOG.PASS : LOG.FAIL, strong: longest >= P.strongLen,
    };
  };
  res.zones = usable.map((k) => one(k, k === pick && ov && ov.pp != null ? ov.pp : null));
  res.zone = usable.indexOf(pick);
  const z = res.zones[res.zone];
  res.assessed = true; res.cls = z.cls; res.strong = z.strong; res.longest = z.longest; res.net = z.net;
  return res;
}

/** Formation-level screen for an exploration well without logs: is there Hordaland/Rogaland inside the pressure window? */
export function assessFormation(w, P = DEFAULTS) {
  const res = { name: w.n, assessed: false, reason: null, cls: FM.NONE };
  if (!w.ho && !w.ro) { res.reason = "No Hordaland or Rogaland Group top"; return res; }
  const lotMd = w.lot.map((l) => l[0]);
  const usable = usableZones(w.z, lotMd);
  const k = targetZone(w.z, usable, P.zoneMode);
  if (k < 0) { res.reason = whyNot(w.z, lotMd); return res; }
  const [zname, ztop, mw] = w.z[k];
  const pp = Math.max(P.ppFloor, mw - P.overbalance);
  const order = w.lot.map((l, i) => i).sort((a, b) => w.lot[a][0] - w.lot[b][0]);
  const xs = order.map((i) => w.lot[i][0]), ys = order.map((i) => w.lot[i][1]);
  let zmin = null, hord = 0, rog = 0;
  for (let z = Math.ceil(xs[0]); z < ztop; z++) {
    // A single TVD/MD ratio scales reservoir and barrier depth alike, so it cancels out here.
    if (interp(z, xs, ys) < requiredEmw(z, ztop, pp, P.gas)) continue;
    if (zmin == null) zmin = z;
    if (w.ho && z >= w.ho[0] && z < w.ho[1]) hord++;
    else if (w.ro && z >= w.ro[0] && z < w.ro[1]) rog++;
  }
  const tot = hord + rog;
  Object.assign(res, {
    assessed: true, zone: zname, topMd: ztop, pp, zmin, hord, rog, inWindow: tot,
    cls: tot >= P.formationMin ? FM.PRESENT : tot > 0 ? FM.THIN : FM.ABSENT,
  });
  return res;
}

/** One-off geometry: for every wellbore, the nearest control wells and formation-level wells within maxKm. */
export function prepareNeighbours(wb, controls, layer1, maxKm = 30, keep = 12) {
  const n = wb.name.length;
  const near = (items, lat, lon) => {
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const la = wb.lat[i], lo = wb.lon[i], cand = [];
      for (let j = 0; j < items.length; j++) {
        const y = lat(items[j]), x = lon(items[j]);
        if (y == null || Math.abs(y - la) * 111.2 > maxKm) continue;
        const d = distKm(la, lo, y, x);
        if (d <= maxKm) cand.push([d, j]);
      }
      cand.sort((a, b) => a[0] - b[0]);
      out[i] = cand.slice(0, keep);
    }
    return out;
  };
  return { ctl: near(controls, (c) => c.lat, (c) => c.lon), l1: near(layer1, (w) => w.la, (w) => w.lo) };
}

/** Run everything. `overrides` maps control-well name -> { zone, pp }. */
export function computeAll(data, P = DEFAULTS, overrides = {}) {
  const { wb, controls, layer1, nb } = data;
  const ctl = controls.map((c) => assessControl(c, P, overrides[c.name] || null));
  const l1 = layer1.map((w) => assessFormation(w, P));
  const n = wb.name.length;
  const cls = new Uint8Array(n), cls1 = new Uint8Array(n), strong = new Uint8Array(n);
  const ctlIdx = new Int16Array(n).fill(-1), l1Idx = new Int16Array(n).fill(-1);
  const ctlKm = new Float32Array(n), l1Km = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    for (const [d, j] of nb.ctl[i]) {
      if (d > P.radiusKm) break;
      if (!ctl[j].assessed) continue;
      ctlIdx[i] = j; ctlKm[i] = d; cls[i] = ctl[j].cls; strong[i] = ctl[j].strong ? 1 : 0; break;
    }
    for (const [d, j] of nb.l1[i]) {
      if (d > P.radiusKm) break;
      if (!l1[j].assessed) continue;
      l1Idx[i] = j; l1Km[i] = d; cls1[i] = l1[j].cls; break;
    }
  }
  const fields = wb.fields.map((name) => ({ name, left: 0, log: [0, 0, 0], fm: [0, 0, 0, 0], strong: 0 }));
  const totals = { left: n, log: [0, 0, 0], fm: [0, 0, 0, 0], strong: 0, passFields: 0 };
  for (let i = 0; i < n; i++) {
    totals.log[cls[i]]++; totals.fm[cls1[i]]++; totals.strong += strong[i];
    const f = wb.field[i];
    if (f < 0) continue;
    const F = fields[f];
    F.left++; F.log[cls[i]]++; F.fm[cls1[i]]++; F.strong += strong[i];
  }
  totals.passFields = fields.filter((f) => f.log[LOG.PASS] > 0).length;
  const assessed = ctl.filter((a) => a.assessed);
  totals.controls = { all: ctl.length, assessed: assessed.length, pass: assessed.filter((a) => a.cls === LOG.PASS).length, strong: assessed.filter((a) => a.strong).length };
  totals.layer1 = { all: l1.length, assessed: l1.filter((a) => a.assessed).length, present: l1.filter((a) => a.cls === FM.PRESENT).length };
  // Agreement between the two levels on wells that have both.
  const byName = new Map(layer1.map((w, j) => [w.n, j]));
  const agree = { passPresent: 0, passOther: 0, failPresent: 0, failOther: 0 };
  ctl.forEach((a) => {
    if (!a.assessed) return;
    const j = byName.get(a.name);
    if (j == null || !l1[j].assessed) return;
    const present = l1[j].cls === FM.PRESENT;
    if (a.cls === LOG.PASS) present ? agree.passPresent++ : agree.passOther++;
    else present ? agree.failPresent++ : agree.failOther++;
  });
  return { ctl, l1, cls, cls1, strong, ctlIdx, ctlKm, l1Idx, l1Km, fields, totals, agree };
}
