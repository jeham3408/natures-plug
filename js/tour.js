// The guided tour, the introduction and the method dialog.
import { $, esc, fmt, strat } from "./util.js";

export function createTour(app) {
  const card = $("#tourcard"), root = $("#modal-root");
  const { data } = app;
  let at = -1;

  const ctl = (name) => { const i = data.ctlByName.get(name); return i == null ? null : { c: data.controls[i], a: app.state.result.ctl[i] }; };
  const field = (name) => app.state.result.fields.find((f) => f.name === name);

  function steps() {
    const T = app.state.result.totals, fram = ctl("35/11-7"), vis = ctl("34/8-1"), ula = field("ULA"), framF = field("FRAM");
    const fz = fram && fram.a.assessed ? fram.a.zones[fram.a.zone] : null, vz = vis && vis.a.assessed ? vis.a.zones[vis.a.zone] : null;
    return [
      {
        title: `${fmt(T.left)} wellbores are waiting to be plugged`,
        body: "Permanent plugging is more than half the cost of shutting down a field on the Norwegian shelf. Some clays above the reservoir creep in around the casing and seal the annulus on their own. This map asks where that can work.",
        run() { app.select(null); app.setLevel("log"); app.setTab("fields"); app.map.fitRegion("north"); },
      },
      {
        title: "Fram: the clay passes",
        body: fz ? `Well 35/11-7 carries the clay signature through the Hordaland and Rogaland groups. ${fmt(fz.longest)} m of it lies deep enough to hold the ${strat(fz.name)} with a gas column. The ${framF ? fmt(framF.left) : ""} wellbores left on Fram inherit that result.` : "Well 35/11-7 on Fram.",
        run() { app.setLevel("log"); app.selectControl("35/11-7", true); },
      },
      {
        title: "Visund: the same clay, too shallow",
        body: vz ? `Well 34/8-1 shows ${fmt(vis.a.clayHord + vis.a.clayRog)} m of the same signature. But the ${strat(vz.name)} is deeper and at higher pressure, so the leak-off tests only hold below ${fmt(vz.zminMd)} m. All the clay lies above that.` : "Well 34/8-1 on Visund.",
        run() { app.setLevel("log"); app.selectControl("34/8-1", true); },
      },
      {
        title: "The operator's own report says it",
        body: `Wellbore 7/12-A-7 D on Ula is still to be plugged. Its 2020 report says the casing was logged for annular cement and creeping shale. At formation level the screen marks ${ula ? `${fmt(ula.fm[3])} of ${fmt(ula.left)}` : "the"} Ula wellbores without being told.`,
        run() { app.setLevel("fm"); app.selectWellbore("7/12-A-7 D", true); },
      },
      {
        title: "It finds the fields where the method is in use",
        body: "Havtil names five fields with wells left where creeping shale is used as a barrier: Ekofisk, Valhall, Ula, Ivar Aasen and Balder. All five come out with the clay group inside the pressure window. Gullfaks, Snorre and Visund do not.",
        run() { app.select(null); app.setLevel("fm"); app.setTab("valid"); app.map.fitRegion("north"); },
      },
      {
        title: "Your assumptions, your map",
        body: "Every threshold is a slider, and each well takes a measured pore pressure. Nothing here verifies a barrier: open data has no bond logs. It shows where one is most likely to pay off.",
        run() { app.select(null); app.setLevel("log"); app.setTab("assume"); },
      },
    ];
  }

  function show(i) {
    const S = steps();
    at = Math.max(0, Math.min(S.length - 1, i));
    const s = S[at];
    s.run();
    card.hidden = false; card.parentElement.classList.add("is-touring");
    card.innerHTML = `<h3>${esc(s.title)}</h3><p>${esc(s.body)}</p>
      <div class="tour-foot"><div class="steps-dots" aria-label="Step ${at + 1} of ${S.length}">${S.map((_, k) => `<i class="${k === at ? "on" : ""}"></i>`).join("")}</div>
      <div class="rowline"><button type="button" class="btn ghost" data-tour="stop">End tour</button>${at > 0 ? '<button type="button" class="btn" data-tour="back">Back</button>' : ""}<button type="button" class="btn primary" data-tour="${at === S.length - 1 ? "stop" : "next"}">${at === S.length - 1 ? "Done" : "Next"}</button></div></div>`;
  }
  function stop() { at = -1; card.hidden = true; card.innerHTML = ""; card.parentElement.classList.remove("is-touring"); }
  card.addEventListener("click", (e) => {
    const b = e.target.closest("[data-tour]");
    if (!b) return;
    if (b.dataset.tour === "next") show(at + 1); else if (b.dataset.tour === "back") show(at - 1); else stop();
  });
  document.addEventListener("keydown", (e) => {
    if (!root.hidden) { if (e.key === "Escape") close(); return; }
    if (at < 0 || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) return;
    if (e.key === "ArrowRight") show(at + 1); else if (e.key === "ArrowLeft") show(at - 1); else if (e.key === "Escape") stop();
  });

  // ---- dialogs
  function open(html) {
    root.hidden = false; root.innerHTML = html;
    (root.querySelector("[data-primary]") || root.querySelector("button"))?.focus();
  }
  function close() { root.hidden = true; root.innerHTML = ""; }
  root.addEventListener("click", (e) => {
    if (e.target === root || e.target.closest("[data-close]")) close();
    if (e.target.closest("[data-start]")) { close(); show(0); }
  });

  const ANIM = `<svg viewBox="0 0 240 206" role="img" aria-label="Cross-section of a well: clay on both sides creeps in and closes the gap around the steel casing">
    <rect x="0" y="0" width="240" height="206" rx="8" fill="var(--panel-2)"/>
    <rect x="78" y="22" width="29" height="150" fill="var(--line)"/><rect x="133" y="22" width="29" height="150" fill="var(--line)"/>
    <rect class="clay l" x="20" y="22" width="58" height="150"/><rect class="clay r" x="162" y="22" width="58" height="150"/>
    <rect x="107" y="14" width="6" height="166" fill="var(--ink-2)"/><rect x="127" y="14" width="6" height="166" fill="var(--ink-2)"/>
    <rect x="113" y="14" width="14" height="166" fill="var(--sea)"/>
    <text x="49" y="16" text-anchor="middle">Clay</text><text x="191" y="16" text-anchor="middle">Clay</text><text x="120" y="9" text-anchor="middle">Casing</text>
    <text class="open" x="120" y="197" text-anchor="middle">Open annulus: a path for fluids</text>
    <text class="sealed" x="120" y="197" text-anchor="middle">The clay has closed the annulus</text>
  </svg>`;

  function intro() {
    const T = app.state.result.totals;
    open(`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="intro-title">
      <div class="intro"><div style="display:flex;flex-direction:column;gap:12px">
        <h2 id="intro-title">Some wells are already half plugged by the rock around them</h2>
        <p>${fmt(T.left)} wellbores on the Norwegian shelf are not yet permanently plugged. Each one needs barriers that seal both the inside of the casing and the gap outside it.</p>
        <p>Certain clays above the reservoir are soft enough to creep in and close that gap by themselves. Operators have used this since 2006, but there is no open map of where it can work.</p>
        <p>Nature's Plug screens the open data for it: well logs, leak-off tests, formation tops and 2.75 million pages of well reports. It ranks where to look. It does not verify a barrier.</p>
      </div><div class="anim">${ANIM}</div></div>
      <div class="modal-foot"><button type="button" class="btn" data-close>Explore the map</button><button type="button" class="btn primary" data-start data-primary>Take the tour</button></div></div>`);
  }

  function method() {
    const P = app.state.P, T = app.state.result.totals, src = data.meta.sources;
    open(`<div class="modal" role="dialog" aria-modal="true" aria-labelledby="m-title">
      <h2 id="m-title">Method and limits</h2>
      <h3>What the screen does</h3>
      <ol>
        <li><b>Rock.</b> A 1 m sample has the clay signature when deep resistivity is below ${P.rdepMax} Ω·m, gamma ray above ${P.grMin} API and sonic slower than ${P.dtcMin} µs/ft. It counts in any group above the reservoir, not only in the Hordaland and Rogaland groups.</li>
        <li><b>Pressure.</b> At that depth the leak-off tests must give more than the reservoir pressure with a gas column up to it. This is the criterion Statoil described in 2009. Pore pressure is the mud weight at the reservoir top minus ${P.overbalance} g/cm³.</li>
        <li><b>Length.</b> Rock and pressure must hold together over at least ${P.minLen} m along the hole.</li>
        <li><b>Reach.</b> A wellbore that is left to plug inherits the result of the nearest assessed well within ${P.radiusKm} km.</li>
      </ol>
      <h3>Two levels of evidence</h3>
      <p>Log level uses the ${fmt(T.controls.all)} wells with open logs; ${fmt(T.controls.assessed)} of them also have a named hydrocarbon zone, a leak-off test above it and mud weights. Formation level runs the pressure test on ${fmt(T.layer1.assessed)} exploration wells using formation tops only, and asks whether at least ${P.formationMin} m of Hordaland or Rogaland Group lies inside the window.</p>
      <h3>What it does not do</h3>
      <ul>
        <li>It does not verify a barrier. Open data has no bond logs and no pressure tests of the annulus.</li>
        <li>Mud weight overstates pore pressure. Measured formation pressures are in the well reports and should replace it. Each well panel accepts a value.</li>
        <li>The thresholds are not calibrated against laboratory or field data.</li>
        <li>A wellbore is judged by a neighbouring exploration well, not by its own logs.</li>
        <li>Logs are resampled to 1 m. At the original 0.15 m sampling with strict continuity, 651 wellbores pass instead of 663 with the default settings. The headline is stable; the split between 30 and 50 m intervals is not.</li>
        <li>Report quotes are keyword matches in scanned text. They are leads to read, not findings.</li>
      </ul>
      <h3>Data</h3>
      <ul>${src.map((s) => `<li><a href="${esc(s[1])}" target="_blank" rel="noopener">${esc(s[0])}</a>, ${esc(s[2])}</li>`).join("")}
        <li>Fields with documented use: Havtil, knowledge report on creeping shale as a well barrier element, November 2025</li></ul>
      <p class="small muted">FactPages downloaded ${esc(data.meta.factpages_date)}. Data package built ${esc(data.meta.built.slice(0, 10))}. This version was prepared before the FORCE VibeCode Hackathon began, from open data only, with AI coding assistance.</p>
      <div class="modal-foot"><button type="button" class="btn primary" data-close data-primary>Close</button></div></div>`);
  }

  return { start: () => show(0), stop, intro, method, active: () => at >= 0 };
}
