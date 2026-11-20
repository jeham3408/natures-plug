// Loads the static JSON files under data/ and builds the lookups the UI needs.
import { prepareNeighbours } from "./engine.js";
import { safeId } from "./util.js";
import { prepare as prepareGreenClay } from "./greenclay.js";

async function get(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`Could not load ${path} (${r.status})`);
  return r.json();
}

export async function loadAll(onProgress) {
  const names = ["meta", "wellbores", "controls", "layer1", "fields", "geo", "validation"];
  let done = 0;
  const parts = await Promise.all(names.map((n) => get(`data/${n}.json`).then((d) => { onProgress?.(++done / (names.length + 1)); return d; })));
  const [meta, wb, controls, layer1, fieldGeo, geo, validation] = parts;
  geo.quadrants.forEach((q) => { q[0] = String(q[0]).trim(); });
  const data = { meta, wb, controls, layer1, fieldGeo, geo, validation };
  // Wells that lie inside an open seismic cube, and the outlines of the cubes (written by seismic/server/prep_wells.py).
  const seis = await get("data/seismic_wells.json").catch(() => null);
  data.seis = { wells: (seis && seis.wells) || {}, cubes: (seis && seis.cubes) || {} };
  // Wells of an open cube that are not in the atlas (another country): where they are and what is open for them.
  data.ext = Object.entries(data.seis.wells).filter(([, v]) => v.ext).map(([n, v]) => ({ n, ds: v.ds, cube: v.cube, td: v.td, ...v.ext }));
  // The Green Clay model: predicted top for every exploration well and every wellbore left to plug, and the report sites.
  data.gc = await get("data/greenclay.json").then(prepareGreenClay).catch(() => null);
  data.nb = prepareNeighbours(wb, controls, layer1);
  onProgress?.(1);

  data.ctlByName = new Map(controls.map((c, i) => [c.name, i]));
  data.l1ByName = new Map(layer1.map((w, i) => [w.n, i]));
  data.extByName = new Map(data.ext.map((w, i) => [w.n, i]));
  data.wbByName = new Map(wb.name.map((n, i) => [n, i]));
  data.fieldGeoByName = new Map(fieldGeo.map((f, i) => [f.name, i]));
  data.fieldIdx = new Map(wb.fields.map((n, i) => [n, i]));
  // Wellbores per field, for the field card.
  data.wbOfField = wb.fields.map(() => []);
  wb.field.forEach((f, i) => { if (f >= 0) data.wbOfField[f].push(i); });
  return data;
}

const cache = new Map();
function cached(path) {
  if (!cache.has(path)) cache.set(path, get(path).catch((e) => { cache.delete(path); throw e; }));
  return cache.get(path);
}

/** Documented cases of clay used as a barrier (read by hand from the reports), for the Green Clay evidence sheet. */
export const loadBarrier = () => cached("data/barrier.json");
export const loadGreenClayCheck = () => cached("data/greenclay_check.json");

/** Full curves, tops, casing and report quotes for one control well. */
export const loadWell = (name) => cached(`data/wells/${safeId(name)}.json`);

/** Report quotes for a wellbore or an exploration well. Resolves to null when there are none. */
export const loadDocs = (name) => cached(`data/docs/${safeId(name)}.json`).catch(() => null);
