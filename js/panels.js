// Everything around the map: headline numbers, legend, the three left tabs and the detail panel on the right.
import { DEFAULTS, LOG, FM, distKm } from "./engine.js";
import { loadWell, loadDocs, loadBarrier } from "./data.js";
import { characterise, fieldRows, FEATURES } from "./fieldchar.js";
import { createTracks } from "./tracks.js";
import { $, $$, esc, fmt, title, strat, docType, factUrl } from "./util.js";
import { wbCard, exCard, tips as gcTips, rampCss, D0, D1 } from "./greenclay.js";

const LOG_NAME = ["not covered", "fails", "passes"], LOG_CLS = ["none", "fail", "pass"];
const FM_NAME = ["not covered", "absent", "thin", "present"], FM_CLS = ["none", "fail", "thin", "pass"];

const CTRLS = [
  { key: "rdepMax", label: "Deep resistivity below", unit: "Ω·m", min: 0.6, max: 3, step: 0.05, d: 2, help: "Smectite-rich clay conducts well. Lower is stricter." },
  { key: "grMin", label: "Gamma ray above", unit: "API", min: 0, max: 100, step: 1, d: 0, help: "Keeps clean sand out." },
  { key: "dtcMin", label: "Sonic slower than", unit: "µs/ft", min: 100, max: 170, step: 1, d: 0, help: "Soft, ductile rock is slow. Ignored where the curve is missing." },
  { key: "gas", label: "Gas gradient", unit: "g/cm³", min: 0.1, max: 0.5, step: 0.01, d: 2, help: "Weight of the gas column between the reservoir and the barrier." },
  { key: "overbalance", label: "Mud weight minus pore pressure", unit: "g/cm³", min: 0, max: 0.2, step: 0.01, d: 2, help: "Pore pressure is taken as the mud weight at the reservoir top minus this." },
  { key: "minLen", label: "Continuous length needed", unit: "m", min: 10, max: 100, step: 5, d: 0, help: "30 m is the normal criterion. 50 m is often asked for." },
  { key: "bridge", label: "Bridge gaps up to", unit: "m", min: 0, max: 5, step: 1, d: 0, help: "Lets thin streaks without the clay signature pass. 0 is strictly continuous." },
  { key: "radiusKm", label: "A well speaks for wellbores within", unit: "km", min: 2, max: 25, step: 1, d: 0, help: "Farther away, a wellbore counts as not covered." },
];

