// Green Clay: where the top of the informal "Green Clay" unit sits, predicted from the depths the operators quote in
// their own well reports (data/greenclay.json, built by pipeline/greenclay/). In the app it is a map layer, a card in
// the details of every well, and one sheet with the evidence behind it.
import { esc, fmt } from "./util.js";

const NS = "http://www.w3.org/2000/svg";

/** Thickness in metres from the thickness of the Hordaland Group: the fitted line, kept inside the range the sites cover. */
export function thickness(rule, hordaland) {
  return Math.min(hordaland, Math.max(rule.tmin, Math.min(rule.tmax, rule.a + rule.b * hordaland)));
}

// Sequential ramp for depth to the top: one hue, light (shallow) to dark (deep).
export const RAMP = [[204, 229, 255], [120, 178, 240], [42, 120, 214], [20, 70, 150], [10, 34, 86]];
export const D0 = 600, D1 = 2600;
export function ramp(v) {
  const t = Math.max(0, Math.min(1, (v - D0) / (D1 - D0))) * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(t)), f = t - i;
  const c = RAMP[i].map((a, k) => Math.round(a + (RAMP[i + 1][k] - a) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
export const rampCss = () => `linear-gradient(90deg, ${RAMP.map((c, i) => `rgb(${c.join(",")}) ${(i / (RAMP.length - 1)) * 100}%`).join(", ")})`;

/** Look-ups the map and the cards need. */
export function prepare(G) {
  G.exByName = new Map(G.ex.n.map((n, i) => [n, i]));
  return G;
}

const fact = (k, v) => `<div class="fact"><span>${k}</span><b>${v}</b></div>`;
const miss = (G) => `about ${fmt(G.cv.field.line.mae)} m; 9 in 10 within ${fmt(G.cv.field.line.p90)} m (${G.rule.sites} report sites)`;
const where = (km) => (km <= 10
  ? `<span class="pill"><i class="dot pass"></i>Named in a report ${km.toFixed(1)} km away</span>`
  : `<span class="pill"><i class="dot none"></i>Not named within 10 km (nearest ${fmt(km)} km)</span>`);

/** Card for a wellbore left to plug (index into data/wellbores.json). */
export function wbCard(G, wb, i) {
  const W = G.wb, top = W.top[i];
  let h = `<h3>Green Clay, predicted</h3>`;
  if (top == null) return h + `<p class="small muted">No vertical exploration well with both group tops within 10 km, so there is no prediction here.</p>`;
  h += `<div class="rowline">${where(W.kn[i])}</div>`;
  h += `<div class="facts">${fact("Predicted top", `${fmt(top)} m`)}${fact("Predicted interval", `${fmt(top)} to ${fmt(top + W.th[i])} m, ${fmt(W.th[i])} m thick`)}${fact("Group tops from", `${esc(G.refnames[W.ref[i]])}, ${W.rk[i].toFixed(1)} km away`)}${fact("Its own reports", W.own[i] ? `name the Green Clay ${W.own[i]} time${W.own[i] > 1 ? "s" : ""}` : "do not name it")}</div>`;
  h += `<p class="small muted">Metres below the rig floor. Typical miss ${miss(G)}.${W.kn[i] > 10 ? " Outside the area where reports name the unit, nothing shows that it exists." : ""} <a href="#" data-gc-open>How it was made and tested</a></p>`;
  return h;
}

/** Card for an exploration well, by name. */
export function exCard(G, name) {
  const i = G.exByName.get(name), E = G.ex;
  let h = `<h3>Green Clay, predicted</h3>`;
  if (i == null) return h + `<p class="small muted">No prediction: the well lacks the top of the Hordaland or the Rogaland Group, or it is not near-vertical.</p>`;
  h += `<div class="rowline">${where(E.kn[i])}</div>`;
  h += `<div class="facts">${fact("Predicted top", `${fmt(E.top[i])} m`)}${fact("Predicted interval", `${fmt(E.top[i])} to ${fmt(E.top[i] + E.th[i])} m, ${fmt(E.th[i])} m thick`)}${fact("Hordaland top", `${fmt(E.ho[i])} m`)}${fact("Rogaland top", `${fmt(E.ro[i])} m`)}</div>`;
  h += `<p class="small muted">Metres below the rig floor. Typical miss ${miss(G)}.${E.kn[i] > 10 ? " Outside the area where reports name the unit, nothing shows that it exists." : ""} <a href="#" data-gc-open>How it was made and tested</a></p>`;
  return h;
}

/** Tooltip lines for the map. */
export const tips = {
  wb(G, wb, i) {
    const W = G.wb;
    return W.top[i] == null ? "No prediction: no reference well within 10 km" : `Predicted top ${fmt(W.top[i])} m, ${fmt(W.th[i])} m thick<br><span class="sub">${W.kn[i] <= 10 ? `Green Clay named in a report ${W.kn[i].toFixed(1)} km away` : `Not named within 10 km (nearest ${fmt(W.kn[i])} km)`}</span>`;
  },
  ex(G, name) {
    const i = G.exByName.get(name), E = G.ex;
    return i == null ? "No Green Clay prediction for this well" : `Predicted top ${fmt(E.top[i])} m, ${fmt(E.th[i])} m thick<br><span class="sub">Hordaland top ${fmt(E.ho[i])} m, Rogaland top ${fmt(E.ro[i])} m · ${E.kn[i] <= 10 ? `named ${E.kn[i].toFixed(1)} km away` : "not named within 10 km"}</span>`;
  },
  site(G, i) {
    const s = G.sites[i];
    return `<b>Report site: ${esc(s.wells[0])}</b> <span class="sub">· ${esc(s.field)}</span><br>Reported top ${fmt(s.tvd)} m${s.ok ? `<br>Predicted without this field ${fmt(s.pred)} m (${s.err > 0 ? "+" : ""}${fmt(s.err)} m)` : `<br><span class="sub">Not used: ${esc(s.why || "")}</span>`}<br><span class="sub">Click for the quote and the source</span>`;
  },
};

// ------------------------------------------------------------------ the evidence sheet
function svg(w, h) { const s = document.createElementNS(NS, "svg"); s.setAttribute("viewBox", `0 0 ${w} ${h}`); s.setAttribute("role", "img"); return s; }
function el(parent, tag, attrs, text) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (text != null) e.textContent = text;
  parent.appendChild(e); return e;
}

function drawScatter(host, sites, stat) {
  const W = 380, H = 330, m = { l: 58, r: 14, t: 10, b: 38 }, lo = 600, hi = 1900;
  const x = (v) => m.l + (v - lo) / (hi - lo) * (W - m.l - m.r), y = (v) => H - m.b - (v - lo) / (hi - lo) * (H - m.t - m.b);
  const s = svg(W, H); s.setAttribute("aria-label", "Predicted against reported depth to the top of the Green Clay");
  for (let v = 600; v <= 1800; v += 300) {
    el(s, "line", { class: "gridl", x1: x(v), x2: x(v), y1: m.t, y2: H - m.b }); el(s, "line", { class: "gridl", x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) });
    el(s, "text", { x: x(v), y: H - m.b + 15, "text-anchor": "middle" }, fmt(v)); el(s, "text", { x: m.l - 6, y: y(v) + 4, "text-anchor": "end" }, fmt(v));
  }
  const e = stat.mae;
  el(s, "polygon", { points: `${x(lo)},${y(lo + e)} ${x(hi - e)},${y(hi)} ${x(hi)},${y(hi)} ${x(hi)},${y(hi - e)} ${x(lo + e)},${y(lo)} ${x(lo)},${y(lo)}`, fill: "var(--band)" });
  el(s, "line", { x1: x(lo), y1: y(lo), x2: x(hi), y2: y(hi), stroke: "var(--muted)", "stroke-width": 1, "stroke-dasharray": "4 4" });
  el(s, "text", { x: x(1840), y: y(1870) - 4, "text-anchor": "end" }, "exact");
  for (const p of sites) {
    const c = el(s, "circle", { class: "pt", cx: x(p.tvd), cy: y(p.pred), r: 5 });
    el(c, "title", {}, `${p.wells[0]} (${p.field})\nreported ${fmt(p.tvd)} m, predicted ${fmt(p.pred)} m, miss ${p.err > 0 ? "+" : ""}${fmt(p.err)} m`);
  }
  el(s, "text", { x: (m.l + W - m.r) / 2, y: H - 4, "text-anchor": "middle" }, "Reported top, m below the rig floor");
  el(s, "text", { x: 10, y: (m.t + H - m.b) / 2, "text-anchor": "middle", transform: `rotate(-90 10 ${(m.t + H - m.b) / 2})` }, "Predicted top, m");
  el(s, "text", { class: "lab", x: m.l + 8, y: m.t + 14 }, `Shaded: within ${fmt(e)} m, the average miss`);
  host.replaceChildren(s);
}

