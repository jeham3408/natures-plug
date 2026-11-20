// Checks on the "what if at a well" calculation (seismic/whatif.js). The file is a classic script for the page; its
// calculation part is loaded here the same way seismic/server/tests/check_app.js loads app.js.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const WI = createRequire(import.meta.url)("../seismic/whatif.js");
const fin = Number.isFinite;

/** Logs of a made-up well on a regular two-way time grid, the way the server delivers them: depth follows from the
 *  velocity, so time and depth agree. vpOf and rhoOf give the rock at a depth (m). */
function makeLogs(vpOf, rhoOf, { n = 700, dt = 2, t0 = 400, md0 = 400 } = {}) {
  const md = [md0], vp = [], rho_used = [], ai = [];
  for (let k = 0; k < n; k++) {
    vp.push(vpOf(md[k])); rho_used.push(rhoOf(md[k])); ai.push(vp[k] * rho_used[k]);
    if (k < n - 1) md.push(md[k] + vp[k] * dt / 2000);
  }
  return { t0, dt, n, md, vp, rho_used, ai };
}
/** Repeatable noise with unit variance. */
function noise(seed) {
  let s = seed >>> 0;
  const u = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}
const maxAbs = (a, ka, kb) => { let m = 0; for (let k = ka; k <= kb; k++) if (fin(a[k])) m = Math.max(m, Math.abs(a[k])); return m; };
const argMaxAbs = (a) => { let m = -1, at = -1; for (let k = 0; k < a.length; k++) if (fin(a[k]) && Math.abs(a[k]) > m) { m = Math.abs(a[k]); at = k; } return at; };
const NONE = { mode: "scale", vpPct: 0, rhoPct: 0, h: null, ramp: 0, streak: { on: false, thick: 5, pct: 30, depth: 20 } };
const wavelet = WI.ricker(25, 2);

// a layered well: a soft interval 1000-1200 m with its own 24 m layering, under rock with a slow trend and 9 m layering,
// and over harder rock with 45 m layering (without events below the interval that a 25 Hz wavelet can see, a delay would
// have nothing to move)
const layered = makeLogs(
  (z) => (z >= 1000 && z < 1200 ? 1900 + 90 * Math.sin(2 * Math.PI * z / 24) : z >= 1200 ? 2400 + 150 * Math.sin(2 * Math.PI * z / 45) : 2150 + 0.1 * (z - 400) + 40 * Math.sin(2 * Math.PI * z / 9)),
  (z) => (z >= 1000 && z < 1200 ? 2.02 + 0.03 * Math.sin(2 * Math.PI * z / 24) : z >= 1200 ? 2.2 : 2.1 + 0.02 * Math.sin(2 * Math.PI * z / 9)));
// a plain well: the same rock everywhere, so every response in a difference comes from the scenario alone
const plain = makeLogs(() => 2000, () => 2.1);

test("no change gives no difference and no delay", () => {
  for (const o of [{ ...NONE, top: 1000, base: 1200 }, { ...NONE, top: 1000, base: 1200, h: 60, ramp: 30 }]) {
    const sc = WI.scenario(layered, o);
    assert.equal(sc.changed, 0);
    assert.equal(sc.delay, 0);
    assert.deepEqual(Array.from(sc.aiT), layered.ai);
    const a = WI.trace(layered.ai, wavelet, 1).syn, b = WI.trace(sc.aiT, wavelet, 1).syn;
    for (let k = 0; k < layered.n; k++) assert.equal(b[k] - a[k], 0);
  }
});

test("missing log values stay missing: a gap is never turned into a reflector", () => {
  // the server sends a missing value as null: the top of the log before the sonic starts, and a short gap further down
  const gappy = { ...layered, vp: layered.vp.slice(), rho_used: layered.rho_used.slice(), ai: layered.ai.slice() };
  for (let k = 0; k < 60; k++) gappy.vp[k] = gappy.rho_used[k] = gappy.ai[k] = null;
  for (let k = 300; k < 303; k++) gappy.vp[k] = gappy.ai[k] = null;                       // inside the interval
  for (let k = 450; k < 452; k++) gappy.rho_used[k] = gappy.ai[k] = null;                 // below it
  const logged = WI.trace(gappy.ai, wavelet, 1);
  assert.equal(logged.k0, 60);
  for (const o of [{}, { vpPct: -10 }, { rhoPct: 5 }, { mode: "above" }, { vpPct: -10, h: 0 }, { streak: { on: true, thick: 5, pct: 30, depth: 50 } }]) {
    const sc = WI.scenario(gappy, { ...NONE, top: 1000, base: 1200, ...o }), t = WI.trace(sc.aiT, wavelet, 1);
    assert.equal(t.k0, 60, "the scenario starts where the log starts");
    for (let k = 0; k < 60; k++) assert.ok(Number.isNaN(sc.aiT[k]) && Number.isNaN(t.syn[k]));
    for (let k = 300; k < 303; k++) assert.ok(Number.isNaN(sc.ai[k]) && Number.isNaN(sc.vp[k]));
    assert.ok(maxAbs(t.rc, 0, gappy.n - 1) < 0.2, `no false reflector: largest reflection coefficient ${maxAbs(t.rc, 0, gappy.n - 1).toFixed(3)}`);
    if (!sc.changed) for (let k = 60; k < gappy.n; k++) assert.equal(t.syn[k], logged.syn[k]);
  }
  // the gap in the sonic still takes time to cross: the delay is the same as without the gap, within a sample
  const withGap = WI.scenario(gappy, { ...NONE, top: 1000, base: 1200, vpPct: -10 }).delay, without = WI.scenario(layered, { ...NONE, top: 1000, base: 1200, vpPct: -10 }).delay;
  assert.ok(Math.abs(withGap - without) < 0.5, `${withGap.toFixed(2)} against ${without.toFixed(2)} ms`);
});

