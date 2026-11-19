// Well panel: depth tracks drawn as SVG. Depth runs downward, resistivity is on a log scale.
// One measured unit per track, so no track has two different scales.
import { clayFlags, runs, SHALE_GROUPS } from "./engine.js";
import { clamp, esc, fmt, niceStep, showTip, strat, frame } from "./util.js";

const TRACKS = [
  { id: "strat", px: 46, title: "" },
  { id: "gr", w: 1, title: "GR · API", unit: "API", min: 0, max: 150, curves: [["gr", "curve"]], thr: "grMin" },
  { id: "res", w: 1.15, title: "RES · Ω·m", unit: "Ω·m", log: true, min: 0.2, max: 20, curves: [["rmed", "curve-2"], ["rdep", "curve"]], thr: "rdepMax" },
  { id: "dtc", w: 1, title: "DT · µs/ft", unit: "µs/ft", min: 40, max: 200, curves: [["dtc", "curve"]], thr: "dtcMin" },
  { id: "rhob", w: 0.95, title: "RHOB · g/cm³", unit: "g/cm³", min: 1.6, max: 2.8, curves: [["rhob", "curve"]] },
  { id: "cal", w: 0.9, title: "CALI · in", unit: "in", min: 6, max: 26, curves: [["bs", "curve-2"], ["cali", "curve"]] },
  { id: "clay", px: 26, title: "CLAY" },
  { id: "pres", w: 1.4, title: "PRESSURE · g/cm³", unit: "g/cm³", min: 1.0, max: 2.4 },
  { id: "rep", px: 30, title: "REP." },
];
const LEFT = 44, TOP = 24, BOTTOM = 8, GAP = 5;