function drawBars(host, cv) {
  const rows = [["line", "This model: thickness follows the Hordaland Group"], ["nearest", "Copy the thickness from the nearest known site"],
    ["rule", "Fixed height above the Rogaland top"], ["middle", "Plain guess: the middle of the Hordaland Group"]];
  const W = 380, rowH = 62, H = rows.length * rowH + 8, max = Math.max(...rows.map((r) => cv[r[0]].mae)), x0 = 4, bw = W - 70;
  const s = svg(W, H); s.setAttribute("aria-label", "Average miss in metres for four ways to predict the top");
  rows.forEach(([k, label], i) => {
    const y = i * rowH + 6, v = cv[k].mae, w = Math.max(3, v / max * bw);
    el(s, "text", { class: "lab", x: x0, y: y + 13 }, label);
    el(s, "rect", { x: x0, y: y + 21, width: w, height: 20, rx: 4, fill: k === "line" ? "var(--accent)" : "var(--muted)", opacity: k === "line" ? 1 : .55 });
    el(s, "text", { class: "val", x: x0 + w + 8, y: y + 36 }, `${fmt(v)} m`);
  });
  host.replaceChildren(s);
}

function drawStack(host, L, R) {
  const W = 380, H = 330, m = { l: 48, r: 16, t: 26, b: 34 }, lo = -1.6, hi = 1.6, h0 = -100, h1 = 700;
  const x = (v) => m.l + (v - lo) / (hi - lo) * (W - m.l - m.r), y = (v) => m.t + (h1 - v) / (h1 - h0) * (H - m.t - m.b);
  const s = svg(W, H); s.setAttribute("aria-label", "Median resistivity, sonic and gamma ray against height above the top of the Rogaland Group");
  el(s, "rect", { x: m.l, y: y(R.height), width: W - m.l - m.r, height: y(0) - y(R.height), fill: "var(--band)" });
  el(s, "text", { class: "lab", x: W - m.r - 6, y: y(R.height) + 14, "text-anchor": "end" }, "Predicted Green Clay");
  for (let v = 0; v <= 600; v += 200) { el(s, "line", { class: "gridl", x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }); el(s, "text", { x: m.l - 6, y: y(v) + 4, "text-anchor": "end" }, v); }
  el(s, "line", { class: "ax", x1: x(0), x2: x(0), y1: m.t, y2: H - m.b });
  el(s, "text", { x: x(0), y: H - m.b + 15, "text-anchor": "middle" }, "group average"); el(s, "text", { x: x(lo) + 2, y: H - m.b + 15 }, "lower"); el(s, "text", { x: x(hi) - 2, y: H - m.b + 15, "text-anchor": "end" }, "higher");
  el(s, "text", { x: 12, y: (m.t + H - m.b) / 2, "text-anchor": "middle", transform: `rotate(-90 12 ${(m.t + H - m.b) / 2})` }, "Height above the Rogaland top, m");
  el(s, "text", { x: m.l - 6, y: y(0) + 16, "text-anchor": "end" }, "Rogaland");
  const series = [["rdep", "Resistivity", "var(--c1)", ""], ["dtc", "Sonic travel time", "var(--c2)", "6 3"], ["gr", "Gamma ray", "var(--c3)", "2 3"]];
  series.forEach(([k, name, col, dash], j) => {
    let d = "", pen = false;
    L.hb.forEach((h, i) => {
      const v = L.stack[k][i];
      if (v == null || h < 0 || h > h1) { pen = false; return; }
      d += `${pen ? "L" : "M"}${x(Math.max(lo, Math.min(hi, v))).toFixed(1)},${y(h + 5).toFixed(1)}`; pen = true;
    });
    el(s, "path", { d, fill: "none", stroke: col, "stroke-width": 2, "stroke-dasharray": dash, "stroke-linejoin": "round" });
    const lx = m.l - 40 + [0, 96, 226][j];
    el(s, "line", { x1: lx, x2: lx + 18, y1: 10, y2: 10, stroke: col, "stroke-width": 2, "stroke-dasharray": dash });
    el(s, "text", { class: "lab", x: lx + 23, y: 14 }, name);
  });
  host.replaceChildren(s);
}