test("thickness 0 equals no change", () => {
  const sc = WI.scenario(layered, { ...NONE, top: 1000, base: 1200, vpPct: -15, rhoPct: 5, h: 0 });
  assert.equal(sc.changed, 0);
  assert.equal(sc.delay, 0);
  assert.deepEqual(Array.from(sc.aiT), layered.ai);
  const above = WI.scenario(layered, { ...NONE, top: 1000, base: 1200, mode: "above", h: 0 });
  assert.deepEqual(Array.from(above.aiT), layered.ai);
});

test("a velocity change gives the delay 2 h (1/v_new - 1/v_old), and the rock below arrives that much later", () => {
  for (const [pct, h] of [[-10, 200], [-20, 200], [15, 200], [-10, 60]]) {
    const sc = WI.scenario(plain, { ...NONE, top: 1000, base: 1200, vpPct: pct, h: h === 200 ? null : h });
    const want = 2 * h * (1 / (2000 * (1 + pct / 100)) - 1 / 2000) * 1000;
    assert.ok(Math.abs(sc.delay - want) < 0.1, `${pct} % over ${h} m: ${sc.delay.toFixed(3)} ms against ${want.toFixed(3)} ms`);
  }
  // in the layered well the velocity changes with depth: the sum over the samples, and a reflector below that moves
  const sc = WI.scenario(layered, { ...NONE, top: 1000, base: 1200, vpPct: -10 });
  let want = 0;
  for (let k = 1; k < layered.n; k++) { const zm = (layered.md[k] + layered.md[k - 1]) / 2; if (zm >= 1000 && zm < 1200) want += 2 * (layered.md[k] - layered.md[k - 1]) * (1 / 0.9 - 1) / ((layered.vp[k] + layered.vp[k - 1]) / 2) * 1000; }
  assert.ok(Math.abs(sc.delay - want) < 2, `within a sample: ${sc.delay.toFixed(2)} against ${want.toFixed(2)} ms`);
  assert.ok(sc.delay > 20 && sc.delay < 26);
  const step = (ai) => { let at = -1, m = 0; for (let k = 300; k < layered.n - 1; k++) { const d = Math.abs(ai[k + 1] - ai[k]); if (fin(d) && d > m) { m = d; at = k; } } return at; };
  const moved = (step(sc.aiT) - step(layered.ai)) * layered.dt;      // the step into the 2400 m/s rock at 1200 m
  assert.ok(Math.abs(moved - sc.delay) <= layered.dt, `the base moves ${moved} ms, the delay is ${sc.delay.toFixed(2)} ms`);
});

test("density does not move time", () => {
  const sc = WI.scenario(layered, { ...NONE, top: 1000, base: 1200, rhoPct: -10 });
  assert.ok(sc.changed > 50);
  assert.equal(sc.delay, 0);
  const k = Math.round(WI.indexAtDepth(layered.md, 1100));
  assert.ok(Math.abs(sc.aiT[k] / layered.ai[k] - 0.9) < 1e-12);
});

test("like the layer above: no step at the top and none of the interval's own layering left", () => {
  const o = { ...NONE, top: 1000, base: 1200, mode: "above" };
  const sc = WI.scenario(layered, o), kT = WI.indexAtDepth(layered.md, 1000), k0 = Math.floor(kT), k1 = Math.floor(WI.indexAtDepth(layered.md, 1200));
  assert.ok(sc.above.ok && sc.above.thick > 500);
  // the rock above, as it was made: mirrored about 1000 m
  const vpAbove = (z) => 2150 + 0.1 * (z - 400) + 40 * Math.sin(2 * Math.PI * z / 9);
  for (let k = k0 + 2; k < k1 - 1; k++) {
    const want = vpAbove(2000 - layered.md[k]);
    assert.ok(Math.abs(sc.vp[k] - want) < 12, `sample ${k}: ${sc.vp[k].toFixed(1)} against the mirrored log ${want.toFixed(1)}`);   // 12 m/s: straight lines between 2 m samples of a 9 m wave
  }
  // continuity at the top: the jump across it is no larger than the jumps between neighbouring samples above it
  let usual = 0; for (let k = k0 - 40; k < k0 - 1; k++) usual = Math.max(usual, Math.abs(sc.ai[k + 1] - sc.ai[k]));
  for (let k = k0 - 1; k <= k0 + 2; k++) assert.ok(Math.abs(sc.ai[k + 1] - sc.ai[k]) <= usual * 1.05, `no step at the top (sample ${k})`);
  // none of the 24 m layering of the interval is left: project the result on that wave
  const proj = (a) => {
    let mean = 0, s = 0, c = 0, n = 0;
    for (let k = k0 + 2; k < k1 - 1; k++) { mean += a[k]; n++; } mean /= n;
    for (let k = k0 + 2; k < k1 - 1; k++) { const p = 2 * Math.PI * layered.md[k] / 24; s += (a[k] - mean) * Math.sin(p); c += (a[k] - mean) * Math.cos(p); }
    return 2 * Math.hypot(s, c) / n;
  };
  assert.ok(proj(layered.vp) > 80, "the interval as logged has its 24 m layering (90 m/s)");
  assert.ok(proj(sc.vp) < 8, `left of it after the change: ${proj(sc.vp).toFixed(1)} m/s`);
  // the lesson from the modelling review: multiplying the interval by a number keeps that layering
  const scaled = WI.scenario(layered, { ...NONE, top: 1000, base: 1200, vpPct: 12 });
  assert.ok(proj(scaled.vp) > 80);
});

