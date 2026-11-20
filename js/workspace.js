// One workspace. The map and the seismic share the stage in the middle, the panel on the right always describes the
// selected well, and a well chosen anywhere is the same well everywhere: on the map, in the details, on the seismic.
//
// The seismic part (seismic/app.js, wells.js, view3d.js) needs its server for the cubes. Without the server the rest
// of the app works as before and the seismic stage says what is missing.
import { $, $$, esc } from "./util.js";
import { loadBarrier, loadGreenClayCheck } from "./data.js";
import { renderEvidence } from "./greenclay.js";

export function createWorkspace(app) {
  const data = app.data, layout = $("#layout"), stage = $("#stage"), mapwrap = $("#mapwrap"), seis = $("#seis");
  const tabs = $("#insp-tabs"), paneAtlas = $("#right"), paneTie = $("#insp-tie"), pick = $("#seis-pick"), sheet = $("#gc-sheet");
  const wellsIn = data.seis.wells, cubes = data.seis.cubes;
  // ws: what the stage shows. insp: which facet of the selected well the right panel shows. server: null until asked.
  const st = { ws: "map", insp: "atlas", server: null, ids: [], hidLeft: false };

  const selName = () => { const s = app.state.sel; return !s ? null : s.type === "ctl" ? data.controls[s.i].name : s.type === "l1" ? data.layer1[s.i].n : s.type === "ext" ? data.ext[s.i].n : null; };
  const selInfo = () => { const n = selName(); return n && wellsIn[n] ? { name: n, ...wellsIn[n] } : null; };
  const cubeName = (id) => (cubes[id] ? cubes[id].short || cubes[id].name : id);
  const selectWell = (name, focus) => { if (data.extByName.has(name)) app.selectExternal(name, focus); else if (data.ctlByName.has(name)) app.selectControl(name, focus); else app.selectLayer1(name, focus); };

  // ------------------------------------------------------------------ the seismic server
  async function probe() {
    try {
      const r = await fetch("api/datasets", { cache: "no-store" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      st.ids = ((await r.json()).datasets || []).map((d) => d.id);
      st.server = st.ids.length > 0;
    } catch (e) { st.server = false; st.ids = []; }
    const b = $('#ws [data-ws="seismic"]'), dot = $(".dot", b);
    dot.className = "dot " + (st.server ? "pass" : "fail");
    b.title = st.server ? "Sections, 3D view, logs on seismic and well tie" : "The seismic server is not running (start the app with ./start.sh). The map works without it.";
    if (app.state.sel) applyInspector();                     // the "On seismic" facet depends on the answer
    return st.server;
  }

  /** Bring the selected well onto the seismic: load its cube if another one is shown, then make it the current well. */
  async function syncSeismic() {
    const info = selInfo();
    if (!info || !window.SVBoot) return false;
    window.SVWells.pick(info.name);                         // remembered until its cube has loaded
    const ok = await window.SVBoot.loadCube(info.ds);
    if (ok) window.SVWells.pick(info.name);
    return ok;
  }
  async function enterSeismic() {
    if (st.server === null) await probe();
    if (selInfo()) return syncSeismic();
    const cur = window.SV && window.SV.DS;
    return window.SVBoot.loadCube(cur || st.ids[0] || Object.keys(cubes)[0] || null);
  }
  function relayout() {
    requestAnimationFrame(() => {
      app.map.resize();
      if (window.SV) window.SV.resizeAll();
      if (window.SVWells && window.SV) window.SVWells.refresh();
      if (window.SV3D) window.SV3D.touch();
    });
  }

  // ------------------------------------------------------------------ what the stage shows
  function setWs(mode) {
    if (mode !== "map" && mode !== "seismic" && mode !== "both") mode = "map";
    const was = st.ws;
    st.ws = mode; stage.dataset.ws = mode;
    mapwrap.hidden = mode === "seismic"; seis.hidden = mode === "map";
    $$("#ws button").forEach((b) => { const on = b.dataset.ws === mode; b.classList.toggle("is-active", on); b.setAttribute("aria-pressed", String(on)); });
    // seismic needs the width: the list of fields steps aside, and comes back with the map
    if (mode === "seismic" && was !== "seismic" && !layout.classList.contains("left-off")) { layout.classList.add("left-off"); st.hidLeft = true; }
    if (mode !== "seismic" && st.hidLeft) { layout.classList.remove("left-off"); st.hidLeft = false; }
    if (mode !== "map") {
      if (selInfo()) st.insp = "tie";
      enterSeismic().then(relayout);
    } else st.insp = "atlas";
    applyInspector();
    relayout();
  }

  // ------------------------------------------------------------------ the right panel: one well, two facets
  function applyInspector() {
    const s = app.state.sel, info = selInfo(), canTie = !!info && st.server !== false;
    if (!canTie) st.insp = "atlas";
    tabs.hidden = !canTie;
    $$(".itab", tabs).forEach((b) => { const on = b.dataset.insp === st.insp; b.classList.toggle("is-active", on); b.setAttribute("aria-selected", String(on)); });
    paneAtlas.hidden = !s || st.insp !== "atlas";
    paneTie.hidden = !s || st.insp !== "tie";
    layout.classList.toggle("has-right", !!s && s.type !== "ctl" && st.insp !== "tie");
    layout.classList.toggle("wide-right", !!s && (s.type === "ctl" || st.insp === "tie"));
    if (info) { $("#tie-name").textContent = info.name; $("#tie-sub").textContent = "On seismic: " + (info.cube || cubeName(info.ds)); }
    pick.value = info ? info.name : (window.SV && window.SV.DS ? "cube:" + window.SV.DS : "");
    if (st.insp === "tie") syncSeismic().then(() => { if (window.SVWells && window.SV) window.SVWells.refresh(); });
    relayout();
  }
  function onSelect() {
    const info = selInfo();
    if (info && st.ws !== "map") st.insp = "tie";             // on seismic, the seismic facet of the well comes first
    applyInspector();
    if (info && st.ws !== "map" && st.insp !== "tie") syncSeismic();
  }
  tabs.addEventListener("click", (e) => { const b = e.target.closest(".itab"); if (!b) return; st.insp = b.dataset.insp; applyInspector(); });
  $("#tie-close").addEventListener("click", () => app.select(null));

  // ------------------------------------------------------------------ choosing a well or a cube from the seismic bar
  pick.innerHTML = `<option value="">Choose a well…</option>` + Object.keys(cubes).map((id) =>
    `<optgroup label="${esc(cubeName(id))}">` + Object.keys(wellsIn).filter((n) => wellsIn[n].ds === id).map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("") +
    `<option value="cube:${esc(id)}">Whole cube, no well</option></optgroup>`).join("");
  pick.addEventListener("change", () => {
    const v = pick.value;
    if (!v) return;
    if (v.startsWith("cube:")) { app.select(null); window.SVBoot.loadCube(v.slice(5)).then(relayout); return; }
    selectWell(v, false);
  });
  /** A cube clicked on the map: show it, on its first well. */
  function openCube(id) {
    const first = Object.keys(wellsIn).find((n) => wellsIn[n].ds === id);
    if (first) selectWell(first, false);
    setWs("seismic");
    if (!first) window.SVBoot.loadCube(id).then(relayout);
  }

  $("#ws").addEventListener("click", (e) => { const b = e.target.closest("[data-ws]"); if (b) setWs(b.dataset.ws); });
  $("#seis-left").addEventListener("click", () => { layout.classList.toggle("left-off"); st.hidLeft = false; relayout(); });
  // display and filter settings: a panel that drops down from the seismic bar
  const pop = $("#seis-pop"), popBtn = $("#seis-display");
  const setPop = (on) => { pop.hidden = !on; popBtn.setAttribute("aria-expanded", String(on)); if (on && window.SV) window.SV.resizeAll(); };
  popBtn.addEventListener("click", () => setPop(pop.hidden));
  document.addEventListener("pointerdown", (e) => { if (!pop.hidden && !e.target.closest("#seis-pop") && !e.target.closest("#seis-display")) setPop(false); });

  // ------------------------------------------------------------------ Green Clay: the evidence sheet
  let gcDone = false;
  async function openGreenClay(site) {
    sheet.hidden = false;
    if (!gcDone && data.gc) {
      gcDone = true;
      const [barrier, check] = await Promise.all([
        loadBarrier().catch(() => null),
        loadGreenClayCheck().catch(() => null),
      ]);
      renderEvidence(sheet, data.gc, barrier, check);
    }
    const row = site != null ? $("#gc-site-" + site, sheet) : null;
    if (row) { row.scrollIntoView({ block: "center" }); row.classList.add("is-hit"); setTimeout(() => row.classList.remove("is-hit"), 3200); }
    else $(".sheet-body", sheet).scrollTop = 0;
    $("#gc-close").focus();
  }
  const closeGreenClay = () => { sheet.hidden = true; };
  sheet.addEventListener("click", (e) => { if (e.target === sheet || e.target.closest("#gc-close")) closeGreenClay(); });

  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-gc-open]")) { e.preventDefault(); openGreenClay(); return; }
    const b = e.target.closest("[data-seis-well]");
    if (b) {                                                // "On seismic" in the details of a well
      e.preventDefault();
      st.insp = "tie";
      if (st.ws === "map") setWs("seismic"); else applyInspector();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!sheet.hidden) closeGreenClay(); else if (!pop.hidden) setPop(false);
  });

  // the viewer tells when the wells of a cube have arrived: keep the picker in step
  window.addEventListener("sv-wells", () => applyInspectorQuiet());
  function applyInspectorQuiet() { const info = selInfo(); pick.value = info ? info.name : (window.SV && window.SV.DS ? "cube:" + window.SV.DS : ""); }

  probe();
  return { setWs, onSelect, applyInspector, openCube, openGreenClay, state: st };
}
