// Field characterisation: the same measures of the clay groups for every field, the fields most alike, and where the
// clay has a track record. A first, open answer to Havtil's 2025 knowledge report (Reflekt AS, 22 Nov 2025, ch. 11),
// which finds "most likely a need for a more systematic formation characterization across fields", sees promise in
// transferring track records between geologically similar layers, and asks for common databases.
//
// Pure functions: no DOM. Everything comes from data the app already has (formation tops, leak-off tests and mud
// weights of the exploration wells, the log screen, and the documented cases). Nothing here changes a headline number.
import { distKm } from "./engine.js";

const median = (a) => { const v = a.filter((x) => x != null && isFinite(x)).sort((p, q) => p - q); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2; };

/** The measures used to compare fields, in the order of the similarity vector. */
export const FEATURES = [
  { key: "hordTop", label: "Top of the Hordaland Group, below the sea bed", unit: "m", d: 0, sim: true },
  { key: "hordThk", label: "Hordaland Group thickness", unit: "m", d: 0, sim: true, log: true },
  { key: "rogThk", label: "Rogaland Group thickness", unit: "m", d: 0, sim: true, log: true },
  { key: "pp", label: "Assumed reservoir pore pressure (mud weight minus overbalance)", unit: "g/cm³", d: 2, sim: true },
  { key: "zmin", label: "Pressure holds from (leak-off estimate), below the sea bed", unit: "m", d: 0 },
  { key: "inWindow", label: "Hordaland + Rogaland clay inside that window", unit: "m", d: 0 },
];
/** Only the geology measures that do not move with the sliders are used for "most similar". */
export const SIM = FEATURES.filter((f) => f.sim);

/**
 * One card per field with wellbores left to plug.
 * @param data the app data (wb, layer1, controls, fieldGeo, fieldIdx …)
 * @param r    the engine result for the current assumptions
 * @param barrier data/barrier.json or null
 * @returns {{cards: object[], byName: Map<string, object>}}
 */