test("like the layer above folds the log back and forth where the interval is thicker than the log above", () => {
  const short = makeLogs((z) => (z < 1000 ? 2100 + 2 * (z - 940) : 1900), () => 2.1, { n: 200, t0: 900, md0: 940 });
  const sc = WI.scenario(short, { ...NONE, top: 1000, base: 1150, mode: "above" });
  assert.ok(sc.above.ok && sc.above.thick > 55 && sc.above.thick <= 60);
  const A = sc.above.thick, at = (d) => WI.mirrorAt(sc.above, 1000, 1000 + d).vp;
  for (const x of [5, 20, 40]) assert.ok(Math.abs(at(A - x) - at(A + x)) < 1e-9, "the same value at the same distance either side of the fold");
  assert.ok(Math.abs(at(2 * A) - at(0)) < 1e-9 && Math.abs(at(0) - short.vp[Math.ceil(WI.indexAtDepth(short.md, 1000)) - 1]) < 1e-9);
  let jump = 0; for (let d = 0; d < 150; d += 0.5) jump = Math.max(jump, Math.abs(at(d + 0.5) - at(d)));
  assert.ok(jump <= 2 * 0.5 + 1e-9, `never a jump: the largest change over half a metre is ${jump.toFixed(2)} m/s`);
});

test("like the layer above is refused where there is too little log above", () => {
  const o = { ...NONE, top: 410, base: 600, mode: "above" };
  const sc = WI.scenario(layered, o);
  assert.equal(sc.above.ok, false);
  assert.match(sc.above.why, /Only \d+ m of unbroken log above the top of the interval \(\d+ samples\): at least 20 m and 10 samples/);
  assert.equal(sc.changed, 0);
  assert.equal(WI.usableAbove(layered, 400).ok, false);
  assert.match(WI.usableAbove(layered, 400).why, /no log above/);
});

test("a gradual top lowers the response of the top, step by step", () => {
  const kT = Math.round(WI.indexAtDepth(plain.md, 1000));
  let before = Infinity; const seen = [];
  for (const ramp of [0, 10, 20, 30, 40, 50, 60]) {
    const sc = WI.scenario(plain, { ...NONE, top: 1000, base: 1300, vpPct: -15, ramp });
    const peak = maxAbs(WI.trace(sc.aiT, wavelet, 1).syn, kT - 30, kT + 45);
    seen.push(peak.toFixed(5));
    assert.ok(peak < before, `ramp ${ramp} m: ${seen.join(" > ")}`);
    before = peak;
  }
  assert.ok(before < 0.5 * Number(seen[0]), "60 m of ramp more than halves the top response of a 25 Hz wavelet");
  // the share of the change in a sample is the mean over its 2 m cell: a 4 m ramp from a top that sits on a sample
  const wts = WI.scenario(plain, { ...NONE, top: 1000, base: 1300, vpPct: -15, ramp: 4 }).weight;
  assert.deepEqual([0, 1, 2, 3].map((i) => +wts[kT + i].toFixed(6)), [0.0625, 0.5, 0.9375, 1]);
  // every step of the control in the page (4 m), also with the top between two log samples
  for (const top of [1000, 1001.5]) {
    let last = Infinity;
    for (let ramp = 0; ramp <= 60; ramp += 4) {
      const peak = maxAbs(WI.trace(WI.scenario(plain, { ...NONE, top, base: 1300, vpPct: -15, ramp }).aiT, wavelet, 1).syn, kT - 30, kT + 45);
      assert.ok(peak < last, `top ${top} m, ramp ${ramp} m: ${peak} is not below ${last}`);
      last = peak;
    }
  }
});

test("a hard streak adds a response where it is put, and nowhere else", () => {
  for (const depth of [40, 120]) {
    const sc = WI.scenario(plain, { ...NONE, top: 1000, base: 1200, streak: { on: true, thick: 4, pct: 40, depth } });
    const diff = WI.trace(sc.aiT, wavelet, 1).syn;                  // the plain well has no reflections of its own
    // a thin layer answers with a wavelet pair of opposite sign, so its place is the middle of the energy, not the largest value
    const kS = WI.indexAtDepth(plain.md, 1000 + depth + 2), at = argMaxAbs(diff);
    let e = 0, ek = 0; for (let k = 0; k < plain.n; k++) if (fin(diff[k])) { e += diff[k] * diff[k]; ek += k * diff[k] * diff[k]; }
    assert.ok(Math.abs(ek / e - kS) <= 1.5, `streak ${depth} m below the top: response centred on sample ${(ek / e).toFixed(2)}, streak at ${kS.toFixed(1)}`);
    assert.ok(Math.abs(at - kS) <= 6, "and its largest value within a quarter cycle of it");
    assert.ok(maxAbs(diff, 0, Math.floor(kS) - 45) < 1e-3 * Math.abs(diff[at]), "nothing above it");
    assert.ok(maxAbs(diff, Math.ceil(kS) + 45, plain.n - 40) < 0.05 * Math.abs(diff[at]), "nothing below it but the small delay");
    // 4 m at 40 % more impedance: velocity up by sqrt(1.4), so the rock below arrives a little earlier
    const want = 2 * 4 * (1 / (2000 * Math.sqrt(1.4)) - 1 / 2000) * 1000;
    assert.ok(Math.abs(sc.delay - want) < 0.05);
    const kMid = Math.round(WI.indexAtDepth(plain.md, 1000 + depth + 2));
    assert.ok(Math.abs(sc.ai[kMid] / plain.ai[kMid] - 1.4) < 1e-9);
  }
  const off = WI.scenario(plain, { ...NONE, top: 1000, base: 1200, streak: { on: false, thick: 4, pct: 40, depth: 40 } });
  assert.equal(off.changed, 0);
});