export function createTracks(host, well, opts) {
  // opts: { P, assess, quotes, lith, tip, onQuote }
  const logTop = well.a0 - 0.5, logBase = well.a0 + well.n - 0.5;
  let state = { ...opts }, range = null, active = -1, hoverY = null;
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("role", "img");
  host.textContent = ""; host.appendChild(svg);

  const zone = () => (state.assess && state.assess.assessed ? state.assess.zones[state.assess.zone] : null);
  function preset(kind) {
    const z = zone(), deep = well.groups.filter((g) => SHALE_GROUPS.includes(g[0])).reduce((m, g) => Math.max(m, g[2]), 0);
    if (kind === "full") return [logTop, logBase];
    const base = Math.min(logBase, (z ? z.topMd : deep || logBase) + 90);
    return [logTop, Math.max(base, logTop + 200)];
  }
  range = preset("over");

  let geom = null;
  function layout() {
    const W = Math.max(420, host.clientWidth), H = Math.max(320, state.height || 560);
    const fixed = TRACKS.reduce((s, t) => s + (t.px || 0), 0), weights = TRACKS.reduce((s, t) => s + (t.w || 0), 0);
    const flex = W - LEFT - 6 - fixed - GAP * (TRACKS.length - 1);
    let x = LEFT; const tr = [];
    for (const t of TRACKS) { const w = t.px || (flex * t.w) / weights; tr.push({ ...t, x, w }); x += w + GAP; }
    return { W, H, tr, y0: TOP, y1: H - BOTTOM, xEnd: x - GAP };
  }

  const yOf = (md) => geom.y0 + ((md - range[0]) / (range[1] - range[0])) * (geom.y1 - geom.y0);
  const mdOf = (y) => range[0] + ((y - geom.y0) / (geom.y1 - geom.y0)) * (range[1] - range[0]);
  const xOf = (t, v) => {
    const f = t.log ? (Math.log10(Math.max(v, 1e-6)) - Math.log10(t.min)) / (Math.log10(t.max) - Math.log10(t.min)) : (v - t.min) / (t.max - t.min);
    return t.x + clamp(f, -0.03, 1.03) * t.w;
  };

  function curve(arr, t, i0, i1) {
    const plotH = geom.y1 - geom.y0, n = i1 - i0 + 1, step = Math.max(1, Math.floor(n / (plotH * 1.3)));
    let d = "", pen = false;
    for (let i = i0; i <= i1; i += step) {
      if (step === 1) {
        const v = arr[i];
        if (v == null) { pen = false; continue; }
        d += (pen ? "L" : "M") + xOf(t, v).toFixed(1) + " " + yOf(well.a0 + i).toFixed(1); pen = true;
      } else {
        let lo = Infinity, hi = -Infinity;
        for (let j = i; j < Math.min(i + step, i1 + 1); j++) { const v = arr[j]; if (v == null) continue; if (v < lo) lo = v; if (v > hi) hi = v; }
        if (lo === Infinity) { pen = false; continue; }
        const y = yOf(well.a0 + i + (step - 1) / 2).toFixed(1);
        d += (pen ? "L" : "M") + xOf(t, lo).toFixed(1) + " " + y + "L" + xOf(t, hi).toFixed(1) + " " + y; pen = true;
      }
    }
    return d;
  }

  function draw() {
    geom = layout();
    const { W, H, tr, y0, y1, xEnd } = geom, P = state.P, z = zone();
    const i0 = clamp(Math.floor(range[0] - well.a0), 0, well.n - 1), i1 = clamp(Math.ceil(range[1] - well.a0), 0, well.n - 1);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("height", H);
    svg.setAttribute("aria-label", `Log tracks for well ${well.name}, ${fmt(range[0])} to ${fmt(range[1])} m measured depth`);
    let s = `<defs>${tr.map((t) => `<clipPath id="cp-${t.id}"><rect x="${t.x}" y="${y0}" width="${t.w}" height="${y1 - y0}"/></clipPath>`).join("")}</defs>`;

    // depth axis
    const step = niceStep(range[1] - range[0], (y1 - y0) / 56);
    for (let d = Math.ceil(range[0] / step) * step; d <= range[1]; d += step) {
      const y = yOf(d);
      s += `<line x1="${LEFT}" x2="${xEnd}" y1="${y}" y2="${y}" stroke="var(--line-2)" stroke-width="1"/><text x="${LEFT - 6}" y="${y + 3.2}" text-anchor="end">${fmt(d)}</text>`;
    }
    s += `<text x="${LEFT - 6}" y="14" text-anchor="end">m MD</text>`;
    let scaleLabels = "";
    for (const c of well.casing || []) {
      if (c.md < range[0] || c.md > range[1]) continue;
      const y = yOf(c.md);
      s += `<path d="M${LEFT - 1} ${y}l-5 -3.5v7z" fill="var(--ink-2)"><title>${esc(c.dia)} in casing shoe at ${fmt(c.md)} m${c.emw ? `, ${c.test || "LOT"} ${c.emw.toFixed(2)} g/cm³` : ""}</title></path>`;
    }

    for (const t of tr) {
      // header
      if (t.title) s += `<text class="th" x="${t.x + t.w / 2}" y="14" text-anchor="middle">${t.title}</text>`;
      s += `<rect x="${t.x}" y="${y0}" width="${t.w}" height="${y1 - y0}" fill="var(--panel)" stroke="var(--line)" stroke-width="1"/>`;
      if (t.unit) scaleLabels += `<text class="scl" x="${t.x + 3}" y="${y0 + 10}">${t.log ? t.min : fmt(t.min, t.max <= 3 ? 1 : 0)}</text><text class="scl" x="${t.x + t.w - 3}" y="${y0 + 10}" text-anchor="end">${fmt(t.max, t.max <= 3 ? 1 : 0)}</text>`;
      if (t.id === "strat") {
        well.groups.forEach((g, k) => {
          const a = Math.max(range[0], g[1]), b = Math.min(range[1], g[2]);
          if (b <= a) return;
          const ya = yOf(a), yb = yOf(b), shale = SHALE_GROUPS.includes(g[0]);
          s += `<rect x="${t.x}" y="${ya}" width="${t.w}" height="${yb - ya}" fill="${shale ? "var(--accent-soft)" : k % 2 ? "var(--panel-2)" : "var(--line-2)"}" stroke="var(--line)" stroke-width="1"><title>${esc(strat(g[0]))}: ${fmt(g[1])} to ${fmt(g[2])} m</title></rect>`;
          const name = strat(g[0]).replace(/ Gp$/, "");
          if (yb - ya > 58) s += `<text class="grp" transform="translate(${t.x + t.w / 2 + 3},${(ya + yb) / 2}) rotate(-90)" text-anchor="middle">${esc(name.toUpperCase())}</text>`;
          else if (yb - ya > 13) s += `<text class="grp" x="${t.x + t.w / 2}" y="${(ya + yb) / 2 + 3}" text-anchor="middle">${esc(name.slice(0, 6).toUpperCase())}</text>`;
        });
        continue;
      }
      if (t.curves) {
        const any = t.curves.some(([k]) => well[k]);
        if (!any) { s += `<text x="${t.x + t.w / 2}" y="${y0 + 16}" text-anchor="middle">no curve</text>`; continue; }
        if (t.log) for (const v of [1, 10]) s += `<line x1="${xOf(t, v)}" x2="${xOf(t, v)}" y1="${y0}" y2="${y1}" stroke="var(--line-2)" stroke-width="1"/>`;
        else s += `<line x1="${t.x + t.w / 2}" x2="${t.x + t.w / 2}" y1="${y0}" y2="${y1}" stroke="var(--line-2)" stroke-width="1"/>`;
        if (t.thr) { const x = xOf(t, P[t.thr]); s += `<line x1="${x}" x2="${x}" y1="${y0}" y2="${y1}" stroke="var(--accent)" stroke-width="1"><title>Threshold ${P[t.thr]} ${t.unit}</title></line>`; }
        for (const [k, c] of t.curves) if (well[k]) s += `<path d="${curve(well[k], t, i0, i1)}" fill="none" stroke="var(--${c})" stroke-width="${c === "curve" ? 1.5 : 1.1}" stroke-linejoin="round" clip-path="url(#cp-${t.id})"/>`;
        continue;
      }
      if (t.id === "clay") {
        const flags = clayFlags(well, P);
        for (const r of runs(flags.subarray(i0, i1 + 1))) { const ya = yOf(well.a0 + i0 + r.i0 - 0.5), yb = yOf(well.a0 + i0 + r.i1 + 0.5); s += `<rect x="${t.x + 1}" y="${ya}" width="${t.w - 2}" height="${Math.max(0.8, yb - ya)}" fill="var(--wash)"/>`; }
        if (z) for (const r of runs(z.q)) {
          const a = well.a0 + r.i0 - 0.5, b = well.a0 + r.i1 + 0.5;
          if (b < range[0] || a > range[1]) continue;
          s += `<rect x="${t.x + 1}" y="${yOf(Math.max(a, range[0]))}" width="${t.w - 2}" height="${Math.max(0.8, yOf(Math.min(b, range[1])) - yOf(Math.max(a, range[0])))}" fill="var(--pass)"><title>${r.len} m of clay inside the pressure window</title></rect>`;
        }
        continue;
      }
      if (t.id === "pres") {
        if (!z) { s += `<text x="${t.x + t.w / 2}" y="${y0 + 16}" text-anchor="middle">not assessed</text>`; continue; }
        for (const v of [1.5, 2.0]) s += `<line x1="${xOf(t, v)}" x2="${xOf(t, v)}" y1="${y0}" y2="${y1}" stroke="var(--line-2)" stroke-width="1"/>`;
        const j1 = Math.min(i1, z.nz - 1);
        if (j1 >= i0) {
          // shade where the test gives more than is needed
          let poly = "", open = false, startJ = 0;
          const flush = (a, b) => {
            let p = "";
            for (let j = a; j <= b; j++) p += `${j === a ? "M" : "L"}${xOf(t, z.req[j]).toFixed(1)} ${yOf(well.a0 + j).toFixed(1)}`;
            for (let j = b; j >= a; j--) p += `L${xOf(t, z.avail[j]).toFixed(1)} ${yOf(well.a0 + j).toFixed(1)}`;
            poly += p + "Z";
          };
          for (let j = i0; j <= j1; j++) {
            if (z.ok[j] && !open) { open = true; startJ = j; }
            if ((!z.ok[j] || j === j1) && open) { flush(startJ, z.ok[j] ? j : j - 1); open = false; }
          }
          if (poly) s += `<path d="${poly}" fill="var(--wash)" clip-path="url(#cp-pres)"/>`;
          const line = (arr) => { let d = ""; for (let j = i0; j <= j1; j++) d += `${j === i0 ? "M" : "L"}${xOf(t, arr[j]).toFixed(1)} ${yOf(well.a0 + j).toFixed(1)}`; return d; };
          s += `<path d="${line(z.req)}" fill="none" stroke="var(--fail)" stroke-width="1.6" clip-path="url(#cp-pres)"/>`;
          s += `<path d="${line(z.avail)}" fill="none" stroke="var(--curve)" stroke-width="1.6" clip-path="url(#cp-pres)"/>`;
        }
        for (const c of well.casing || []) {
          if (!c.emw || c.md < range[0] || c.md > range[1]) continue;
          const x = xOf(t, c.emw), y = yOf(c.md), right = x < t.x + t.w - 30;
          s += `<circle cx="${x}" cy="${y}" r="4" fill="var(--curve)" stroke="var(--panel)" stroke-width="2"/><text class="lab" x="${right ? x + 7 : x - 7}" y="${y + 3.3}" text-anchor="${right ? "start" : "end"}">${c.emw.toFixed(2)}</text>`;
        }
        continue;
      }
      if (t.id === "rep") {
        (state.quotes || []).forEach((q, qi) => {
          for (const d of q.d || []) {
            if (d < range[0] || d > range[1]) continue;
            const on = qi === active;
            s += `<circle class="qmark" data-q="${qi}" cx="${t.x + t.w / 2}" cy="${yOf(d)}" r="${on ? 5 : 3.6}" fill="${q.c === 0 ? "var(--ink)" : "var(--panel)"}" stroke="${on ? "var(--accent)" : "var(--ink)"}" stroke-width="${on ? 2.4 : 1.2}"><title>${esc(q.k)} at ${fmt(d)} m</title></circle>`;
          }
        });
      }
    }

    s += scaleLabels;
    // lines across all tracks
    for (const g of well.groups) if (g[1] > range[0] && g[1] < range[1]) s += `<line x1="${LEFT}" x2="${xEnd}" y1="${yOf(g[1])}" y2="${yOf(g[1])}" stroke="var(--line)" stroke-width="1"/>`;
    if (z) {
      if (z.zminMd != null && z.zminMd > range[0] && z.zminMd < range[1]) {
        const y = yOf(z.zminMd);
        s += `<line x1="${LEFT}" x2="${xEnd}" y1="${y}" y2="${y}" stroke="var(--accent)" stroke-width="1.4"/><text class="lab" x="${LEFT + 52}" y="${y - 4}">Pressure holds from ${fmt(z.zminMd)} m</text>`;
      }
      if (z.topMd > range[0] && z.topMd < range[1]) {
        const y = yOf(z.topMd);
        s += `<line x1="${LEFT}" x2="${xEnd}" y1="${y}" y2="${y}" stroke="var(--ink)" stroke-width="1.4"/><text class="lab" x="${LEFT + 52}" y="${y + 12}">Top ${esc(strat(z.name))} · ${fmt(z.topMd)} m</text>`;
      }
    }
    if (hoverY != null) s += `<line x1="${LEFT}" x2="${xEnd}" y1="${hoverY}" y2="${hoverY}" stroke="var(--muted)" stroke-width="1" pointer-events="none"/>`;
    s += `<rect class="hit" x="${LEFT}" y="${y0}" width="${xEnd - LEFT - 30 - GAP}" height="${y1 - y0}" fill="transparent"/>`;
    svg.innerHTML = s;
  }
  const redraw = frame(draw);

  // ---- tooltip
  function tipHtml(md) {
    const i = clamp(Math.round(md - well.a0), 0, well.n - 1), P = state.P, z = zone(), dm = well.a0 + i;
    const g = well.groups.find((x) => dm >= x[1] && dm < x[2]), f = (well.formations || []).find((x) => dm >= x[1] && dm < x[2]);
    const v = (k, d) => (well[k] && well[k][i] != null ? fmt(well[k][i], d) : "–");
    const r = well.rdep[i], gr = well.gr[i], dt = well.dtc ? well.dtc[i] : null;
    const clay = r != null && gr != null && r < P.rdepMax && gr > P.grMin && (dt == null || dt > P.dtcMin);
    let h = `<b>${fmt(dm)} m MD</b> <span class="sub">· ${fmt(well.tvd[i])} m TVD</span><br>${g ? esc(strat(g[0])) : "No group"}${f ? " · " + esc(strat(f[0])) : ""}`;
    h += `<br>Gamma ray ${v("gr", 0)} API · resistivity ${v("rdep", 2)} Ω·m<br>Sonic ${v("dtc", 0)} µs/ft · density ${v("rhob", 2)} g/cm³`;
    if (well.cali) h += `<br>Caliper ${v("cali", 1)} in${well.bs && well.bs[i] != null ? ` (bit ${fmt(well.bs[i], 2)})` : ""}`;
    if (well.lith && well.lith[i] != null && state.lith) h += `<br>Interpreted as ${esc((state.lith[well.lith[i]] || "unknown").toLowerCase())}`;
    h += `<br>${clay ? "Clay signature" : "No clay signature"}`;
    if (z && i < z.nz) h += `<br>Needs ${z.req[i].toFixed(2)}, leak-off gives ${z.avail[i].toFixed(2)} g/cm³${z.ok[i] ? " (holds)" : ""}`;
    return h;
  }
  let drag = null;
  svg.addEventListener("pointermove", (e) => {
    if (!geom) return;
    const b = svg.getBoundingClientRect(), y = ((e.clientY - b.top) / b.height) * geom.H;
    if (drag) {
      const dm = ((y - drag.y) / (geom.y1 - geom.y0)) * (drag.r[1] - drag.r[0]);
      setRange([drag.r[0] - dm, drag.r[1] - dm]); return;
    }
    if (!e.target.classList || !e.target.classList.contains("hit")) { hoverY = null; state.tip.hidden = true; redraw(); return; }
    hoverY = clamp(y, geom.y0, geom.y1);
    showTip(state.tip, tipHtml(mdOf(hoverY)), e.clientX, e.clientY);
    redraw();
  });
  svg.addEventListener("pointerleave", () => { hoverY = null; state.tip.hidden = true; redraw(); });
  svg.addEventListener("pointerdown", (e) => {
    if (e.target.classList && e.target.classList.contains("qmark")) return;
    const b = svg.getBoundingClientRect();
    drag = { y: ((e.clientY - b.top) / b.height) * geom.H, r: [...range] };
    svg.setPointerCapture(e.pointerId); state.tip.hidden = true;
  });
  const stop = () => { drag = null; };
  svg.addEventListener("pointerup", stop);
  svg.addEventListener("pointercancel", stop);
  svg.addEventListener("click", (e) => {
    const q = e.target.dataset && e.target.dataset.q;
    if (q != null) state.onQuote?.(Number(q));
  });
  svg.addEventListener("wheel", (e) => {
    if (!geom) return;
    e.preventDefault();
    const b = svg.getBoundingClientRect(), y = ((e.clientY - b.top) / b.height) * geom.H, m = mdOf(clamp(y, geom.y0, geom.y1));
    const f = Math.exp(e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), a = m - (m - range[0]) * f, c = m + (range[1] - m) * f;
    setRange([a, c]);
  }, { passive: false });
  svg.addEventListener("dblclick", () => setRange(preset("over")));

  function setRange(r) {
    let [a, b] = r; const span = clamp(b - a, 40, logBase - logTop + 40);
    if (a < logTop - 20) { a = logTop - 20; b = a + span; }
    if (b > logBase + 20) { b = logBase + 20; a = b - span; }
    range = [a, a + span]; redraw();
  }
  const ro = new ResizeObserver(() => redraw());
  ro.observe(host);
  draw();

  return {
    update(next) { state = { ...state, ...next }; redraw(); },
    preset(kind) { setRange(preset(kind)); },
    /** Mark one quote and bring its depth into view. */
    activate(qi) {
      active = qi;
      const q = (state.quotes || [])[qi], d = q && q.d && q.d[0];
      if (d != null && (d < range[0] + 15 || d > range[1] - 15)) { const half = (range[1] - range[0]) / 2; setRange([d - half, d + half]); }
      else redraw();
    },
    destroy() { ro.disconnect(); state.tip.hidden = true; },
  };
}