export function characterise(data, r, barrier) {
  const cards = [];
  const cases = barrier && Array.isArray(barrier.cases) ? barrier.cases : [];
  r.fields.forEach((F, fi) => {
    if (!F.left) return;
    const wbs = data.wbOfField ? data.wbOfField[fi] : data.wb.name.map((_, i) => i).filter((i) => data.wb.field[i] === fi);
    const l1 = [...new Set(wbs.map((i) => r.l1Idx[i]).filter((k) => k >= 0))];
    const ctl = [...new Set(wbs.map((i) => r.ctlIdx[i]).filter((j) => j >= 0))];
    const L = l1.map((k) => ({ w: data.layer1[k], a: r.l1[k] }));
    // depths below the sea bed: the Nordland Group top is the sea bed in the tops (both measured from the rig floor)
    const sb = (w) => (w.no && w.no[0] != null ? w.no[0] : null);
    const ho = L.filter((x) => x.w.ho), ro = L.filter((x) => x.w.ro), as = L.filter((x) => x.a && x.a.assessed);
    const card = {
      name: F.name, left: F.left, log: F.log, fm: F.fm,
      wells: l1.length, logWells: ctl.length,
      hordTop: median(ho.map((x) => (sb(x.w) == null ? null : x.w.ho[0] - sb(x.w)))),
      hordThk: median(ho.map((x) => x.w.ho[1] - x.w.ho[0])),
      rogThk: median(ro.map((x) => x.w.ro[1] - x.w.ro[0])),
      pp: median(as.map((x) => x.a.pp)),
      zmin: median(as.map((x) => (sb(x.w) == null || x.a.zmin == null ? null : x.a.zmin - sb(x.w)))),
      inWindow: median(as.map((x) => x.a.inWindow)),
      longest: median(ctl.map((j) => (r.ctl[j] && r.ctl[j].assessed ? r.ctl[j].longest : null))),
      track: [],
    };
    // track record: Havtil's documented use, and the hand-read cases within 10 km of the field's wellbores
    const use = data.validation && data.validation.documented_use ? data.validation.documented_use[F.name] : null;
    if (use) card.track.push({ kind: "use", text: `Havtil 2025: in use${use[0] ? " (" + use[0] + ")" : ""}`, ok: true });
    const say = (c) => (c.outcome === "failed" ? "did not hold" : c.outcome === "planned" ? "planned, no public result" : c.outcome === "logged" ? "confirmed on log" : "used as a barrier");
    for (const c of cases) {
      const own = String(c.field || "").toUpperCase() === F.name;
      if (own) { card.track.push({ kind: "case", text: `${c.w}: ${say(c)}`, ok: c.outcome === "failed" ? false : c.outcome === "planned" ? null : true, well: c.w }); continue; }
      // a case of another field close by is context only: it never marks this field
      if (c.la == null || c.lo == null) continue;
      const near = wbs.some((i) => data.wb.lat[i] != null && distKm(c.la, c.lo, data.wb.lat[i], data.wb.lon[i]) <= 10);
      if (near) card.track.push({ kind: "near", text: `${c.w} (${c.field ? c.field.charAt(0) + c.field.slice(1).toLowerCase() : "other field"}, within 10 km): ${say(c)}`, ok: null, well: c.w });
    }
    cards.push(card);
  });
  // similarity over the static geology measures: robust z (median and MAD), thicknesses on a log scale, clipped at 3;
  // the distance uses the measures both fields have, and needs at least 3 of the 4
  const tf = (f, v) => (v == null ? null : f.log ? Math.log(Math.max(v, 1)) : v);
  const ctr = {}, sc = {};
  for (const f of SIM) {
    const v = cards.map((c) => tf(f, c[f.key])).filter((x) => x != null), m = median(v);
    ctr[f.key] = m; sc[f.key] = 1.4826 * median(v.map((x) => Math.abs(x - m))) || 1;
  }
  const z = (c) => SIM.map((f) => { const v = tf(f, c[f.key]); return v == null ? null : Math.max(-3, Math.min(3, (v - ctr[f.key]) / sc[f.key])); });
  const Z = new Map(cards.map((c) => [c.name, z(c)]));
  const own = (o) => o.track.filter((t) => t.kind !== "near");
  for (const c of cards) {
    const a = Z.get(c.name); c.measures = a.filter((x) => x != null).length;
    if (c.measures < 3) { c.alike = []; continue; }
    c.alike = cards.filter((o) => o.name !== c.name).map((o) => {
      const b = Z.get(o.name), sh = a.map((x, i) => (x != null && b[i] != null ? (x - b[i]) ** 2 : null)).filter((x) => x != null);
      return sh.length < 3 ? null : { name: o.name, d: Math.sqrt(sh.reduce((s, x) => s + x, 0) / sh.length), shared: sh.length, wells: o.wells,
        use: own(o).some((t) => t.kind === "use"), ok: own(o).some((t) => t.ok === true), bad: own(o).some((t) => t.ok === false) };
    }).filter(Boolean).sort((p, q) => p.d - q.d).slice(0, 4);
  }
  return { cards, byName: new Map(cards.map((c) => [c.name, c])), n: cards.filter((c) => c.measures >= 3).length };
}

/** The field table as CSV rows, the open "common database" that the report asks for. */
export function fieldRows(fc, P) {
  const head = ["field", "left_to_plug", "log_pass", "log_fail", "log_not_covered", "fm_present", "fm_thin", "fm_absent", "fm_not_covered", "exploration_wells_used", "log_wells_used",
    ...FEATURES.map((f) => `${f.key}_${f.unit.replace("/", "_per_").replace("³", "3")}`), "longest_clay_on_logs_m", "track_record", "most_alike"];
  const rows = P ? [[`# Nature's Plug field table, computed with radius ${P.radiusKm} km, overbalance ${P.overbalance} g/cm3, gas ${P.gas} g/cm3, formationMin ${P.formationMin} m. Depths below the sea bed. Screening numbers, not measurements of the clay.`], head] : [head];
  for (const c of fc.cards) rows.push([c.name, c.left, c.log[2], c.log[1], c.log[0], c.fm[3], c.fm[2], c.fm[1], c.fm[0], c.wells, c.logWells,
    ...FEATURES.map((f) => (c[f.key] == null ? "" : c[f.key].toFixed(f.d))), c.longest ?? "", c.track.map((t) => t.text).join("; "), c.alike.map((a) => a.name).join("; ")]);
  return rows;
}