test("the misfit band recovers a known noise level", () => {
  const g = noise(7), n = 6000, ai = [2000];
  for (let k = 1; k < n; k++) ai.push(ai[k - 1] * (1 + 0.03 * g()));
  const syn = WI.trace(ai, wavelet, 1).syn, sd = WI.rmsOver(syn, 100, n - 100).rms;
  for (const [scale, level] of [[3.7, 0.5], [120, 2], [0.02, 1]]) {
    const sigma = level * sd * scale, seis = Array.from(syn, (v) => scale * v + 11 + sigma * g());   // noise, a scale and an offset
    const m = WI.misfitBand(syn, seis, 100, n - 100, 2);
    assert.ok(Math.abs(m.scale / scale - 1) < 0.05, `scale ${m.scale} against ${scale}`);
    assert.ok(Math.abs(m.resid / sigma - 1) < 0.05, `noise ${m.resid} against ${sigma}`);
    assert.ok(Math.abs(m.band / (level * sd) - 1) < 0.08, `band ${m.band} against ${level * sd} in synthetic units`);
    assert.ok(Math.abs(m.band / m.synRms - Math.sqrt(1 - m.r * m.r) / m.r) < 1e-9, "band / synthetic = sqrt(1 - r^2) / r");
  }
  const none = WI.misfitBand(syn, Array.from(syn, (v) => 5 * v), 100, n - 100, 2);
  assert.ok(none.band < 1e-6 * none.synRms && Math.abs(none.r - 1) < 1e-9, `no noise, no band: ${none.band}`);
  assert.equal(WI.misfitBand(syn, Array.from(syn, (v) => -5 * v), 100, n - 100, 2).band, Infinity);   // the synthetic does not follow the seismic
  assert.ok(Number.isNaN(WI.misfitBand(syn, syn, 100, 110, 2).band));                                  // too few samples
});

test("the reading: larger or smaller than the misfit band, with phase turned 30 degrees either way", () => {
  const sd = WI.rmsOver(WI.trace(layered.ai, wavelet, 1).syn, 0, layered.n - 1).rms;
  const run = (level, opts) => {
    const g = noise(3), logged = WI.trace(layered.ai, wavelet, 1).syn;
    const seis = Array.from(logged, (v) => (fin(v) ? 40 * v + 40 * level * sd * g() : NaN));
    return WI.evaluate({ L: layered, seis, win: [layered.t0 + 200, layered.t0 + 1300], wavelet: (ph) => WI.rotate(wavelet, ph), phase: 0, pol: 1, periodMs: 40, opts: { ...NONE, top: 1000, base: 1200, ...opts } });
  };
  const quiet = run(0.05, { mode: "above" }), loud = run(5, { mode: "above" });
  assert.deepEqual(quiet.phases.map((p) => p.phase), [-30, 0, 30]);
  assert.ok(Math.abs(quiet.cur.band.band / (0.05 * sd) - 1) < 0.15);
  for (const p of quiet.phases) for (const k of ["top", "base", "below"]) assert.equal(WI.verdict(p[k].ratio).cls, "larger", `quiet, ${k} at ${p.phase}: ${p[k].ratio}`);
  for (const p of loud.phases) for (const k of ["top", "base", "below"]) assert.equal(WI.verdict(p[k].ratio).cls, "smaller", `loud, ${k} at ${p.phase}: ${p[k].ratio}`);
  // the same change, the same difference: only the band differs
  assert.ok(Math.abs(quiet.cur.top.rms - loud.cur.top.rms) < 1e-12);
  assert.ok(quiet.sc.delay < -5, "the layer above is faster, so the rock below arrives earlier");
  assert.ok(Math.abs(quiet.tBaseScen - quiet.tBase - quiet.sc.delay) < 1e-9);
  // an end of the log is not a boundary in the rock: no reading for a top or a base that sits on it, or for what lies below
  const sp = WI.logSpan(layered), ends = run(0.05, { top: sp.md0, base: sp.md1, vpPct: -10 });
  for (const k of ["top", "base", "below"]) assert.ok(Number.isNaN(ends.cur[k].ratio), `${k} at an end of the log: ${ends.cur[k].ratio}`);
  assert.equal(WI.verdict(ends.cur.base.ratio).cls, "na");
  // nothing changed: every ratio is zero
  const same = run(1, {});
  for (const k of ["top", "base", "below"]) assert.equal(same.cur[k].ratio, 0);
  assert.equal(same.cur.rLogged, same.cur.rScen);
  assert.equal(WI.verdict(1.2).cls, "larger"); assert.equal(WI.verdict(1).cls, "smaller"); assert.equal(WI.verdict(NaN).cls, "na");
  assert.match(WI.verdict(3).text, /larger than what the tie leaves unexplained here/);
  assert.match(WI.verdict(0.3).text, /smaller: this trace cannot tell the two apart/);
});

