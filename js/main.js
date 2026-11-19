// Nature's Plug - application state and wiring.
import { computeAll, DEFAULTS } from "./engine.js";
import { loadAll } from "./data.js";
import { createMap } from "./map.js";
import { createPanels } from "./panels.js";
import { createTour } from "./tour.js";
import { createWorkspace } from "./workspace.js";
import { $, $$, esc, title, frame } from "./util.js";

const app = {
  state: { P: { ...DEFAULTS }, overrides: {}, level: "log", sel: null, tab: "fields", result: null },
  data: null, map: null,
};
let panels = null, tour = null, ws = null;
const layout = $("#layout"), maptip = $("#maptip"), mapwrap = $("#mapwrap");

// ------------------------------------------------------------------ recalculation
const recompute = frame(() => {
  const s = app.state;
  s.result = computeAll(app.data, s.P, s.overrides);
  app.map.setResult(s.result);
  panels.renderKpis(); panels.renderLegend(); panels.renderFields();
  if (s.tab === "valid") panels.renderValid();
  panels.refreshSelection();
  ws?.applyInspector();
});

// ------------------------------------------------------------------ actions
function select(sel, focus) {
  app.state.sel = sel;
  layout.classList.toggle("has-right", !!sel && sel.type !== "ctl");
  layout.classList.toggle("wide-right", !!sel && sel.type === "ctl");
  app.map.setSelection(sel ? (sel.type === "field" ? { type: "field", i: sel.i } : sel) : null);
  panels.showSelection();
  panels.renderFields();
  ws?.onSelect();
  writeHash();
  if (!sel || !focus) return;
  const d = app.data;
  // Wait a frame so the map has its new width before it is moved.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (sel.type === "field") app.map.fitField(sel.i);
    else if (sel.type === "ctl") app.map.focus(d.controls[sel.i].lon, d.controls[sel.i].lat, 170);
    else if (sel.type === "wb") app.map.focus(d.wb.lon[sel.i], d.wb.lat[sel.i], 320);
    else if (sel.type === "l1") app.map.focus(d.layer1[sel.i].lo, d.layer1[sel.i].la, 170);
  }));
}
Object.assign(app, {
  select,
  selectField(name, focus) { const i = app.data.fieldGeoByName.get(name); if (i != null) select({ type: "field", name, i }, focus); },
  selectControl(name, focus) { const i = app.data.ctlByName.get(name); if (i != null) select({ type: "ctl", i }, focus); },
  selectWellbore(name, focus) { const i = app.data.wbByName.get(name); if (i != null) select({ type: "wb", i }, focus); },
  selectLayer1(name, focus) { const i = app.data.l1ByName.get(name); if (i != null) { if (!app.map.isShown("l1")) { app.map.setShow("l1", true); panels.renderLegend(); } select({ type: "l1", i }, focus); } },
  setLevel(level) {
    if (app.state.level === level) return;
    app.state.level = level;
    $$("#level button").forEach((b) => b.classList.toggle("is-active", b.dataset.level === level));
    app.map.setLevel(level); app.map.setShow("l1", level !== "log");
    panels.renderKpis(); panels.renderLegend(); panels.renderFields();
    if (app.state.sel && (app.state.sel.type === "field" || app.state.sel.type === "wb")) { panels.showSelection(); ws?.applyInspector(); }
  },
  setTab(tab) {
    app.state.tab = tab;
    layout.classList.remove("left-off");
    $$(".tab").forEach((b) => { const on = b.dataset.tab === tab; b.classList.toggle("is-active", on); b.setAttribute("aria-selected", on); });
    $("#panel-fields").hidden = tab !== "fields"; $("#panel-assume").hidden = tab !== "assume"; $("#panel-valid").hidden = tab !== "valid";
    if (tab === "assume") panels.renderAssume(); else if (tab === "valid") panels.renderValid();
  },
  setParam(key, value) { app.state.P = { ...app.state.P, [key]: value }; recompute(); },
  resetParams() { app.state.P = { ...DEFAULTS }; app.state.overrides = {}; recompute(); },
  setOverride(name, patch) {
    const o = { ...(app.state.overrides[name] || {}), ...patch };
    if (o.pp == null) delete o.pp;
    app.state.overrides = { ...app.state.overrides, [name]: o };
    recompute();
  },
});

// ------------------------------------------------------------------ deep links: #well=35/11-7, #wellbore=..., #field=...
function writeHash() {
  const s = app.state.sel, d = app.data;
  const h = !s ? "" : s.type === "ctl" ? "well=" + d.controls[s.i].name : s.type === "wb" ? "wellbore=" + d.wb.name[s.i] : s.type === "l1" ? "exploration=" + d.layer1[s.i].n : "field=" + s.name;
  try { history.replaceState(null, "", h ? "#" + encodeURIComponent(h).replace(/%3D/, "=").replace(/%2F/g, "/") : location.pathname + location.search); } catch (e) { /* file preview */ }
}
function readHash() {
  let h = "";
  try { h = decodeURIComponent(location.hash.slice(1)); } catch (e) { return false; } // a malformed link opens the plain map
  if (h === "seismic") { ws?.setWs("seismic"); return true; }                  // old links to the seismic page
  if (h === "greenclay") { app.setLevel("gc"); ws?.openGreenClay(); return true; }   // old links to the Green Clay page
  const m = h.match(/^(well|wellbore|exploration|field)=(.+)$/);
  if (!m) return false;
  if (m[1] === "well") app.selectControl(m[2], true); else if (m[1] === "wellbore") app.selectWellbore(m[2], true);
  else if (m[1] === "exploration") app.selectLayer1(m[2], true); else app.selectField(m[2].toUpperCase(), true);
  return !!app.state.sel;
}