function sitesTable(sites) {
  const rows = sites.map((s, n) => [s, n]).sort((a, b) => a[0].field.localeCompare(b[0].field) || a[0].tvd - b[0].tvd).map(([s, n]) => {
    const q = esc(s.text).replace("[Green Clay]", "<mark>Green Clay</mark>");
    const pred = s.ok ? `<td class="r">${fmt(s.pred)}</td><td class="r">${s.err > 0 ? "+" : ""}${fmt(s.err)}</td>` : `<td class="r" colspan="2">not used: ${esc(s.why || "")}</td>`;
    return `<tr id="gc-site-${n}"><td>${esc(s.field)}</td><td>${esc(s.wells[0])}${s.wells.length > 1 ? ` <span class="muted">+${s.wells.length - 1}</span>` : ""}</td><td class="r">${fmt(s.tvd)}</td>${pred}` +
      `<td class="r">${esc(s.ref)} <span class="muted">${s.ref_km.toFixed(1)} km</span></td><td class="q">…${q}…</td><td class="src">${esc(s.item.replace(/_/g, " ").toLowerCase())}, p. ${s.page}<br>${esc(s.file)}</td></tr>`;
  }).join("");
  return `<thead><tr><th>Field</th><th>Wellbore</th><th class="r">Reported top, m</th><th class="r">Predicted, m</th><th class="r">Miss, m</th><th class="r">Reference well</th><th>What the report says</th><th>Source</th></tr></thead><tbody>${rows}</tbody>`;
}