test("correlation comes with a rough standard error from window length and bandwidth", () => {
  const bw = WI.effectiveBandwidth(wavelet, 2);
  assert.ok(Math.abs(bw / (1.2154 * 25) - 1) < 0.03, `Ricker 25 Hz: ${bw.toFixed(2)} Hz against 72 sqrt(pi) / 105 x 25 = 30.4 Hz`);
  assert.ok(Math.abs(WI.effectiveBandwidth(WI.rotate(wavelet, 60), 2) / bw - 1) < 0.03, "turning the phase does not change the bandwidth");
  const se = WI.corrStdErr(0.5, 400, 30);
  assert.equal(se.n, 24);
  assert.ok(Math.abs(se.se - 0.75 / Math.sqrt(23)) < 1e-12);
  assert.ok(Number.isNaN(WI.corrStdErr(0.5, 20, 30).se));
});

test("the wavelet and the synthetic follow the rules of the tie panel", () => {
  assert.deepEqual(WI.rotate(wavelet, 0), wavelet);
  const q = WI.rotate(wavelet, 90), mid = (wavelet.length - 1) / 2, e = (a) => a.reduce((s, v) => s + v * v, 0);
  assert.ok(Math.abs(q[mid]) < 1e-9 && Math.abs(e(q) / e(wavelet) - 1) < 0.02, "a quarter turn: odd about the middle, same energy");
  for (let k = 1; k < 10; k++) assert.ok(Math.abs(q[mid + k] + q[mid - k]) < 1e-9);
  // one step up in impedance is one positive wavelet at the step; reversed polarity turns it over; a gap is bridged
  const ai = Array.from({ length: 300 }, (_, k) => (k < 150 ? 4000 : 5000)); ai[10] = NaN; ai[0] = NaN;
  const a = WI.trace(ai, wavelet, 1), b = WI.trace(ai, wavelet, -1);
  assert.equal(argMaxAbs(a.syn), 149);
  assert.ok(Math.abs(a.syn[149] - 1000 / 9000) < 1e-12 && a.syn[149] === -b.syn[149]);
  assert.equal(a.k0, 1); assert.ok(Number.isNaN(a.syn[0])); assert.ok(Math.abs(a.syn[10]) < 1e-12);
});

test("the starting interval: Green Clay top down to the Rogaland top, with sensible fall-backs", () => {
  const tops = (o) => Object.entries(o).map(([key, md]) => ({ key, name: key.toUpperCase(), md, twt: 0 }));
  const d = (o) => WI.defaultInterval(layered, tops(o));
  assert.deepEqual([d({ no: 300, ho: 800, gc: 1000, ro: 1200, sh: 1500 }).topKey, d({ no: 300, ho: 800, gc: 1000, ro: 1200, sh: 1500 }).baseKey], ["gc", "ro"]);
  assert.deepEqual([d({ ho: 800, hd: 1100, ro: 1200 }).top, d({ ho: 800, hd: 1100, ro: 1200 }).base], [1100, 1200]);
  assert.deepEqual([d({ ho: 800, ro: 1200 }).topKey, d({ ho: 800, ro: 1200 }).baseKey], ["ho", "ro"]);
  assert.deepEqual([d({ no: 300, ro: 1200 }).topKey, d({ no: 300, ro: 1200 }).baseKey], ["@start", "ro"]);       // the clay top is above the log
  assert.deepEqual([d({ no: 300, gc: 1000 }).topKey, d({ no: 300, gc: 1000 }).baseKey], ["gc", "@end"]);          // no top below: the end of the log
  assert.deepEqual([d({ no: 300 }).topKey, d({ no: 300 }).baseKey], ["@start", "@end"]);
  assert.deepEqual([d({ no: 300, ro: 380, sh: 1500 }).topKey, d({ no: 300, ro: 380, sh: 1500 }).baseKey], ["@start", "sh"]);   // only a deeper top is logged
  assert.equal(WI.defaultInterval({ n: 3, md: [1, 2, 3], ai: [NaN, NaN, NaN] }, []), null);
  const ch = WI.intervalChoices(layered, tops({ no: 300, gc: 1000, ro: 1200 }));
  assert.deepEqual(ch.map((c) => c.key), ["@start", "gc", "ro", "@end"]);
});

// ---------------------------------------------------------------------------------------------------------------
// Added after the two reviews of the panel (19 November 2026)

/** A series through the wavelet: band-limited noise, like a seismic trace. */
const band = (x) => { const h = (wavelet.length - 1) / 2; return x.map((_, k) => { let sm = 0; for (let m = -h; m <= h; m++) { const q = k - m; if (q >= 0 && q < x.length) sm += x[q] * wavelet[m + h]; } return sm; }); };
const evalWith = (L, seis, opts, extra = {}) => WI.evaluate({ L, seis, win: [L.t0 + 200, L.t0 + 1300], wavelet: (ph) => WI.rotate(wavelet, ph), phase: 0, pol: 1, periodMs: 40, opts: { ...NONE, top: 1000, base: 1200, ...opts }, ...extra });