// ------------------------------------------------------------------ search
function setupSearch() {
  const input = $("#search-input"), list = $("#search-results"), d = app.data;
  const index = [
    ...d.fieldGeo.filter((f) => f.left > 0).map((f) => ({ t: title(f.name), k: f.name.toLowerCase(), kind: "Field", go: () => app.selectField(f.name, true) })),
    ...d.controls.map((c) => ({ t: c.name, k: c.name.toLowerCase(), kind: "Well with logs", go: () => app.selectControl(c.name, true) })),
    ...d.wb.name.map((n) => ({ t: n, k: n.toLowerCase(), kind: "Left to plug", go: () => app.selectWellbore(n, true) })),
    ...d.layer1.filter((w) => !w.lg).map((w) => ({ t: w.n, k: w.n.toLowerCase(), kind: "Exploration well", go: () => app.selectLayer1(w.n, true) })),
  ];
  let found = [], active = 0;
  const draw = () => {
    list.hidden = !found.length;
    list.innerHTML = found.map((r, i) => `<li data-i="${i}" class="${i === active ? "is-active" : ""}"><span>${esc(r.t)}</span><span>${r.kind}</span></li>`).join("");
  };
  const run = () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { found = []; draw(); return; }
    const starts = [], has = [];
    for (const r of index) { const p = r.k.indexOf(q); if (p === 0) starts.push(r); else if (p > 0) has.push(r); if (starts.length > 40) break; }
    found = [...starts, ...has].slice(0, 12); active = 0; draw();
  };
  const pick = (i) => { const r = found[i]; if (!r) return; r.go(); input.value = ""; found = []; draw(); input.blur(); };
  input.addEventListener("input", run);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { active = Math.min(found.length - 1, active + 1); draw(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
    else if (e.key === "Enter") pick(active);
    else if (e.key === "Escape") { input.value = ""; found = []; draw(); }
  });
  list.addEventListener("mousedown", (e) => { const li = e.target.closest("li"); if (li) { e.preventDefault(); pick(Number(li.dataset.i)); } });
  input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; }, 120));
  input.addEventListener("focus", () => { if (found.length) list.hidden = false; });
}

// ------------------------------------------------------------------ boot
async function boot() {
  const fill = $("#boot-fill"), msg = $("#boot-msg");
  try {
    app.data = await loadAll((f) => { fill.style.width = Math.round(4 + f * 90) + "%"; });
  } catch (err) {
    msg.innerHTML = `Could not load the data. ${esc(err.message)}.<br>Serve this folder over http, for example with <code>python3 -m http.server</code>.`;
    return;
  }
  msg.textContent = "Screening the wells…";
  app.state.result = computeAll(app.data, app.state.P, app.state.overrides);
  app.map = createMap($("#map"), app.data, {
    select(h) {
      if (h && h.type === "cube") return ws.openCube(h.id);
      if (h && h.type === "site") return ws.openGreenClay(h.i);
      if (!h) return select(null);
      if (h.type === "field") return app.selectField(app.data.fieldGeo[h.i].name, false);
      select(h, false);
    },
    hover(h, px, py) {
      if (!h) { maptip.hidden = true; return; }
      maptip.innerHTML = panels.mapTip(h); maptip.hidden = false;
      const w = mapwrap.clientWidth, hh = mapwrap.clientHeight, r = maptip.getBoundingClientRect();
      maptip.style.left = Math.max(6, px + 14 + r.width > w ? px - r.width - 12 : px + 14) + "px";
      maptip.style.top = Math.max(6, py + 14 + r.height > hh ? py - r.height - 12 : py + 14) + "px";
    },
  });
  panels = createPanels(app); tour = createTour(app); ws = createWorkspace(app);
  app.map.setResult(app.state.result);
  panels.renderKpis(); panels.renderLegend(); panels.renderFields();
  setupSearch();

  $$(".tab").forEach((b) => b.addEventListener("click", () => app.setTab(b.dataset.tab)));
  $("#level").addEventListener("click", (e) => { const b = e.target.closest("[data-level]"); if (b) app.setLevel(b.dataset.level); });
  $("#regions").addEventListener("click", (e) => { const b = e.target.closest("[data-region]"); if (b) app.map.fitRegion(b.dataset.region); });
  $("#zoom-in").addEventListener("click", () => app.map.zoomBy(1.6));
  $("#zoom-out").addEventListener("click", () => app.map.zoomBy(1 / 1.6));
  $("#toggle-left").addEventListener("click", () => layout.classList.toggle("left-off"));
  $("#btn-tour").addEventListener("click", () => { ws.setWs("map"); tour.start(); });
  $("#btn-method").addEventListener("click", () => tour.method());
  $("#btn-theme").addEventListener("click", () => {
    const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = t;
    try { localStorage.setItem("np-theme", t); } catch (e) { /* private window */ }
    app.map.theme();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !tour.active() && $("#modal-root").hidden && $("#gc-sheet").hidden && app.state.sel && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || "")) select(null);
  });
  window.addEventListener("hashchange", readHash);

  $("#boot").hidden = true;
  let seen = false;
  try { seen = localStorage.getItem("np-intro") === "1"; localStorage.setItem("np-intro", "1"); } catch (e) { /* private window */ }
  if (!readHash() && !seen) tour.intro();
  window.naturesPlug = app; // handy in the console during a demo
}
boot();
