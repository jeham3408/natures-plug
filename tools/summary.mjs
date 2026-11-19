// Print the headline numbers with the default assumptions:  node tools/summary.mjs
import { loadData } from "./load.mjs";
import { computeAll, DEFAULTS, LOG, FM } from "../js/engine.js";

const data = loadData();
const t0 = performance.now();
const r = computeAll(data, DEFAULTS);
const ms = (performance.now() - t0).toFixed(0);
const T = r.totals;
console.log(`computed in ${ms} ms`);
console.log(`wellbores left to plug: ${T.left}`);
console.log(`log level:       pass ${T.log[LOG.PASS]} | fail ${T.log[LOG.FAIL]} | not covered ${T.log[LOG.NONE]} | strong (>=${DEFAULTS.strongLen} m) ${T.strong} | fields with a pass ${T.passFields}`);
console.log(`formation level: present ${T.fm[FM.PRESENT]} | thin ${T.fm[FM.THIN]} | absent ${T.fm[FM.ABSENT]} | not covered ${T.fm[FM.NONE]}`);
console.log(`control wells: ${T.controls.all} | assessed ${T.controls.assessed} | pass ${T.controls.pass} | strong ${T.controls.strong}`);
console.log(`formation-level wells: ${T.layer1.all} | assessed ${T.layer1.assessed} | present ${T.layer1.present}`);
console.log(`agreement on wells with both levels:`, r.agree);
const top = r.fields.filter((f) => f.left > 0).sort((a, b) => b.left - a.left).slice(0, 22);
console.log("\nfield            left  pass  fail  none | present thin absent none");
for (const f of top) console.log(f.name.padEnd(16), String(f.left).padStart(4), String(f.log[2]).padStart(5), String(f.log[1]).padStart(5), String(f.log[0]).padStart(5), "|", String(f.fm[3]).padStart(7), String(f.fm[2]).padStart(4), String(f.fm[1]).padStart(6), String(f.fm[0]).padStart(4));
console.log("\nfields with documented use:");
for (const name of Object.keys(data.validation.documented_use)) {
  const f = r.fields.find((x) => x.name === name);
  console.log(" ", name.padEnd(11), f ? `left ${f.left} | present ${f.fm[3]} thin ${f.fm[2]} absent ${f.fm[1]} none ${f.fm[0]} | log pass ${f.log[2]} fail ${f.log[1]}` : "no wellbores left");
}
console.log("\ncontrol wells that pass:");
r.ctl.filter((a) => a.assessed && a.cls === LOG.PASS).sort((a, b) => b.longest - a.longest).forEach((a) => {
  const z = a.zones[a.zone];
  console.log(" ", a.name.padEnd(11), z.name.padEnd(20), `res ${z.topMd} m | pp ${z.pp.toFixed(2)} | holds from ${z.zminMd} m | longest ${z.longest} m | net ${z.net} m | ${z.bestGroup}`);
});
for (const n of ["34/8-1", "25/11-19 S", "30/6-5"]) {
  const a = r.ctl.find((x) => x.name === n), z = a.assessed ? a.zones[a.zone] : null;
  console.log(n, a.assessed ? `cls ${a.cls} longest ${z.longest} zmin ${z.zminMd} res ${z.topMd} pp ${z.pp.toFixed(2)}` : `not assessed: ${a.reason}`);
}