test("thickness changes the uppermost metres of the interval, and the top window reads the top", () => {
  const sc = WI.scenario(layered, { ...NONE, top: 1000, base: 1200, vpPct: -10, h: 50 });
  let zMin = Infinity, zMax = -Infinity;
  for (let k = 0; k < layered.n; k++) if (sc.vp[k] !== layered.vp[k]) { zMin = Math.min(zMin, layered.md[k]); zMax = Math.max(zMax, layered.md[k]); }
  assert.ok(zMin > 997 && zMin < 1003 && zMax > 1047 && zMax < 1053, `changed samples lie between ${zMin.toFixed(1)} and ${zMax.toFixed(1)} m`);
  // a change at the top shows in the top window; a hard streak just above the base shows in the base window and not in the top window
  const logged = WI.trace(plain.ai, wavelet, 1).syn, seis = logged.map((v, k) => (fin(v) ? v + 0.01 * Math.sin(k * 1.3) : NaN));
  const atTop = evalWith(plain, seis, { vpPct: -10, h: 6 }), atBase = evalWith(plain, seis, { streak: { on: true, thick: 6, pct: 30, depth: 190 } });
  assert.ok(atTop.cur.top.rms > 20 * atBase.cur.top.rms && atTop.cur.top.rms > 0, `top window: ${atTop.cur.top.rms} for a change at the top, ${atBase.cur.top.rms} for one at the base`);
  assert.ok(atBase.cur.base.rms > 5 * atBase.cur.top.rms);
});

test("a positive phase turn has the sign of the tie panel, and every phase column has its own misfit band", () => {
  // wells.js: wavelet x cos(phase) - quadrature x sin(phase); for a Ricker that makes the side after the middle smaller
  const mid = (wavelet.length - 1) / 2, q = WI.rotate(wavelet, 90), r30 = WI.rotate(wavelet, 30);
  assert.ok(q[mid + 3] < -0.5 && q[mid - 3] > 0.5, `+90 degrees: ${q[mid - 3]} before the middle, ${q[mid + 3]} after it`);
  assert.ok(r30[mid - 3] > wavelet[mid - 3] && r30[mid + 3] < wavelet[mid + 3]);
  const g = noise(5), logged = WI.trace(layered.ai, wavelet, 1).syn, sd = WI.rmsOver(logged, 0, layered.n - 1).rms;
  const seis = Array.from(logged, (v) => (fin(v) ? 3 * v + 3 * sd * g() : NaN)), e = evalWith(layered, seis, { vpPct: -10 });
  for (const p of e.phases) {
    const own = WI.misfitBand(WI.trace(layered.ai, WI.rotate(wavelet, p.phase), 1).syn, seis, p.qa, p.qb, 2);
    assert.equal(p.band.band, own.band, `phase ${p.phase}`);
  }
  assert.ok(e.phases[0].band.band !== e.phases[1].band.band && e.phases[2].band.band !== e.phases[1].band.band);
});

test("the standard error of a correlation: 2 x bandwidth x length independent values, checked by simulation", () => {
  const g = noise(11), bw = WI.effectiveBandwidth(wavelet, 2), rs = [];
  for (let i = 0; i < 600; i++) { const a = band(Array.from({ length: 330 }, g)), b = band(Array.from({ length: 330 }, g)); rs.push(WI.misfitBand(a, b, 60, 269, 2).r); }
  const sd = Math.sqrt(rs.reduce((sm, v) => sm + v * v, 0) / rs.length), se = WI.corrStdErr(0, 418, bw).se;
  assert.ok(Math.abs(sd / se - 1) < 0.15, `unrelated traces in a 418 ms window: spread of the correlation ${sd.toFixed(3)}, formula ${se.toFixed(3)}`);
  assert.ok(sd < 0.8 / Math.sqrt(bw * 0.418 - 1), "with bandwidth x length (without the 2) the error would be half as large again");
});

test("the misfit band in a window as short as a tie window comes with a range that holds the true band about two times in three", () => {
  const g = noise(23), bw = WI.effectiveBandwidth(wavelet, 2);
  for (const rTrue of [0.4, 0.7]) {
    const level = Math.sqrt(1 - rTrue * rTrue) / rTrue, ratio = []; let inside = 0, n = 0;
    for (let i = 0; i < 400; i++) {
      const a = band(Array.from({ length: 330 }, g)), e = band(Array.from({ length: 330 }, g)), seis = a.map((v, k) => 7 * (v + level * e[k]));
      const m = WI.misfitBand(a, seis, 60, 269, 2), se = WI.corrStdErr(m.r, 418, bw).se; n++;
      if (!(m.r > 0)) continue;
      ratio.push(m.band / m.synRms / level);
      if (WI.bandOverSyn(Math.min(0.999, m.r + se)) <= level && level <= WI.bandOverSyn(m.r - se)) inside++;
    }
    ratio.sort((x, y) => x - y); const med = ratio[ratio.length >> 1];
    assert.ok(med > 0.85 && med < 1.15, `true correlation ${rTrue}: the band is ${med.toFixed(2)} of the true one in the middle`);
    assert.ok(inside / n > 0.55 && inside / n < 0.85, `true correlation ${rTrue}: the true band lies inside the range in ${inside} of ${n}`);
  }
  assert.equal(WI.bandOverSyn(0), Infinity); assert.equal(WI.bandOverSyn(-0.2), Infinity);
  assert.ok(Math.abs(WI.bandOverSyn(0.6) - 0.8 / 0.6) < 1e-12);
});