export function createPanels(app) {
  const { data } = app;
  const kpis = $("#kpis"), legend = $("#legend"), right = $("#right"), tip = $("#tip");
  const pFields = $("#panel-fields"), pAssume = $("#panel-assume"), pValid = $("#panel-valid");
  let tracks = null, fieldFilter = "", openToken = 0;
  // field characterisation (js/fieldchar.js): computed once per result, with the documented cases once they are loaded
  let barrierData = null, fcCache = null, fcFor = null, fcHadBarrier = false;
  loadBarrier().then((b) => { barrierData = b; fcFor = null; const s = app.state.sel; if (s && s.type === "field") showField(s.name); }).catch(() => {});
  const fieldChar = () => {
    const r = app.state.result;
    if (fcFor !== r || fcHadBarrier !== !!barrierData) { fcCache = characterise(data, r, barrierData); fcFor = r; fcHadBarrier = !!barrierData; }
    return fcCache;
  };

  const bar = (counts, classes, total, max) =>
    `<span class="bar" style="width:${Math.max(3, (total / max) * 100).toFixed(1)}%">${counts.map((n, c) => (n ? `<i class="${classes[c]}" style="flex:${n} 1 0"></i>` : "")).reverse().join("")}</span>`;

  // ------------------------------------------------------------------ headline numbers and legend
  function renderKpis() {
    const r = app.state.result, T = r.totals, P = app.state.P, log = app.state.level === "log";
    const k = (n, cls, text, short) => `<div class="kpi"><b>${cls ? `<i class="dot ${cls}"></i>` : ""}${fmt(n)}</b><span><span class="long">${text}</span><span class="short">${short}</span></span></div>`;
    if (app.state.level === "gc" && data.gc) {
      const G = data.gc, R = G.rule, kt = (b, text, short) => `<div class="kpi"><b>${b}</b><span><span class="long">${text}</span><span class="short">${short}</span></span></div>`;
      kpis.innerHTML = kt(fmt(R.named_wellbores), "wellbores whose reports name the Green Clay", "reports name it") + kt(`${R.sites} sites`, `in ${R.fields} fields give its top as a depth`, "with a depth")
        + kt(`${fmt(G.cv.field.line.mae)} m`, "average miss on a field the model has not seen", "average miss") + kt(fmt(G.counts.named || 0), "wellbores left to plug within 10 km of such a report", "left to plug nearby");
      return;
    }
    kpis.innerHTML = log
      ? k(T.left, "", "wellbores left to plug", "left to plug") + k(T.log[2], "pass", "near a log well that passes", "pass") + k(T.log[1], "fail", "near a log well that fails", "fail") + k(T.log[0], "none", `no assessed log well within ${P.radiusKm} km`, "not covered")
      : k(T.left, "", "wellbores left to plug", "left to plug") + k(T.fm[3], "pass", "clay group in the pressure window", "clay in window") + k(T.fm[1] + T.fm[2], "fail", `less than ${P.formationMin} m of it in the window`, "too little") + k(T.fm[0], "none", `no assessed well within ${P.radiusKm} km`, "not covered");
  }

  function renderLegend() {
    const r = app.state.result, T = r.totals, P = app.state.P, log = app.state.level === "log", m = app.map;
    const row = (cls, text, n) => `<div class="row"><span class="sym"><i class="dot ${cls}"></i></span>${text}<b>${fmt(n)}</b></div>`;
    const chk = (key, text) => `<label><input type="checkbox" data-show="${key}" ${m && m.isShown(key) ? "checked" : ""}>${text}</label>`;
    const nCubes = Object.keys(data.seis.cubes).length, cubesChk = nCubes ? chk("cubes", `Open seismic cubes (${nCubes})`) : "";
    if (app.state.level === "gc" && data.gc) {
      const G = data.gc, C = G.counts;
      legend.innerHTML = `<h4>Predicted top of the Green Clay</h4>
        <div class="gc-ramp"><span>${fmt(D0)} m</span><i style="background:${rampCss()}"></i><span>${fmt(D1)} m</span></div>
        <div class="row"><span class="sym"><i class="gc-dot"></i></span>A report names it within 10 km<b>${fmt(C.named || 0)}</b></div>
        <div class="row"><span class="sym"><i class="gc-dot ring"></i></span>Model only: nothing shows it exists here<b>${fmt(C.rule || 0)}</b></div>
        <div class="row"><span class="sym"><i class="dot none"></i></span>No prediction<b>${fmt(C.none || 0)}</b></div>
        <div class="row"><span class="sym"><i class="gc-site"></i></span>Report site with a quoted depth<b>${fmt(G.sites.length)}</b></div>
        <hr><div class="rowline"><button type="button" class="btn" data-gc-open>How it was made and tested</button></div>`
        + chk("l1", "Exploration wells") + cubesChk + chk("quads", "Quadrants");
      return;
    }
    legend.innerHTML = `<h4>Wellbores left to plug</h4>` + (log
      ? row("pass", `At least ${P.minLen} m clay in the pressure window`, T.log[2]) + row("fail", "Less than that", T.log[1]) + row("none", "No assessed log well nearby", T.log[0])
      : row("pass", `At least ${P.formationMin} m of clay group in the window`, T.fm[3]) + row("thin", "Less than that", T.fm[2]) + row("fail", "Clay group above the window", T.fm[1]) + row("none", "No assessed well nearby", T.fm[0]))
      + `<hr><div class="row"><span class="sym"><i class="diamond"></i></span>Well with open logs<b>${fmt(T.controls.all)}</b></div>`
      + chk("l1", `Formation-level wells (${fmt(T.layer1.assessed)} assessed)`) + cubesChk + chk("co2", "CO₂ storage licences") + chk("quads", "Quadrants");
  }
  legend.addEventListener("change", (e) => {
    const k = e.target.dataset.show;
    if (k) app.map.setShow(k, e.target.checked);
  });

  // ------------------------------------------------------------------ left: fields
  function renderFields() {
    const r = app.state.result, log = app.state.level === "log", sel = app.state.sel;
    const rows = r.fields.filter((f) => f.left > 0).sort((a, b) => b.left - a.left);
    const max = rows.length ? rows[0].left : 1, q = fieldFilter.trim().toLowerCase();
    const list = rows.filter((f) => !q || f.name.toLowerCase().includes(q)).map((f) => {
      const g = data.fieldGeo[data.fieldGeoByName.get(f.name)], use = g && g.use;
      const on = sel && sel.type === "field" && sel.name === f.name;
      const b = log ? bar(f.log, LOG_CLS, f.left, max) : bar(f.fm, FM_CLS, f.left, max);
      const t = log ? `${f.log[2]} pass, ${f.log[1]} fail, ${f.log[0]} not covered` : `${f.fm[3]} present, ${f.fm[2]} thin, ${f.fm[1]} absent, ${f.fm[0]} not covered`;
      return `<button type="button" class="frow${on ? " is-selected" : ""}" data-field="${esc(f.name)}" title="${esc(title(f.name))}: ${f.left} left. ${t}."><span class="fname">${esc(title(f.name))}${use ? '<span class="mark" title="Use of creeping shale is documented here">◆</span>' : ""}</span>${b}<span class="ftot">${fmt(f.left)}</span></button>`;
    }).join("");
    if (!$("#field-filter")) {
      pFields.innerHTML = `<p class="lead">Wellbores that are not permanently plugged, by field. Colour shows what the nearest ${log ? "well with open logs" : "assessed exploration well"} says.</p>
        <input class="filter" id="field-filter" type="search" placeholder="Filter fields" aria-label="Filter fields" autocomplete="off">
        <div class="flist" id="flist"></div>
        <p class="small muted">◆ marks fields where Havtil's 2025 report documents use of creeping shale as a well barrier.</p>
        <div class="rowline"><button type="button" class="btn" id="csv">Download the wellbore list (CSV)</button></div>`;
      $("#csv").addEventListener("click", downloadCsv);
      $("#field-filter").addEventListener("input", (e) => { fieldFilter = e.target.value; renderFields(); });
      $("#flist").addEventListener("click", (e) => {
        const b = e.target.closest("[data-field]");
        if (b) app.selectField(b.dataset.field, true);
      });
    }
    $("p.lead", pFields).textContent = `Wellbores that are not permanently plugged, by field. Colour shows what the nearest ${log ? "well with open logs" : "assessed exploration well"} says.`;
    $("#flist").innerHTML = list || `<p class="muted small">No field matches.</p>`;
  }

  /** Every wellbore left to plug with both results, for use outside the app. */
  function downloadCsv() {
    const r = app.state.result, w = data.wb, q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["wellbore", "field", "status", "purpose", "completed", "lat", "lon", "log_level", "log_well", "log_well_km", "longest_clay_in_window_m", "formation_level", "formation_well", "formation_well_km", "clay_group_in_window_m"]];
    for (let i = 0; i < w.name.length; i++) {
      const j = r.ctlIdx[i], k = r.l1Idx[i], a = j >= 0 ? r.ctl[j] : null;
      rows.push([w.name[i], w.field[i] >= 0 ? w.fields[w.field[i]] : "", w.statuses[w.status[i]], w.purpose[i] >= 0 ? w.purposes[w.purpose[i]] : "", w.year[i] ?? "", w.lat[i], w.lon[i],
        LOG_NAME[r.cls[i]], j >= 0 ? data.controls[j].name : "", j >= 0 ? r.ctlKm[i].toFixed(1) : "", a ? a.zones[a.zone].longest : "",
        FM_NAME[r.cls1[i]], k >= 0 ? data.layer1[k].n : "", k >= 0 ? r.l1Km[i].toFixed(1) : "", k >= 0 ? r.l1[k].inWindow : ""]);
    }
    const blob = new Blob([rows.map((x) => x.map(q).join(",")).join("\n")], { type: "text/csv" }), a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "natures-plug-wellbores.csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ------------------------------------------------------------------ left: assumptions
  function renderAssume() {
    const P = app.state.P;
    pAssume.innerHTML = `<p class="lead">Every number on this page follows from these assumptions. Move one and the map is recalculated.</p>
      <h3>Clay signature in the logs</h3>${CTRLS.slice(0, 3).map(ctrl).join("")}
      <h3>Pressure the barrier must hold</h3>${CTRLS.slice(3, 5).map(ctrl).join("")}
      <div class="ctrl"><div class="ctrl-head"><label>Zone to isolate</label></div>
        <div class="seg" id="zone-mode"><button type="button" data-zone="shallowest" class="${P.zoneMode === "shallowest" ? "is-active" : ""}">Shallowest</button><button type="button" data-zone="deepest" class="${P.zoneMode === "deepest" ? "is-active" : ""}">Deepest</button></div>
        <small>Which named hydrocarbon zone the barrier is tested against.</small></div>
      <h3>Barrier length and reach</h3>${CTRLS.slice(5).map(ctrl).join("")}
      <div class="rowline"><button type="button" class="btn" id="reset-assume">Reset to defaults</button></div>
      <div class="box"><b>These are screening assumptions.</b><span>Pore pressure comes from mud weight, which is too high by an unknown margin. Real formation pressures are in the well reports and should replace it.</span></div>`;
    function ctrl(c) {
      const v = P[c.key], changed = v !== DEFAULTS[c.key];
      return `<div class="ctrl${changed ? " is-changed" : ""}" data-ctrl="${c.key}"><div class="ctrl-head"><label for="in-${c.key}">${c.label}</label><output for="in-${c.key}">${fmt(v, c.d)} ${c.unit}</output></div>
        <input type="range" id="in-${c.key}" min="${c.min}" max="${c.max}" step="${c.step}" value="${v}"><small>${c.help}</small></div>`;
    }
  }
  pAssume.addEventListener("input", (e) => {
    const box = e.target.closest("[data-ctrl]");
    if (!box) return;
    const c = CTRLS.find((x) => x.key === box.dataset.ctrl), v = Number(e.target.value);
    $("output", box).textContent = `${fmt(v, c.d)} ${c.unit}`;
    box.classList.toggle("is-changed", v !== DEFAULTS[c.key]);
    app.setParam(c.key, v);
  });
  pAssume.addEventListener("click", (e) => {
    const z = e.target.closest("[data-zone]");
    if (z) { app.setParam("zoneMode", z.dataset.zone); renderAssume(); }
    if (e.target.id === "reset-assume") { app.resetParams(); renderAssume(); }
  });

  // ------------------------------------------------------------------ left: validation
  function renderValid() {
    const r = app.state.result, V = data.validation, P = app.state.P;
    const use = Object.entries(V.documented_use).map(([name, u]) => {
      const f = r.fields.find((x) => x.name === name);
      const who = `<td>${esc(title(name))}<br><span class="muted small">${esc(u[0])}</span></td>`;
      if (!f) return `<tr>${who}<td class="r">0</td><td class="muted">no wellbores left</td></tr>`;
      return `<tr class="click" data-field="${esc(name)}">${who}<td class="r">${fmt(f.left)}</td><td><span class="num">${fmt(f.fm[3])} of ${fmt(f.left)}</span><span class="bar" style="width:100%;margin-top:4px">${f.fm.map((n, c) => (n ? `<i class="${FM_CLS[c]}" style="flex:${n} 1 0"></i>` : "")).reverse().join("")}</span></td></tr>`;
    }).join("");
    const A = r.agree;
    const rates = V.doc_rates.filter((x) => x.kind === "clay").sort((a, b) => b.per_km - a.per_km).slice(0, 8), mx = rates.length ? rates[0].per_km : 1;
    const hi = ["NORDLAND GP", "HORDALAND GP", "ROGALAND GP"];
    pValid.innerHTML = `<p class="lead">Open data has no bond logs, so the screen cannot be checked against verified barriers. These are the checks that are possible.</p>
      <h3>Does it find the fields where the method is used?</h3>
      <table><thead><tr><th>Field</th><th class="r">Left</th><th>Clay group in window</th></tr></thead><tbody>${use}</tbody></table>
      <p class="small muted">Fields named in Havtil's 2025 knowledge report. The screen was not told which they are.</p>
      <h3>Do the two levels agree?</h3>
      <table class="matrix"><thead><tr><th></th><th>Clay group in window</th><th>Not in window</th></tr></thead>
        <tbody><tr><th>Logs pass</th><td><b>${A.passPresent}</b></td><td><b>${A.passOther}</b></td></tr><tr><th>Logs fail</th><td><b>${A.failPresent}</b></td><td><b>${A.failOther}</b></td></tr></tbody></table>
      <p class="small muted">Wells that have both. Formation tops alone find nearly every well that passes, and also flag ${A.failPresent} that fail. The logs are needed to tell them apart.</p>
      <h3>What the well reports say</h3>
      <div>${rates.map((x) => `<div class="hbar${hi.includes(x.group) ? " hi" : ""}"><span>${esc(strat(x.group))}</span><i style="width:${((x.per_km / mx) * 100).toFixed(1)}%"></i><span>${x.per_km.toFixed(2)}</span></div>`).join("")}</div>
      <p class="small muted">Mentions of gumbo, swelling, plastic or mobile clay and creep per kilometre drilled, from ${fmt(V.doc_totals.pages)} report pages. Plain tight-hole and overpull mentions do not single out these groups.</p>
      <h3>The same measures for every field</h3>
      <p class="small">Havtil's 2025 knowledge report says there is most likely a need for a more systematic formation characterisation across fields. It calls work on geologically similar layers promising for transferring track records, but one that will require consistent geological and geomechanical criteria, and it calls for structured information sharing through common databases. Each field card offers a first, open attempt on one narrow set of measures: depth, thickness and pressure-window numbers for the clay groups, not creep properties.</p>
      <p><button type="button" class="btn" id="dl-fields">Download the field table (CSV, current settings)</button></p>
      <p class="small muted">One table from this tool, computed with the settings above. It is not a substitute for the common databases the report asks for.</p>
      <div class="box"><b>What this is not</b><span>Nothing here verifies a barrier. A wellbore inherits the result of a neighbouring exploration well within ${P.radiusKm} km. Use it to decide where a bond log is most likely to pay off.</span></div>`;
  }
  pValid.addEventListener("click", (e) => {
    if (e.target.closest("#dl-fields")) { downloadFieldCsv(); return; }
    const t = e.target.closest("[data-field]");
    if (t) { app.setLevel("fm"); app.selectField(t.dataset.field, true); }
  });

  // ------------------------------------------------------------------ quotes
  function quoteHtml(q, i, clickable) {
    const kw = esc(q.k), re = new RegExp(q.k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const body = esc(q.s).replace(re, (m) => `<mark>${m}</mark>`);
    const depth = q.d && q.d.length ? `${q.d.slice(0, 3).map((d) => fmt(d)).join(", ")} m${q.g && q.g.length ? " · " + q.g.map(strat).join(", ") : ""}` : "";
    return `<li class="quote${clickable && q.d && q.d.length ? " is-click" : ""}" data-q="${i}"><div class="q-head"><span class="kw${q.c > 0 ? " gen" : ""}">${kw}</span>${depth ? `<span>${depth}</span>` : ""}<span>${esc(docType(q.t))} · page ${q.p}</span></div><p>…${body}…</p><div class="q-file">${esc(q.f)}</div></li>`;
  }
  function quotesBlock(docs, clickable) {
    if (!docs || (!docs.hits.length && !docs.pa.length)) return `<p class="muted small">No report text for this well in the open Diskos set.</p>`;
    const s = docs.summary || [0, 0, 0, 0, 0, 0];
    return `<div class="rowline"><div class="seg qtabs" id="qtabs"><button type="button" class="is-active" data-q="hits">Clay and hole problems (${docs.hits.length})</button><button type="button" data-q="pa">Cement, plugs, bond logs (${docs.pa.length})</button></div></div>
      <p class="small muted">${fmt(s[1])} report pages in ${fmt(s[0])} files. Keyword matches, not interpreted. OCR text is shown as it is.</p>
      <ul class="quotes" id="q-hits">${docs.hits.map((q, i) => quoteHtml(q, i, clickable)).join("") || '<li class="muted small">No matches.</li>'}</ul>
      <ul class="quotes" id="q-pa" hidden>${docs.pa.map((q, i) => quoteHtml({ ...q, c: 1 }, i, false)).join("") || '<li class="muted small">No matches.</li>'}</ul>`;
  }
  right.addEventListener("click", (e) => {
    const tab = e.target.closest("#qtabs [data-q]");
    if (tab) {
      $$("#qtabs button", right).forEach((b) => b.classList.toggle("is-active", b === tab));
      $("#q-hits", right).hidden = tab.dataset.q !== "hits"; $("#q-pa", right).hidden = tab.dataset.q !== "pa";
      return;
    }
    const q = e.target.closest("#q-hits .quote.is-click");
    if (q && tracks) { markQuote(Number(q.dataset.q)); tracks.activate(Number(q.dataset.q)); $(".tracks", right)?.scrollIntoView({ block: "nearest", behavior: "smooth" }); return; }
    const go = e.target.closest("[data-go]");
    if (go) {
      e.preventDefault();
      const [type, key] = go.dataset.go.split("|");
      if (type === "ctl") app.selectControl(key, true); else if (type === "wb") app.selectWellbore(key, true); else if (type === "l1") app.selectLayer1(key, true); else if (type === "field") app.selectField(key, true);
      return;
    }
    if (e.target.closest("#d-close")) app.select(null);
    const pr = e.target.closest("[data-preset]");
    if (pr && tracks) tracks.preset(pr.dataset.preset);
    const zb = e.target.closest("[data-zonepick]");
    if (zb) app.setOverride(zb.dataset.well, { zone: Number(zb.dataset.zonepick), pp: null });
    if (e.target.id === "pp-reset") app.setOverride(e.target.dataset.well, { pp: null });
    if (e.target.id === "wb-all") { e.target.closest(".wlist").querySelectorAll("[hidden]").forEach((b) => (b.hidden = false)); e.target.remove(); }
  });
  // The pore pressure field is plain text, so it shows a decimal point whatever the browser language is. A comma is read as one.
  const readPp = (el) => Number(String(el.value).trim().replace(",", "."));
  right.addEventListener("change", (e) => {
    if (e.target.id === "pp-input") {
      const v = readPp(e.target);
      app.setOverride(e.target.dataset.well, { pp: v >= 0.9 && v <= 2.4 ? v : null });
    }
  });
  right.addEventListener("keydown", (e) => {
    if (e.target.id !== "pp-input" || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const v = readPp(e.target);
    if (!Number.isFinite(v)) return;
    e.preventDefault();
    const next = Math.round((v + (e.key === "ArrowUp" ? 0.01 : -0.01)) * 100) / 100;
    app.setOverride(e.target.dataset.well, { pp: Math.min(2.4, Math.max(0.9, next)) });
    requestAnimationFrame(() => requestAnimationFrame(() => $("#pp-input", right)?.focus()));
  });
  function markQuote(i) { $$("#q-hits .quote", right).forEach((li) => li.classList.toggle("is-active", Number(li.dataset.q) === i)); }

  // ------------------------------------------------------------------ right: shared bits
  // Wells that lie inside an open seismic cube get a button that shows them on seismic (the workspace handles the click).
  const seisLink = (name) => { const w = data.seis.wells[name]; return w ? `<button type="button" class="btn" data-seis-well="${esc(name)}" title="${esc(w.cube || "")}: logs, tops and well tie on the seismic">On seismic →</button>` : ""; };
  const head = (name, sub, pill) => `<div class="d-head"><div><h2>${esc(name)}</h2><p>${sub}</p></div><div class="rowline">${seisLink(name)}${pill || ""}<button type="button" class="btn icon close" id="d-close" aria-label="Close details">×</button></div></div>`;
  const fact = (k, v) => `<div class="fact"><span>${k}</span><b>${v}</b></div>`;
  const logPill = (a, big) => {
    if (!a.assessed) return `<span class="pill${big ? " big" : ""}"><i class="dot none"></i>Not assessed</span>`;
    const z = a.zones[a.zone];
    return `<span class="pill${big ? " big" : ""}"><i class="dot ${z.cls === 2 ? "pass" : "fail"}"></i>${z.cls === 2 ? "Passes" : "Fails"} · ${fmt(z.longest)} m</span>`;
  };
  const fmPill = (a, big) => (a.assessed ? `<span class="pill${big ? " big" : ""}"><i class="dot ${FM_CLS[a.cls]}"></i>${title(FM_NAME[a.cls])} · ${fmt(a.inWindow)} m</span>` : `<span class="pill${big ? " big" : ""}"><i class="dot none"></i>Not assessed</span>`);

  function controlSentence(c, a) {
    const P = app.state.P;
    if (!a.assessed) return `<b>Not assessed.</b> ${esc(a.reason)}. The clay signature covers ${fmt(a.clayHord + a.clayRog)} m of the Hordaland and Rogaland groups here.`;
    const z = a.zones[a.zone], clay = a.clayHord + a.clayRog;
    if (z.cls === LOG.PASS) return `<b>Passes.</b> ${fmt(z.longest)} m of continuous ductile clay lies deep enough to hold the ${esc(strat(z.name))} with a gas column${z.bestGroup ? `, in the ${esc(strat(z.bestGroup))}` : ""}. ${fmt(z.net)} m in total.`;
    if (z.zminMd == null) return `<b>Fails.</b> No leak-off test above the ${esc(strat(z.name))} reaches the pressure needed.`;
    if (z.longest > 0) return `<b>Fails.</b> The longest continuous clay interval inside the pressure window is ${fmt(z.longest)} m. ${P.minLen} m is needed.`;
    return `<b>Fails.</b> The clay signature is there, ${fmt(clay)} m of it, but the pressure only holds below ${fmt(z.zminMd)} m. All of the clay lies above that.`;
  }

  // ------------------------------------------------------------------ right: control well
  function controlHeader(c, a) {
    const z = a.assessed ? a.zones[a.zone] : null, ov = app.state.overrides[c.name] || {};
    const sub = [c.field ? `near ${esc(title(c.field))}` : null, c.year ? `drilled ${c.year}` : null, c.operator ? esc(c.operator) : null].filter(Boolean).join(" · ");
    let h = head(c.name, `Exploration well with open logs${sub ? " · " + sub : ""}`, logPill(a, true));
    h += `<div class="verdict">${controlSentence(c, a)}</div>`;
    const f = [];
    if (z) {
      f.push(fact("Zone to isolate", `${esc(strat(z.name))} at ${fmt(z.topMd)} m`));
      f.push(`<div class="fact"><span>Pore pressure, g/cm³</span><span class="rowline"><input id="pp-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="${z.pp.toFixed(2)}" data-well="${esc(c.name)}" aria-label="Pore pressure in grams per cubic centimetre">${ov.pp != null ? `<button type="button" class="btn ghost small" id="pp-reset" data-well="${esc(c.name)}">reset</button>` : ""}</span></div>`);
      f.push(fact("Pressure holds from", z.zminMd == null ? "nowhere" : `${fmt(z.zminMd)} m`));
      f.push(fact("Clay inside the window", `${fmt(z.net)} m, longest ${fmt(z.longest)} m`));
    }
    f.push(fact("Clay signature in total", `${fmt(a.clayHord)} m Hordaland, ${fmt(a.clayRog)} m Rogaland`));
    f.push(fact("Mud in the clay groups", c.mud === "WBM" ? "Water-based" : c.mud === "OBM" ? "Oil-based" : c.mud === "mixed" ? "Both types" : "Not known"));
    h += `<div class="facts">${f.join("")}</div>`;
    if (a.assessed && a.zones.length > 1) h += `<div class="rowline"><span class="small muted">Test against</span><div class="seg">${a.zones.map((zz, k) => `<button type="button" data-zonepick="${zz.k}" data-well="${esc(c.name)}" class="${k === a.zone ? "is-active" : ""}">${esc(strat(zz.name))}</button>`).join("")}</div></div>`;
    return h;
  }

  async function showControl(i) {
    const c = data.controls[i], a = app.state.result.ctl[i], token = ++openToken;
    right.hidden = false;
    right.innerHTML = `<div class="detail" id="detail"><div id="d-top">${controlHeader(c, a)}</div>
      <div class="rowline"><div class="seg"><button type="button" data-preset="over">Overburden</button><button type="button" data-preset="full">Whole well</button></div><span class="small muted">Scroll to zoom the depth, drag to move.</span></div>
      <div class="tracks" id="tracks"><p class="muted small" style="padding:14px">Loading logs…</p></div>
      <div class="trk-legend"><span><i class="sw l1"></i>Deep resistivity, measured curves</span><span><i class="sw l3"></i>Medium resistivity, bit size</span><span><i class="sw wash"></i>Clay signature</span><span><i class="sw pass"></i>Clay inside the pressure window</span><span><i class="sw l2"></i>Pressure needed</span><span><i class="sw l1"></i>Leak-off tests</span></div>
      ${data.gc ? exCard(data.gc, c.name) : ""}
      <h3>From the well reports</h3><div id="quotes"><p class="muted small">Loading…</p></div>
      <p class="small"><a href="${factUrl.exp(c.npdid)}" target="_blank" rel="noopener">Open ${esc(c.name)} in FactPages</a></p></div>`;
    let well;
    try { well = await loadWell(c.name); } catch (err) { if (token === openToken) $("#tracks", right).innerHTML = `<p class="small" style="padding:14px">Could not load the logs for this well. ${esc(err.message)}</p>`; return; }
    if (token !== openToken) return;
    const docs = well.quotes;
    $("#quotes", right).innerHTML = quotesBlock(docs, true);
    const host = $("#tracks", right);
    tracks?.destroy();
    tracks = createTracks(host, well, {
      P: app.state.P, assess: app.state.result.ctl[i], quotes: docs ? docs.hits : [], lith: data.meta.lith, tip,
      height: Math.max(380, Math.min(760, window.innerHeight - 330)),
      onQuote: (qi) => { markQuote(qi); tracks.activate(qi); $(`#q-hits .quote[data-q="${qi}"]`, right)?.scrollIntoView({ block: "nearest", behavior: "smooth" }); },
    });
  }

  // ------------------------------------------------------------------ right: field
  /** The clay groups of one field, measured the same way as every other field, its closest analogues and track record. */
  function charBlock(C) {
    const val = (f) => (C[f.key] == null ? "–" : `${fmt(C[f.key], f.d)} ${f.unit}`);
    let h = `<h3>Clay groups in the nearest exploration wells</h3><div class="facts">${FEATURES.map((f) => fact(f.label, val(f))).join("")}</div>`;
    h += `<p class="small muted">Medians over the ${fmt(C.wells)} exploration well${C.wells === 1 ? "" : "s"} nearest to this field's wellbores, from formation tops, leak-off tests and mud weight. Depths below the sea bed. Every field is treated the same way. These are depth, thickness and pressure-window numbers: they do not describe creep, swelling or other mechanical properties of the clay, and the pressure values are screening assumptions, not measurements.</p>`;
    if (C.alike.length) {
      const mark = (a) => [a.bad ? `<span class="pill"><i class="dot fail"></i>failure reported</span>` : "", a.ok ? `<span class="pill"><i class="dot pass"></i>used or logged</span>` : a.use ? `<span class="pill">documented use</span>` : ""].join("");
      h += `<h3>Fields with the most similar numbers</h3><div class="neigh">${C.alike.map((a) => `<button type="button" data-go="field|${esc(a.name)}"><span>${esc(title(a.name))} <span class="muted">· ${fmt(a.wells)} well${a.wells === 1 ? "" : "s"}</span></span><span>${fmt(a.d, 2)}</span><span>${mark(a)}</span></button>`).join("")}</div>`;
      h += `<p class="small muted">Closeness in Hordaland depth and thickness, Rogaland thickness and pore pressure only (robust standard units). It has not been shown to predict how the clay behaves, and no creep or geomechanical criteria are included. Check a similar field's track record against its own geology before relying on it.</p>`;
    } else h += `<p class="small muted">Too few measures here to compare with other fields.</p>`;
    h += `<h3>Track record</h3>` + (C.track.length ? `<ul class="small">${C.track.map((t) => `<li>${t.ok === false ? "✗ " : t.ok ? "✓ " : "· "}${esc(t.text)}</li>`).join("")}</ul>` : `<p class="small muted">No documented case found in the sources read here. This does not mean the clay has been tested.</p>`);
    return h;
  }
  /** One row per field: the open, shared table the report asks for. */
  function downloadFieldCsv() {
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`, rows = fieldRows(fieldChar(), app.state.P);
    const blob = new Blob([rows.map((x) => x.map(q).join(",")).join("\n")], { type: "text/csv" }), a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "natures-plug-fields.csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function showField(name) {
    const r = app.state.result, gi = data.fieldGeoByName.get(name), g = data.fieldGeo[gi], wi = data.fieldIdx.get(name), F = wi != null ? r.fields[wi] : null, P = app.state.P;
    const sub = [g && g.operator ? esc(g.operator) : null, g && g.activity ? esc(g.activity) : null, g && g.hc ? esc(g.hc.toLowerCase()) : null].filter(Boolean).join(" · ");
    let h = head(title(name), sub || "Field", F ? `<span class="pill big">${fmt(F.left)} left to plug</span>` : "");
    if (!F) { h += `<div class="verdict"><b>No wellbores left to plug</b> in FactPages for this field.</div>`; }
    else {
      const st = {}; data.wbOfField[wi].forEach((i) => { const s = data.wb.statuses[data.wb.status[i]]; st[s] = (st[s] || 0) + 1; });
      h += `<div class="facts">${Object.entries(st).sort((a, b) => b[1] - a[1]).map(([s, n]) => fact(title(s.toLowerCase()), fmt(n))).join("")}</div>`;
      h += `<h3>Log level</h3><div class="rowline">${bar(F.log, LOG_CLS, F.left, F.left)}</div><p class="small">${fmt(F.log[2])} near a log well that passes, ${fmt(F.log[1])} near one that fails, ${fmt(F.log[0])} with no assessed log well within ${P.radiusKm} km.</p>`;
      h += `<h3>Formation level</h3><div class="rowline">${bar(F.fm, FM_CLS, F.left, F.left)}</div><p class="small">${fmt(F.fm[3])} with at least ${P.formationMin} m of Hordaland or Rogaland Group inside the pressure window, ${fmt(F.fm[2])} with less, ${fmt(F.fm[1])} with the clay group above the window, ${fmt(F.fm[0])} not covered.</p>`;
      const C = fieldChar().byName.get(name);
      if (C) h += charBlock(C);
    }
    if (g && g.use) h += `<div class="verdict"><b>Use is documented here.</b> ${esc(g.use[0])}: ${esc(g.use[1].charAt(0).toLowerCase() + g.use[1].slice(1))} (${esc(g.use[2])}).</div>`;
    if (g) {
      const near = data.controls.map((c, i) => [c.lat == null ? 1e9 : distKm(g.c[1], g.c[0], c.lat, c.lon), i]).sort((a, b) => a[0] - b[0]).slice(0, 5).filter((x) => x[0] < 40);
      if (near.length) h += `<h3>Nearest wells with open logs</h3><div class="neigh">${near.map(([d, i]) => `<button type="button" data-go="ctl|${esc(data.controls[i].name)}"><span>${esc(data.controls[i].name)}</span><span>${fmt(d, 1)} km</span><span>${logPill(r.ctl[i])}</span></button>`).join("")}</div>`;
    }
    if (F) {
      const list = data.wbOfField[wi], cls = app.state.level === "log" ? r.cls : r.cls1, names = app.state.level === "log" ? LOG_CLS : FM_CLS;
      h += `<h3>Wellbores left to plug</h3><div class="wlist">${list.map((i, k) => `<button type="button" data-go="wb|${esc(data.wb.name[i])}"${k >= 48 ? " hidden" : ""}><i class="dot ${names[cls[i]]}"></i>${esc(data.wb.name[i])}</button>`).join("")}${list.length > 48 ? `<button type="button" id="wb-all">Show all ${list.length}</button>` : ""}</div>`;
    }
    if (g && g.npdid) h += `<p class="small"><a href="${factUrl.field(g.npdid)}" target="_blank" rel="noopener">Open ${esc(title(name))} in FactPages</a></p>`;
    openToken++; tracks?.destroy(); tracks = null;
    right.hidden = false; right.innerHTML = `<div class="detail">${h}</div>`;
  }

  // ------------------------------------------------------------------ right: wellbore left to plug
  async function showWellbore(i) {
    const w = data.wb, r = app.state.result, P = app.state.P, name = w.name[i], token = ++openToken;
    const field = w.field[i] >= 0 ? w.fields[w.field[i]] : null;
    const sub = [field ? `<a href="#" data-go="field|${esc(field)}">${esc(title(field))}</a>` : "No field", esc(title(w.statuses[w.status[i]].toLowerCase())), w.purpose[i] >= 0 ? esc(w.purposes[w.purpose[i]].toLowerCase()) : null, w.year[i] ? `completed ${w.year[i]}` : null].filter(Boolean).join(" · ");
    const j = r.ctlIdx[i], k = r.l1Idx[i];
    const lvl = app.state.level === "log";
    let h = head(name, `Wellbore left to plug · ${sub}`, lvl ? `<span class="pill big"><i class="dot ${LOG_CLS[r.cls[i]]}"></i>${title(LOG_NAME[r.cls[i]])}</span>` : `<span class="pill big"><i class="dot ${FM_CLS[r.cls1[i]]}"></i>${title(FM_NAME[r.cls1[i]])}</span>`);
    h += `<div class="verdict">${j >= 0
      ? `<b>Log level: ${LOG_NAME[r.cls[i]]}.</b> Inherited from ${esc(data.controls[j].name)}, ${fmt(r.ctlKm[i], 1)} km away. ${controlSentence(data.controls[j], r.ctl[j]).replace(/^<b>[^<]*<\/b>\s*/, "")}`
      : `<b>Log level: not covered.</b> No assessed well with open logs within ${P.radiusKm} km.`}</div>`;
    h += `<div class="verdict">${k >= 0
      ? `<b>Formation level: clay group ${FM_NAME[r.cls1[i]]}.</b> From ${esc(data.layer1[k].n)}, ${fmt(r.l1Km[i], 1)} km away: ${fmt(r.l1[k].inWindow)} m of Hordaland or Rogaland Group inside the pressure window above the ${esc(strat(r.l1[k].zone))}.`
      : `<b>Formation level: not covered.</b> No assessed exploration well within ${P.radiusKm} km.`}</div>`;
    h += `<div class="facts">${fact("Content", w.content[i] >= 0 ? esc(w.contents[w.content[i]].toLowerCase()) : "–")}${fact("Subsea", w.subsea[i] ? "Yes" : "No")}${fact("Depth", `${fmt(w.md[i])} m MD${w.tvd[i] ? `, ${fmt(w.tvd[i])} m TVD` : ""}`)}${fact("Water depth", w.wd[i] != null ? `${fmt(w.wd[i])} m` : "–")}${fact("Drilled by", w.operator[i] >= 0 ? esc(w.operators[w.operator[i]]) : "–")}</div>`;
    if (data.gc) h += wbCard(data.gc, w, i);
    const near = data.nb.ctl[i].slice(0, 4);
    if (near.length) h += `<h3>Nearest wells with open logs</h3><div class="neigh">${near.map(([d, n]) => `<button type="button" data-go="ctl|${esc(data.controls[n].name)}"><span>${esc(data.controls[n].name)}</span><span>${fmt(d, 1)} km</span><span>${logPill(r.ctl[n])}</span></button>`).join("")}</div>`;
    const nearF = data.nb.l1[i].filter(([, n]) => r.l1[n].assessed).slice(0, 4);
    if (nearF.length) h += `<h3>Nearest formation-level wells</h3><div class="neigh">${nearF.map(([d, n]) => `<button type="button" data-go="l1|${esc(data.layer1[n].n)}"><span>${esc(data.layer1[n].n)}</span><span>${fmt(d, 1)} km</span><span>${fmPill(r.l1[n])}</span></button>`).join("")}</div>`;
    h += `<h3>From this wellbore's reports</h3><div id="quotes"><p class="muted small">${w.docs[i] ? "Loading…" : "No report text for this wellbore in the open Diskos set."}</p></div>`;
    h += `<p class="small"><a href="${factUrl.dev(w.npdid[i])}" target="_blank" rel="noopener">Open ${esc(name)} in FactPages</a></p>`;
    tracks?.destroy(); tracks = null;
    right.hidden = false; right.innerHTML = `<div class="detail">${h}</div>`;
    if (!w.docs[i]) return;
    const docs = await loadDocs(name);
    if (token === openToken) $("#quotes", right).innerHTML = quotesBlock(docs, false);
  }

  // ------------------------------------------------------------------ right: formation-level exploration well
  /** A well of an open seismic cube that the atlas does not cover: what it is and what is open for it. */
  function showExternal(i) {
    const w = data.ext[i], c = data.seis.cubes[w.ds];
    openToken++;
    const td = { checkshot: "Measured in the well", calibrated: "Sonic tied to depth-time picks", sonic: "Sonic log, not calibrated", trend: "Regional trend" }[w.td] || "Not known";
    let h = head(w.n, `Well outside the atlas · ${esc(w.country || "")}${w.field ? " · " + esc(w.field) : ""}`);
    h += `<div class="verdict"><b>Not screened.</b> The atlas covers the Norwegian shelf and this well lies outside it, so it has no pressure window and no verdict. It is here for what can be seen in it on seismic.</div>`;
    h += `<div class="facts">${fact("Seismic cube", esc(c ? c.short || c.name : w.ds))}${fact("Time-depth", td)}${fact("Position", `${w.la.toFixed(4)}° N, ${w.lo.toFixed(4)}° E`)}</div>`;
    if (w.about) h += `<p class="small">${esc(w.about)}</p>`;
    h += `<p class="small">Press <b>On seismic</b> above for the logs, the tops and the well tie.</p>`;
    h += `<p class="small muted">${[w.logs, c && c.attribution, c && c.licence].filter(Boolean).map(esc).join(" · ")}</p>`;
    tracks?.destroy(); tracks = null;
    right.hidden = false; right.innerHTML = `<div class="detail">${h}</div>`;
  }
  async function showLayer1(i) {
    const w = data.layer1[i], a = app.state.result.l1[i], token = ++openToken;
    const sub = [w.f ? `near ${esc(title(w.f))}` : null, w.y ? `drilled ${w.y}` : null, w.c ? esc(w.c.toLowerCase()) : null].filter(Boolean).join(" · ");
    let h = head(w.n, `Exploration well, formation tops only${sub ? " · " + sub : ""}`, fmPill(a, true));
    h += `<div class="verdict">${a.assessed
      ? `<b>Clay group ${FM_NAME[a.cls]}.</b> ${fmt(a.inWindow)} m of Hordaland or Rogaland Group lies inside the pressure window above the ${esc(strat(a.zone))} at ${fmt(a.topMd)} m. The pressure holds from ${a.zmin == null ? "nowhere" : fmt(a.zmin) + " m"}. No logs, so the rock itself is not checked.`
      : `<b>Not assessed.</b> ${esc(a.reason)}.`}</div>`;
    const span = (x) => (x ? `${fmt(x[0])} to ${fmt(x[1])} m` : "not present");
    h += `<div class="facts">${fact("Hordaland Group", span(w.ho))}${fact("Rogaland Group", span(w.ro))}${a.assessed ? fact("Pore pressure used", `${a.pp.toFixed(2)} g/cm³`) : ""}${fact("Leak-off tests", w.lot.length ? w.lot.map((l) => `${l[1].toFixed(2)} at ${fmt(l[0])} m`).join(", ") : "none")}${fact("Mud in the clay groups", w.mud === "WBM" ? "Water-based" : w.mud === "OBM" ? "Oil-based" : w.mud === "mixed" ? "Both types" : "Not known")}</div>`;
    if (w.lg) h += `<div class="rowline"><button type="button" class="btn" data-go="ctl|${esc(w.n)}">This well has open logs: open the log panel</button></div>`;
    if (data.gc) h += exCard(data.gc, w.n);
    h += `<h3>From the well reports</h3><div id="quotes"><p class="muted small">${w.d ? "Loading…" : "No report text for this well in the open Diskos set."}</p></div>`;
    h += `<p class="small"><a href="${factUrl.exp(w.id)}" target="_blank" rel="noopener">Open ${esc(w.n)} in FactPages</a></p>`;
    tracks?.destroy(); tracks = null;
    right.hidden = false; right.innerHTML = `<div class="detail">${h}</div>`;
    if (!w.d) return;
    let docs = null;
    try { docs = w.lg ? (await loadWell(w.n)).quotes : await loadDocs(w.n); } catch (err) { docs = null; }
    if (token === openToken) $("#quotes", right).innerHTML = quotesBlock(docs, false);
  }

  // ------------------------------------------------------------------ public
  return {
    renderKpis, renderLegend, renderFields, renderAssume, renderValid,
    /** Draw the detail panel for the current selection. */
    showSelection() {
      const s = app.state.sel;
      if (!s) { openToken++; tracks?.destroy(); tracks = null; right.hidden = true; right.innerHTML = ""; return; }
      if (s.type === "ctl") showControl(s.i); else if (s.type === "field") showField(s.name); else if (s.type === "wb") showWellbore(s.i); else if (s.type === "l1") showLayer1(s.i); else if (s.type === "ext") showExternal(s.i);
    },
    /** After a recalculation: refresh numbers without reloading the logs. */
    refreshSelection() {
      const s = app.state.sel;
      if (!s) return;
      if (s.type === "ctl" && tracks && $("#d-top", right)) {
        const a = app.state.result.ctl[s.i];
        $("#d-top", right).innerHTML = controlHeader(data.controls[s.i], a);
        tracks.update({ P: app.state.P, assess: a });
      } else this.showSelection();
    },
    /** Tooltip text for something under the pointer on the map. */
    mapTip(h) {
      const r = app.state.result, G = app.state.level === "gc" ? data.gc : null;
      if (h.type === "site") return gcTips.site(data.gc, h.i);
      if (h.type === "ext") return `<b>${esc(data.ext[h.i].n)}</b> <span class="sub">· ${esc(data.ext[h.i].country || "outside the atlas")}</span><br><span class="sub">Not in the atlas. Logs, tops and well tie on seismic: click to open.</span>`;
      if (h.type === "cube") return `<b>Seismic cube: ${esc(app.map.cubeName(h.i))}</b><br><span class="sub">Click to open it. The wells inside it can be seen on seismic.</span>`;
      if (G && h.type === "wb") return `<b>${esc(data.wb.name[h.i])}</b> <span class="sub">· wellbore left to plug</span><br>${gcTips.wb(G, data.wb, h.i)}`;
      if (G && h.type === "ctl") return `<b>${esc(data.controls[h.i].name)}</b> <span class="sub">· well with open logs</span><br>${gcTips.ex(G, data.controls[h.i].name)}`;
      if (G && h.type === "l1") return `<b>${esc(data.layer1[h.i].n)}</b> <span class="sub">· exploration well</span><br>${gcTips.ex(G, data.layer1[h.i].n)}`;
      if (h.type === "wb") {
        const i = h.i, w = data.wb, f = w.field[i] >= 0 ? title(w.fields[w.field[i]]) : "no field", log = app.state.level === "log";
        const j = log ? r.ctlIdx[i] : r.l1Idx[i];
        const why = j < 0 ? "No assessed well nearby" : log ? `${esc(data.controls[j].name)}, ${fmt(r.ctlKm[i], 1)} km away, ${LOG_NAME[r.cls[i]]}` : `${esc(data.layer1[j].n)}, ${fmt(r.l1Km[i], 1)} km away: clay group ${FM_NAME[r.cls1[i]]}`;
        return `<b>${esc(w.name[i])}</b> <span class="sub">· ${esc(f)}</span><br>${title(w.statuses[w.status[i]].toLowerCase())}${w.year[i] ? ", " + w.year[i] : ""}<br><span class="sub">${why}</span>`;
      }
      if (h.type === "ctl") {
        const c = data.controls[h.i], a = r.ctl[h.i], z = a.assessed ? a.zones[a.zone] : null;
        return `<b>${esc(c.name)}</b> <span class="sub">· well with open logs</span><br>${z ? `${z.cls === 2 ? "Passes" : "Fails"}: ${fmt(z.longest)} m of clay inside the pressure window` : "Not assessed"}<br><span class="sub">Click to open the logs</span>`;
      }
      if (h.type === "l1") {
        const w = data.layer1[h.i], a = r.l1[h.i];
        return `<b>${esc(w.n)}</b> <span class="sub">· formation tops only</span><br>${a.assessed ? `Clay group ${FM_NAME[a.cls]}: ${fmt(a.inWindow)} m in the window` : "Not assessed"}`;
      }
      const g = data.fieldGeo[h.i], wi = data.fieldIdx.get(g.name), F = wi != null ? r.fields[wi] : null;
      if (!F) return `<b>${esc(title(g.name))}</b><br><span class="sub">No wellbores left to plug</span>`;
      return `<b>${esc(title(g.name))}</b> <span class="sub">· ${fmt(F.left)} left to plug</span><br>${app.state.level === "log" ? `${fmt(F.log[2])} pass, ${fmt(F.log[1])} fail, ${fmt(F.log[0])} not covered` : `${fmt(F.fm[3])} present, ${fmt(F.fm[1] + F.fm[2])} not, ${fmt(F.fm[0])} not covered`}`;
    },
  };
}
