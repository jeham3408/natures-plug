// Checks on the Green Clay predictor data (data/greenclay.json, built by pipeline/greenclay/build_greenclay.py).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));
const G = read("greenclay.json"), wb = read("wellbores.json");
const R = G.rule;
const thickness = (h) => Math.min(h, Math.max(R.tmin, Math.min(R.tmax, R.a + R.b * h)));

test("every wellbore left to plug has one entry, and the three classes add up", () => {
  for (const k of ["top", "th", "ref", "rk", "kn", "ks", "own"]) assert.equal(G.wb[k].length, wb.name.length);
  assert.equal(G.counts.named + G.counts.rule + G.counts.none, wb.name.length);
  assert.equal(G.wb.top.filter((t) => t == null).length, G.counts.none);
});

test("the published line reproduces every prediction at the exploration wells", () => {
  const E = G.ex;
  for (let i = 0; i < E.n.length; i++) {
    const th = thickness(E.ro[i] - E.ho[i]);
    assert.ok(Math.abs(E.th[i] - th) <= 1.5, `${E.n[i]}: thickness ${E.th[i]} against ${th}`);
    assert.ok(Math.abs(E.top[i] - (E.ro[i] - th)) <= 1.5, `${E.n[i]}: top`);
    assert.ok(E.top[i] >= E.ho[i] - 1 && E.top[i] <= E.ro[i], `${E.n[i]}: top lies inside the Hordaland Group`);
  }
});

test("the answer key is consistent with the reference wells", () => {
  const ok = G.sites.filter((s) => s.ok);
  assert.equal(ok.length, R.sites);
  assert.equal(new Set(ok.map((s) => s.field)).size, R.fields);
  for (const s of ok) {
    assert.ok(Math.abs(s.T - (s.ro0 - s.tvd)) < 0.2, `${s.wells[0]}: thickness above the Rogaland top`);
    assert.ok(s.tvd > s.ho0 && s.tvd < s.ro0, `${s.wells[0]}: quoted top inside the Hordaland Group`);
    assert.ok(Math.abs(s.err - (s.pred - s.tvd)) < 0.2);
    assert.ok(s.text.includes("[Green Clay]") && s.file && s.page > 0, `${s.wells[0]}: keeps its quote, file and page`);
  }
});

test("the stated miss is the mean of the held-out errors, and it beats the plain guess", () => {
  const ok = G.sites.filter((s) => s.ok), mae = ok.reduce((a, s) => a + Math.abs(s.err), 0) / ok.length;
  assert.ok(Math.abs(mae - G.cv.field.line.mae) < 0.2, `${mae} against ${G.cv.field.line.mae}`);
  assert.equal(R.mae, G.cv.field.line.mae);
  assert.ok(G.cv.field.line.mae < G.cv.field.middle.mae && G.cv.site.line.mae < G.cv.site.middle.mae);
});

test("the log check counts are possible", () => {
  assert.ok(G.logs.check.lower <= G.logs.check.n && G.logs.check.n <= G.logs.n.rdep);
  assert.equal(G.logs.stack.rdep.length, G.logs.hb.length);
});

test("every documented barrier case keeps its source and a valid outcome", () => {
  const B = read("barrier.json");
  assert.ok(B.cases.length >= 15);
  for (const c of B.cases) {
    assert.ok(["used", "logged", "planned", "failed"].includes(c.outcome), c.w);
    assert.ok(c.src.file && c.src.page > 0 && c.summary.length > 40, `${c.w}: source and summary`);
    assert.ok(c.la > 55 && c.la < 75 && c.lo > 0 && c.lo < 35, `${c.w}: position`);
    if (c.log) assert.ok(["pass", "fail"].includes(c.log.cls) && c.log.km <= B.radiusKm);
    if (c.fm) assert.ok(["present", "thin", "absent"].includes(c.fm.cls) && c.fm.km <= B.radiusKm);
    if (c.gcm) assert.ok(c.gcm.top < c.gcm.base);
  }
  assert.ok(B.cases.some((c) => c.gc && c.outcome === "failed") && B.cases.some((c) => c.gc && c.outcome === "used"));
});