test("the reading takes the uncertainty of the band along: larger, smaller or undecided", () => {
  assert.equal(WI.verdict({ ratio: 1.4, lo: 1.1, hi: 1.9 }).cls, "larger");
  assert.equal(WI.verdict({ ratio: 0.5, lo: 0.3, hi: 0.9 }).cls, "smaller");
  const u = WI.verdict({ ratio: 1.2, lo: 0.6, hi: 1.9 });
  assert.equal(u.cls, "open"); assert.match(u.text, /undecided: 0\.6 to 1\.9 within the uncertainty of the band/);
  assert.equal(WI.verdict({ ratio: 0.9, lo: 0.6, hi: 1.3 }).cls, "open");
  // a tie no better than chance: the band is a lower bound, so smaller can be read and larger cannot
  assert.equal(WI.verdict({ ratio: 2.4, lo: 1.5, hi: 3 }, true).cls, "open");
  assert.match(WI.verdict({ ratio: 2.4, lo: 1.5, hi: 3 }, true).text, /not judged: the tie is no better than chance/);
  assert.equal(WI.verdict({ ratio: 0.9, lo: 0.6, hi: 1.3 }, true).cls, "smaller");
  assert.equal(WI.verdict({ ratio: NaN, why: "cannot be judged here: only 50 ms of log below the interval" }).text, "cannot be judged here: only 50 ms of log below the interval");
  // in evaluate: a middling tie gives a range around the ratio, and the range decides
  const g = noise(9), logged = WI.trace(layered.ai, wavelet, 1).syn, sd = WI.rmsOver(logged, 0, layered.n - 1).rms;
  const e = evalWith(layered, band(Array.from(logged, (v) => (fin(v) ? v : 0))).map((v, k) => (fin(logged[k]) ? logged[k] + 1.2 * sd * g() : NaN)), { mode: "above" });
  for (const k of ["top", "base", "below"]) { const q = e.cur[k]; assert.ok(q.lo < q.ratio && q.ratio < q.hi, `${k}: ${q.lo} < ${q.ratio} < ${q.hi}`); }
  assert.ok(e.cur.bandNarrow < e.cur.band.band && e.cur.band.band < e.cur.bandWide);
  assert.ok(Math.abs(e.cur.top.lo - e.cur.top.rms / e.cur.bandWide) < 1e-12 && Math.abs(e.cur.top.hi - e.cur.top.rms / e.cur.bandNarrow) < 1e-12);
});

test("the chance level: a tie on an unrelated trace is found out, a real tie is not", () => {
  const g = noise(31), n = 1500, dt = 2, ai = [2000];
  for (let k = 1; k < n; k++) ai.push(ai[k - 1] * (1 + 0.03 * g()));
  const syn = WI.trace(ai, wavelet, 1).syn, ka = 600, kb = 810;                     // a 420 ms tie window in a 3 s trace
  const search = (trace) => {                                                       // the rule of the tie panel: the best shift between -40 and +40 ms
    const at = (t) => { const x = t / dt, k = Math.floor(x); return k < 0 || k >= n - 1 ? NaN : trace[k] + (trace[k + 1] - trace[k]) * (x - k); };
    let best = 0, r = -2;
    for (let sh = -40; sh <= 40; sh += 2) { const m = WI.misfitBand(syn, Array.from({ length: n }, (_, k) => at(k * dt + sh)), ka, kb, 2); if (m.r > r) { r = m.r; best = sh; } }
    return { at, shift: best, r };
  };
  let found = 0, falseAlarm = 0;
  for (let i = 0; i < 12; i++) {
    const unrelated = band(Array.from({ length: n }, g)), u = search(unrelated);
    const c = WI.chanceLevel(syn, u.at, 0, dt, ka, kb, { shift: u.shift, searched: true, r: u.r, tMin: 0, tMax: (n - 1) * dt });
    assert.ok(c.n >= 20, `${c.n} wrong places to try`);
    if (c.atChance) found++;
    const e = band(Array.from({ length: n }, g)), sdS = WI.rmsOver(syn, 100, n - 100).rms, sdE = WI.rmsOver(e, 100, n - 100).rms;
    const real = syn.map((v, k) => (fin(v) ? v + 0.8 * sdS / sdE * e[k] : 0)), t = search(real);
    const c2 = WI.chanceLevel(syn, t.at, 0, dt, ka, kb, { shift: t.shift, searched: true, r: t.r, tMin: 0, tMax: (n - 1) * dt });
    if (c2.atChance) falseAlarm++;
    assert.ok(c2.median < t.r);
  }
  assert.ok(found >= 10, `unrelated traces called no better than chance: ${found} of 12`);
  assert.ok(falseAlarm <= 1, `real ties (correlation near 0.8) called chance: ${falseAlarm} of 12`);
  // too little trace to try: not known
  const short = WI.chanceLevel(syn, (t) => syn[Math.round(t / dt)], 0, dt, ka, kb, { shift: 0, searched: false, r: 1, tMin: 1000, tMax: 1900 });
  assert.equal(short.atChance, null); assert.ok(short.n < 8);
});

test("the base reading does not fall when the change grows: one window length, placed where the change is largest", () => {
  // one step in density at the base of the interval, the same velocity everywhere, a Ricker wavelet (no ringing)
  const n = 900, md = [400], vp = [], rho_used = [], ai = [];
  for (let k = 0; k < n; k++) { vp.push(2000); rho_used.push(md[k] < 1200 ? 2.0 : 2.3); ai.push(vp[k] * rho_used[k]); if (k < n - 1) md.push(md[k] + 2); }
  const one = { t0: 400, dt: 2, n, md, vp, rho_used, ai }, seis = WI.trace(ai, wavelet, 1).syn.map((v, k) => (fin(v) ? v + 0.02 * Math.sin(k * 1.7) : NaN));
  let most = 0; const seen = [];
  for (const pct of [-1, -2, -3, -5, -8, -10, -12, -15, -18, -20]) {
    const e = WI.evaluate({ L: one, seis, win: [600, 1800], wavelet: (ph) => WI.rotate(wavelet, ph), phase: 0, pol: 1, periodMs: 40, opts: { ...NONE, top: 1000, base: 1200, vpPct: pct } });
    seen.push(`${pct} %: ${(1000 * e.cur.base.rms).toFixed(1)}`);
    assert.equal(e.cur.base.win[1] - e.cur.base.win[0] + 1, 41, "the window is always two wavelet cycles and a sample long");
    assert.ok(e.cur.base.rms >= 0.9 * most, `the reading at the base falls: ${seen.join(", ")}`);
    most = Math.max(most, e.cur.base.rms);
  }
  const best = WI.maxRmsSliding([0, 0, 3, 4, 0, 0, NaN, 9], 0, 7, 2);
  assert.deepEqual([best.ka, best.kb, best.rms], [2, 3, Math.sqrt(12.5)]);                  // the pair with a missing value is not a full window
  assert.ok(Number.isNaN(WI.maxRmsSliding([1, 2, 3], 0, 2, 5).rms));
});

