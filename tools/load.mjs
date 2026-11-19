// Load the static data files from disk (Node). The browser does the same with fetch in js/data.js.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { prepareNeighbours } from "../js/engine.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
const read = (f) => JSON.parse(readFileSync(join(root, f), "utf8"));

export function loadData() {
  const wb = read("wellbores.json"), controls = read("controls.json"), layer1 = read("layer1.json");
  const fields = read("fields.json"), meta = read("meta.json"), validation = read("validation.json");
  return { wb, controls, layer1, fields, meta, validation, nb: prepareNeighbours(wb, controls, layer1) };
}