// Documented cases of clay as a barrier (data/barrier.json: read by hand from the reports, then compared with the atlas).
const OUT = { used: "Used as a barrier", logged: "Confirmed on log", planned: "Planned, result not public", failed: "Did not hold" };
function drawCases(root, B) {
  const order = { failed: 0, used: 1, logged: 2, planned: 3 };
  const cases = B.cases.slice().sort((a, b) => b.gc - a.gc || order[a.outcome] - order[b.outcome] || a.w.localeCompare(b.w));
  const good = cases.filter((c) => c.outcome === "used" || c.outcome === "logged"), bad = cases.filter((c) => c.outcome === "failed");
  const n = (list, f) => list.filter(f).length;
  root.querySelector("#gc-cases-sub").textContent = `${cases.length} wells from the public reports: ${good.length} where clay was used or confirmed on a log, ${bad.length} where it did not hold, ${cases.length - good.length - bad.length} where it was planned. ${n(cases, (c) => c.gc)} of them name the Green Clay.`;
  root.querySelector("#gc-cases").innerHTML = `<thead><tr><th>Wellbore</th><th>Unit</th><th>Outcome</th><th>What the report says</th><th>The screening says here</th><th class="r">Green Clay model, m</th><th>Source</th></tr></thead><tbody>` + cases.map((c) =>
    `<tr><td>${esc(c.w)}<br><span class="muted">${esc(c.area)}</span></td><td class="gc">${c.gc ? `<b>${esc(c.unit)}</b>` : esc(c.unit)}</td><td><span class="out ${c.outcome}">${OUT[c.outcome]}</span></td>` +
    `<td class="q">${esc(c.summary)}<br><span class="muted">${esc(c.how)}.</span></td>` +
    `<td class="says"><span>Logs: ${c.log ? `${c.log.cls} <span class="muted" style="display:inline">(${esc(c.log.well)}, ${c.log.km} km)</span>` : "no log well nearby"}</span><span>Formation: ${c.fm ? `clay ${c.fm.cls}` : "not covered"}</span></td>` +
    `<td class="r">${c.gcm ? `${fmt(c.gcm.top)}–${fmt(c.gcm.base)}` : "–"}</td><td class="src">${esc(c.src.item.replace(/_/g, " ").toLowerCase())}, p. ${c.src.page}${c.src.w !== c.w ? ` (in the report for ${esc(c.src.w)})` : ""}<br>${esc(c.src.file)}</td></tr>`).join("") + `</tbody>`;
  const gl = good.filter((c) => c.log), gf = good.filter((c) => c.fm), bl = bad.filter((c) => c.log), bf = bad.filter((c) => c.fm);
  root.querySelector("#gc-cases-note").textContent = `How the screening does against these: of the ${good.length} wells where clay held, the log level has a verdict for ${gl.length} and says pass for ${n(gl, (c) => c.log.cls === "pass")}; the formation level has a verdict for ${gf.length} and says present for ${n(gf, (c) => c.fm.cls === "present")}. ` +
    `For the ${bad.length} wells where it did not hold, the log level says fail for ${n(bl, (c) => c.log.cls === "fail")} of ${bl.length} and the formation level says absent for ${n(bf, (c) => c.fm.cls === "absent")} of ${bf.length}. ` +
    `So the screening is cautious: it misses most of the places where clay was accepted. One reason is that it tests the clay against the pressure of the main reservoir, while several of these wells used it against a shallower zone or used the Shetland Group, which the formation level does not count.`;
}

