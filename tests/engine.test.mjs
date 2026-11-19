// node --test tests/
import test from "node:test";
import assert from "node:assert/strict";
import { loadData } from "../tools/load.mjs";
import { computeAll, assessControl, assessFormation, DEFAULTS, LOG, FM, interp, runs, requiredEmw, distKm } from "../js/engine.js";

const data = loadData();
const base = computeAll(data, DEFAULTS);
const ctl = (name) => data.controls.find((c) => c.name === name);

test("interp is linear inside and flat outside", () => {
  assert.equal(interp(5, [0, 10], [0, 100]), 50);
  assert.equal(interp(-3, [0, 10], [7, 9]), 7);
  assert.equal(interp(30, [0, 10], [7, 9]), 9);
  assert.equal(interp(4, [4], [1.7]), 1.7);
});

test("runs finds intervals and bridges short gaps", () => {
  const f = [0, 1, 1, 0, 1, 1, 1, 0, 0, 1];
  assert.deepEqual(runs(f).map((r) => r.len), [2, 3, 1]);
  assert.deepEqual(runs(f, 1).map((r) => r.len), [6, 1]);
  assert.deepEqual(runs([0, 0, 0]), []);
});

test("required pressure falls as the barrier gets deeper", () => {
  const shallow = requiredEmw(1000, 2000, 1.2, 0.2), deep = requiredEmw(1800, 2000, 1.2, 0.2);
  assert.ok(shallow > deep);
  assert.ok(Math.abs(requiredEmw(2000, 2000, 1.2, 0.2) - 1.2) < 1e-9, "at the reservoir top it equals the pore pressure");
});

test("distance is about 111 km per degree of latitude", () => {
  assert.ok(Math.abs(distKm(60, 3, 61, 3) - 111.2) < 0.01);
});

test("every wellbore gets exactly one class", () => {
  const T = base.totals;
  assert.equal(T.left, data.wb.name.length);
  assert.equal(T.log[0] + T.log[1] + T.log[2], T.left);
  assert.equal(T.fm[0] + T.fm[1] + T.fm[2] + T.fm[3], T.left);
});

test("Fram passes and Visund does not, with the same clay signature", () => {
  const fram = assessControl(ctl("35/11-7")), visund = assessControl(ctl("34/8-1"));
  assert.equal(fram.cls, LOG.PASS);
  assert.ok(fram.longest >= 100 && fram.longest <= 200, `Fram longest ${fram.longest}`);
  assert.equal(visund.cls, LOG.FAIL);
  assert.equal(visund.longest, 0);
  assert.ok(visund.clayHord > 400, "Visund still has several hundred metres of clay signature in the Hordaland Group");
  const z = visund.zones[visund.zone];
  assert.ok(z.zminMd > 1826, "at Visund the pressure only holds below the base of the Hordaland Group");
});

test("all but one of the wells that pass do so in the Hordaland or Rogaland Group", () => {
  const groups = base.ctl.filter((a) => a.assessed && a.cls === LOG.PASS).map((a) => a.zones[a.zone].bestGroup);
  assert.equal(groups.length, 21);
  assert.equal(groups.filter((g) => g === "HORDALAND GP" || g === "ROGALAND GP").length, 20);
  assert.deepEqual(groups.filter((g) => g !== "HORDALAND GP" && g !== "ROGALAND GP"), ["SHETLAND GP"], "35/11-15 S passes on a Shetland Group interval");
});

test("a well without a leak-off test above the reservoir is not assessed", () => {
  const a = assessControl(ctl("25/11-19 S"));
  assert.equal(a.assessed, false);
  assert.match(a.reason, /leak-off test above/);
});

test("fields where Havtil documents use come out with clay in the pressure window", () => {
  for (const name of ["EKOFISK", "VALHALL", "ULA", "IVAR AASEN", "BALDER"]) {
    const f = base.fields.find((x) => x.name === name);
    assert.ok(f && f.left > 0, name);
    assert.ok(f.fm[FM.PRESENT] > f.left / 2, `${name}: present ${f.fm[FM.PRESENT]} of ${f.left}`);
  }
  for (const name of ["GULLFAKS", "VISUND", "KVITEBJØRN"]) {
    const f = base.fields.find((x) => x.name === name);
    assert.equal(f.fm[FM.PRESENT], 0, name);
  }
});

test("loosening the clay threshold never removes a pass", () => {
  const loose = computeAll(data, { ...DEFAULTS, rdepMax: 2.0 });
  assert.ok(loose.totals.log[LOG.PASS] >= base.totals.log[LOG.PASS]);
  const strict = computeAll(data, { ...DEFAULTS, minLen: 80 });
  assert.ok(strict.totals.log[LOG.PASS] <= base.totals.log[LOG.PASS]);
});

test("a higher pore pressure can only make it harder", () => {
  const c = ctl("35/11-7");
  const a = assessControl(c, DEFAULTS), b = assessControl(c, DEFAULTS, { pp: 1.6 });
  assert.ok(b.longest <= a.longest);
  assert.ok(b.zones[b.zone].zminMd >= a.zones[a.zone].zminMd);
});

test("a larger search radius never covers fewer wellbores", () => {
  const wide = computeAll(data, { ...DEFAULTS, radiusKm: 20 });
  assert.ok(wide.totals.log[LOG.NONE] <= base.totals.log[LOG.NONE]);
});

test("formation-level screen needs a shale top, a zone and a leak-off test above it", () => {
  const w = { n: "x", ho: [1000, 1800], lot: [[900, 1.7], [1700, 1.8]], z: [["TEST FM", 2000, 1.2]] };
  const a = assessFormation(w, DEFAULTS);
  assert.equal(a.assessed, true);
  assert.equal(a.cls, FM.PRESENT);
  assert.equal(assessFormation({ ...w, lot: [] }).assessed, false);
  assert.equal(assessFormation({ ...w, ho: undefined }).assessed, false);
  assert.equal(assessFormation({ ...w, lot: [[2100, 1.8]] }).assessed, false);
});
