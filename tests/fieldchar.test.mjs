// Field characterisation (js/fieldchar.js): one card per field, analogues never the field itself, headline numbers untouched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadData } from "../tools/load.mjs";
import { computeAll, DEFAULTS } from "../js/engine.js";
import { characterise, fieldRows, FEATURES } from "../js/fieldchar.js";

const data = loadData(), r = computeAll(data, DEFAULTS);
const barrier = JSON.parse(readFileSync(new URL("../data/barrier.json", import.meta.url), "utf8"));
const fc = characterise(data, r, barrier);

test("a card for every field with wellbores left to plug", () => {
  assert.equal(fc.cards.length, r.fields.filter((f) => f.left > 0).length);
  assert.equal(fc.cards.reduce((s, c) => s + c.left, 0), r.fields.reduce((s, f) => s + f.left, 0));   // 19 wellbores have no field
});
test("analogues are other fields, nearest first", () => {
  for (const c of fc.cards) {
    assert.ok(!c.alike.some((a) => a.name === c.name));
    for (let i = 1; i < c.alike.length; i++) assert.ok(c.alike[i].d >= c.alike[i - 1].d);
  }
});
test("Havtil's five fields carry their documented use", () => {
  for (const n of Object.keys(data.validation.documented_use)) {
    const c = fc.byName.get(n); if (!c) continue;
    assert.ok(c.track.some((t) => t.kind === "use"), n);
  }
});
test("cases belong to their own field; a neighbour's case never marks a field", () => {
  assert.ok(fc.byName.get("VISUND").track.some((t) => t.ok === false && t.well === "34/8-A-2 H"));
  const vs = fc.byName.get("VISUND SØR");
  if (vs) assert.ok(!vs.track.some((t) => t.ok === false), "Visund's failure must not count against Visund Sør");
  for (const c of fc.cards) for (const t of c.track) if (t.kind === "near") assert.equal(t.ok, null);
});
test("depths are below the sea bed", () => {
  for (const c of fc.cards) if (c.hordTop != null) assert.ok(c.hordTop > -50 && c.hordTop < 3500, c.name + " " + c.hordTop);
});
test("the CSV has one row per field and a column per measure", () => {
  const rows = fieldRows(fc);
  assert.equal(rows.length, fc.cards.length + 1);
  for (const f of FEATURES) assert.ok(rows[0].some((h) => h.startsWith(f.key)));
  assert.ok(rows.every((row) => row.length === rows[0].length));
});
test("the headline numbers do not change", () => {
  assert.deepEqual([r.totals.log[2], r.totals.log[1], r.totals.log[0]], [663, 625, 1605]);
});