/** Fill the evidence sheet. `barrier` is data/barrier.json or null when it could not be loaded. */
export function renderEvidence(root, G, barrier) {
  const R = G.rule, cv = G.cv.field, ok = G.sites.filter((s) => s.ok), q = (id) => root.querySelector(id);
  q("#gc-kpis").innerHTML = [
    [fmt(R.named_wellbores), "wellbores whose public reports name the Green Clay"],
    [`${R.sites} sites`, `in ${R.fields} fields give its top as a depth`],
    [`${fmt(cv.line.mae)} m`, `average miss on a field the model has not seen (${fmt(cv.middle.mae)} m for a plain guess)`],
    [fmt(G.counts.named || 0), "wellbores left to plug within 10 km of a report that names it"],
    [`${G.logs.check.lower} of ${G.logs.check.n}`, "log wells with lower resistivity inside the predicted interval"],
  ].map(([b, s]) => `<div class="gc-kpi"><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join("");
  q("#gc-formula").textContent = `top = Rogaland top − thickness;  thickness = ${fmt(R.a)} m + ${R.b.toFixed(2)} × Hordaland thickness, kept within ${fmt(R.tmin)}–${fmt(R.tmax)} m`;
  q("#gc-lim-n").textContent = `${R.sites} sites in ${R.fields} fields, taken from ${R.wellbores} wellbores.`;
  q("#gc-sites-sub").textContent = `${R.sites_all} sites with a quoted depth, from ${fmt(R.mentions)} mentions in ${fmt(R.named_wellbores)} wellbores. Predicted depths are from the model fitted without that field.`;
  q("#gc-logs-sub").textContent = `Median of ${G.logs.n.rdep} log wells, each log scaled to its own Hordaland Group average. The band is a typical predicted interval.`;
  drawScatter(q("#gc-scatter"), ok, cv.line);
  drawBars(q("#gc-bars"), cv);
  drawStack(q("#gc-stack"), G.logs, R);
  q("#gc-sites").innerHTML = sitesTable(G.sites);
  if (barrier) drawCases(root, barrier); else q("#gc-cases-card").hidden = true;
}