test("below the interval: no reading with less than 150 ms of log, and the share inside the tie window is given", () => {
  const logged = WI.trace(layered.ai, wavelet, 1).syn, seis = logged.map((v, k) => (fin(v) ? v + 0.01 * Math.sin(k * 1.3) : NaN));
  const kBase = Math.round(WI.indexAtDepth(layered.md, 1200));
  const cut = { ...layered, n: kBase + 60, md: layered.md.slice(0, kBase + 60), vp: layered.vp.slice(0, kBase + 60), rho_used: layered.rho_used.slice(0, kBase + 60), ai: layered.ai.slice(0, kBase + 60) };
  const e = evalWith(cut, seis.slice(0, kBase + 60), { vpPct: -5 });
  assert.ok(Number.isNaN(e.cur.below.ratio));
  assert.match(WI.verdict(e.cur.below).text, /cannot be judged here: only \d+ ms of log below the interval/);
  assert.ok(fin(e.cur.base.ratio), "the base itself still has log on both sides");
  const full = evalWith(layered, seis, { vpPct: -5 });
  assert.ok(fin(full.cur.below.ratio) && full.cur.below.ms >= 150);
  assert.equal(full.cur.top.inTie, 1);
  const narrow = WI.evaluate({ L: layered, seis, win: [layered.t0 + 200, layered.t0 + (kBase + 10) * 2], wavelet: (ph) => WI.rotate(wavelet, ph), phase: 0, pol: 1, periodMs: 40, opts: { ...NONE, top: 1000, base: 1200, vpPct: -5 } });
  assert.ok(narrow.cur.below.inTie < 0.1, `tie window ends at the base: ${narrow.cur.below.inTie} of the stretch below lies inside it`);
});

test("a hard streak in the middle of the interval gets its own reading", () => {
  const logged = WI.trace(plain.ai, wavelet, 1).syn, seis = logged.map((v, k) => (fin(v) ? v + 0.01 * Math.sin(k * 1.3) : NaN));
  const e = evalWith(plain, seis, { streak: { on: true, thick: 10, pct: 100, depth: 95 } });
  assert.ok(e.cur.streak && fin(e.cur.streak.rms));
  assert.ok(e.cur.streak.rms > 10 * e.cur.top.rms && e.cur.streak.rms > 3 * e.cur.base.rms, `streak ${e.cur.streak.rms}, top ${e.cur.top.rms}, base ${e.cur.base.rms}`);
  const kS = WI.indexAtDepth(plain.md, 1100);
  assert.ok(Math.abs((e.windows.streak[0] + e.windows.streak[1]) / 2 - kS) <= 2, "its window sits on the streak");
  assert.equal(evalWith(plain, seis, { vpPct: -5 }).cur.streak, undefined);
});

test("no velocity or density log: nothing is changed and nothing breaks; the reason for refusing the layer above is the real one", () => {
  for (const drop of ["vp", "rho_used"]) {
    const L = { ...layered, [drop]: undefined }, sc = WI.scenario(L, { ...NONE, top: 1000, base: 1200, vpPct: -10 });
    assert.equal(sc.changed, 0); assert.equal(sc.delay, 0); assert.equal(sc.above.ok, false);
  }
  // log from 979.5 m in 2.6 m steps: 21 m above the top, but only 8 samples
  const few = makeLogs(() => 2600, () => 2.2, { n: 300, t0: 900, md0: 979.5 });
  assert.match(WI.usableAbove(few, 1000).why, /Only 21 m of unbroken log above the top of the interval \(8 samples\)/);
  // a gap of more than five samples directly above the top, with plenty of log above the gap
  const gap = { ...layered, vp: layered.vp.slice() }, kT = Math.ceil(WI.indexAtDepth(layered.md, 1000));
  for (let k = kT - 6; k < kT; k++) gap.vp[k] = null;
  assert.match(WI.usableAbove(gap, 1000).why, /gap directly above the top/);
});

test("the interval velocity explains the sign of the delay", () => {
  const slow = WI.scenario(plain, { ...NONE, top: 1000, base: 1200, vpPct: -10 });
  assert.ok(Math.abs(slow.vOld - 2000) < 1e-6 && Math.abs(slow.vNew - 1800) < 2 && slow.delay > 0, `${slow.vOld} to ${slow.vNew} m/s`);   // 2 m/s: the two samples that straddle the ends are changed in part
  assert.ok(Math.abs(slow.delay - 2 * 200 * (1 / slow.vNew - 1 / slow.vOld) * 1000) < 0.3);
  const up = WI.scenario(layered, { ...NONE, top: 1000, base: 1200, mode: "above" });
  assert.ok(up.vNew > up.vOld && up.delay < 0, "the rock above is faster in this well: earlier");
});
