// Green Clay predictor page. Reads ../data/greenclay.json (built by pipeline/greenclay/), ../data/geo.json and ../data/wellbores.json.
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmt = (n) => Math.round(n).toLocaleString("en-US");
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const NS = "http://www.w3.org/2000/svg";

  // Thickness in metres from the thickness of the Hordaland Group: the fitted line, kept inside the range the sites cover.
  function thickness(rule, hordaland) {
    return Math.min(hordaland, Math.max(rule.tmin, Math.min(rule.tmax, rule.a + rule.b * hordaland)));
  }
  window.GreenClay = { thickness };

  // Sequential ramp for depth to the top: one hue, light (shallow) to dark (deep).
  const RAMP = [[204, 229, 255], [120, 178, 240], [42, 120, 214], [20, 70, 150], [10, 34, 86]];
  const D0 = 600, D1 = 2600;
  function ramp(v) {
    const t = Math.max(0, Math.min(1, (v - D0) / (D1 - D0))) * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(t)), f = t - i;
    const c = RAMP[i].map((a, k) => Math.round(a + (RAMP[i + 1][k] - a) * f));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  Promise.all(["../data/greenclay.json", "../data/geo.json", "../data/wellbores.json", "../data/barrier.json"].map((u) => fetch(u).then((r) => {
    if (!r.ok) throw new Error(u + " " + r.status);
    return r.json();
  }))).then(([G, geo, wb, B]) => { start(G, geo, wb); drawCases(B); }).catch((e) => {
    $("#kpis").innerHTML = `<div class="kpi"><b>Could not load the data</b><span>${esc(e.message)}. Serve the repository folder and open /greenclay/.</span></div>`;
  });

  function start(G, geo, wb) {
    const R = G.rule, cv = G.cv.field, ok = G.sites.filter((s) => s.ok);
    // ---------- headline numbers
    $("#kpis").innerHTML = [
      [fmt(R.named_wellbores), "wellbores whose public reports name the Green Clay"],
      [`${R.sites} sites`, `in ${R.fields} fields give its top as a depth`],
      [`${fmt(cv.line.mae)} m`, `average miss on a field the model has not seen (${fmt(cv.middle.mae)} m for a plain guess)`],
      [fmt(G.counts.named || 0), "wellbores left to plug within 10 km of a report that names it"],
      [`${G.logs.check.lower} of ${G.logs.check.n}`, "log wells with lower resistivity inside the predicted interval"],
    ].map(([b, s]) => `<div class="kpi"><b>${esc(b)}</b><span>${esc(s)}</span></div>`).join("");
    $("#formula").textContent = `top = Rogaland top − thickness;  thickness = ${fmt(R.a)} m + ${R.b.toFixed(2)} × Hordaland thickness, kept within ${fmt(R.tmin)}–${fmt(R.tmax)} m`;
    $("#lim-n").textContent = `${R.sites} sites in ${R.fields} fields, taken from ${R.wellbores} wellbores.`;
    $("#sites-sub").textContent = `${R.sites_all} sites with a quoted depth, from ${fmt(R.mentions)} mentions in ${fmt(R.named_wellbores)} wellbores. Predicted depths are from the model fitted without that field.`;
    $("#logs-sub").textContent = `Median of ${G.logs.n.rdep} log wells, each log scaled to its own Hordaland Group average. The band is a typical predicted interval.`;

    drawScatter(ok, cv.line);
    drawBars(G.cv.field);
    drawStack(G.logs, R);
    drawSites(G.sites);
    lookup(G, wb);
    map(G, geo, wb);

    $("#theme").addEventListener("click", () => {
      const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = t;
      try { localStorage.setItem("np-theme", t); } catch (e) { /* private window */ }
      window.dispatchEvent(new Event("gc-redraw"));
    });
  }

  // ---------- small SVG helpers
  function svg(w, h) { const s = document.createElementNS(NS, "svg"); s.setAttribute("viewBox", `0 0 ${w} ${h}`); s.setAttribute("role", "img"); return s; }
  function el(parent, tag, attrs, text) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    parent.appendChild(e); return e;
  }

  function drawScatter(sites, stat) {
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
    $("#scatter").replaceChildren(s);
  }

  function drawBars(cv) {
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
    $("#bars").replaceChildren(s);
  }

  function drawStack(L, R) {
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
    $("#stack").replaceChildren(s);
  }

  function drawSites(sites) {
    const rows = sites.slice().sort((a, b) => a.field.localeCompare(b.field) || a.tvd - b.tvd).map((s) => {
      const q = esc(s.text).replace("[Green Clay]", "<mark>Green Clay</mark>");
      const pred = s.ok ? `<td class="r">${fmt(s.pred)}</td><td class="r">${s.err > 0 ? "+" : ""}${fmt(s.err)}</td>` : `<td class="r" colspan="2">not used: ${esc(s.why || "")}</td>`;
      return `<tr><td>${esc(s.field)}</td><td>${esc(s.wells[0])}${s.wells.length > 1 ? ` <span class="muted">+${s.wells.length - 1}</span>` : ""}</td><td class="r">${fmt(s.tvd)}</td>${pred}` +
        `<td class="r">${esc(s.ref)} <span class="muted">${s.ref_km.toFixed(1)} km</span></td><td class="q">…${q}…</td><td class="src">${esc(s.item.replace(/_/g, " ").toLowerCase())}, p. ${s.page}<br>${esc(s.file)}</td></tr>`;
    }).join("");
    $("#sites").innerHTML = `<thead><tr><th>Field</th><th>Wellbore</th><th class="r">Reported top, m</th><th class="r">Predicted, m</th><th class="r">Miss, m</th><th class="r">Reference well</th><th>What the report says</th><th>Source</th></tr></thead><tbody>${rows}</tbody>`;
  }

  // Documented cases of clay as a barrier (data/barrier.json: read by hand from the reports, then compared with the atlas).
  const OUT = { used: "Used as a barrier", logged: "Confirmed on log", planned: "Planned, result not public", failed: "Did not hold" };
  function drawCases(B) {
    const order = { failed: 0, used: 1, logged: 2, planned: 3 };
    const cases = B.cases.slice().sort((a, b) => b.gc - a.gc || order[a.outcome] - order[b.outcome] || a.w.localeCompare(b.w));
    const good = cases.filter((c) => c.outcome === "used" || c.outcome === "logged"), bad = cases.filter((c) => c.outcome === "failed");
    const n = (list, f) => list.filter(f).length;
    $("#cases-sub").textContent = `${cases.length} wells from the public reports: ${good.length} where clay was used or confirmed on a log, ${bad.length} where it did not hold, ${cases.length - good.length - bad.length} where it was planned. ${n(cases, (c) => c.gc)} of them name the Green Clay.`;
    $("#cases").innerHTML = `<thead><tr><th>Wellbore</th><th>Unit</th><th>Outcome</th><th>What the report says</th><th>The atlas says here</th><th class="r">Green Clay model, m</th><th>Source</th></tr></thead><tbody>` + cases.map((c) =>
      `<tr><td>${esc(c.w)}<br><span class="muted">${esc(c.area)}</span></td><td class="gc">${c.gc ? `<b>${esc(c.unit)}</b>` : esc(c.unit)}</td><td><span class="out ${c.outcome}">${OUT[c.outcome]}</span></td>` +
      `<td class="q">${esc(c.summary)}<br><span class="muted">${esc(c.how)}.</span></td>` +
      `<td class="says"><span>Logs: ${c.log ? `${c.log.cls} <span class="muted" style="display:inline">(${esc(c.log.well)}, ${c.log.km} km)</span>` : "no log well nearby"}</span><span>Formation: ${c.fm ? `clay ${c.fm.cls}` : "not covered"}</span></td>` +
      `<td class="r">${c.gcm ? `${fmt(c.gcm.top)}–${fmt(c.gcm.base)}` : "–"}</td><td class="src">${esc(c.src.item.replace(/_/g, " ").toLowerCase())}, p. ${c.src.page}${c.src.w !== c.w ? ` (in the report for ${esc(c.src.w)})` : ""}<br>${esc(c.src.file)}</td></tr>`).join("") + "</tbody>";
    const gl = good.filter((c) => c.log), gf = good.filter((c) => c.fm), bl = bad.filter((c) => c.log), bf = bad.filter((c) => c.fm);
    $("#cases-note").textContent = `How the atlas does against these: of the ${good.length} wells where clay held, the log level has a verdict for ${gl.length} and says pass for ${n(gl, (c) => c.log.cls === "pass")}; the formation level has a verdict for ${gf.length} and says present for ${n(gf, (c) => c.fm.cls === "present")}. ` +
      `For the ${bad.length} wells where it did not hold, the log level says fail for ${n(bl, (c) => c.log.cls === "fail")} of ${bl.length} and the formation level says absent for ${n(bf, (c) => c.fm.cls === "absent")} of ${bf.length}. ` +
      `So the atlas is cautious: it misses most of the places where clay was accepted. One reason is that it tests the clay against the pressure of the main reservoir, while several of these wells used it against a shallower zone or used the Shetland Group, which the formation level does not count.`;
  }

  function wbInfo(G, wb, i) {
    const W = G.wb, top = W.top[i];
    const where = W.kn[i] <= 10 ? `<span class="tag named">named in reports ${W.kn[i].toFixed(1)} km away</span>` : `<span class="tag">not named within 10 km (nearest ${fmt(W.kn[i])} km)</span>`;
    if (top == null) return `<b>${esc(wb.name[i])}</b><p>No vertical exploration well with both group tops within 10 km, so there is no prediction here.</p>`;
    return `<b>${esc(wb.name[i])}</b> <span class="muted">${esc(wb.fields[wb.field[i]] || "")}</span>${where}
      <dl><dt>Predicted top</dt><dd class="big">${fmt(top)} m</dd>
      <dt>Predicted interval</dt><dd>${fmt(top)}–${fmt(top + W.th[i])} m below the rig floor, ${fmt(W.th[i])} m thick</dd>
      <dt>Typical miss</dt><dd>about ${fmt(G.cv.field.line.mae)} m, 9 in 10 within ${fmt(G.cv.field.line.p90)} m (from ${G.rule.sites} sites)</dd>
      <dt>Group tops from</dt><dd>${esc(G.refnames[W.ref[i]])}, ${W.rk[i].toFixed(1)} km away</dd>
      <dt>Own reports</dt><dd>${W.own[i] ? `name the Green Clay ${W.own[i]} time${W.own[i] > 1 ? "s" : ""}` : "do not name the Green Clay"}</dd></dl>`;
  }

  function lookup(G, wb) {
    $("#wb-list").innerHTML = wb.name.map((n) => `<option value="${esc(n)}">`).join("");
    const idx = new Map(wb.name.map((n, i) => [n.toLowerCase(), i]));
    const show = () => {
      const i = idx.get($("#find").value.trim().toLowerCase());
      $("#found").classList.toggle("muted", i == null);
      $("#found").innerHTML = i == null ? ($("#find").value.trim() ? "No wellbore left to plug has that exact name." : "Type a wellbore name to see where the model puts the Green Clay.") : wbInfo(G, wb, i);
    };
    $("#find").addEventListener("input", show); $("#find").addEventListener("change", show);
    window.addEventListener("gc-pick", (e) => { $("#find").value = wb.name[e.detail]; show(); });
  }

  // ---------- map
  function map(G, geo, wb) {
    const cv = $("#map"), wrap = $("#map-wrap"), tip = $("#tip"), ctx = cv.getContext("2d");
    const K = Math.cos(61 * Math.PI / 180);
    const VIEWS = { north: [1.2, 58.4, 6.6, 62.4], all: [-1, 55.5, 33, 74.5] };
    let mode = "ex", cx = 0, cy = 0, scale = 1, W = 0, H = 0, pts = [];
    const X = (lon) => (lon * K - cx) * scale + W / 2, Y = (lat) => (cy - lat) * scale + H / 2;
    function view(b) { cx = (b[0] + b[2]) / 2 * K; cy = (b[1] + b[3]) / 2; scale = Math.min(W / ((b[2] - b[0]) * K), H / (b[3] - b[1])) * .96; draw(); }
    function size() { const r = wrap.getBoundingClientRect(), d = devicePixelRatio || 1; W = r.width; H = r.height; cv.width = W * d; cv.height = H * d; ctx.setTransform(d, 0, 0, d, 0, 0); }

    function draw() {
      ctx.fillStyle = css("--sea"); ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = css("--land"); ctx.strokeStyle = css("--land-line"); ctx.lineWidth = 1;
      for (const ring of geo.land) { ctx.beginPath(); ring.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1])))); ctx.closePath(); ctx.fill(); ctx.stroke(); }
      pts = [];
      const r = Math.max(2.4, Math.min(6, scale / 28)), muted = css("--muted"), edge = document.documentElement.dataset.theme === "dark" ? "rgba(255,255,255,.55)" : "rgba(0,0,0,.35)";
      if (mode === "ex") {
        const E = G.ex;
        for (let i = 0; i < E.n.length; i++) {
          const x = X(E.lo[i]), y = Y(E.la[i]);
          if (x < -10 || y < -10 || x > W + 10 || y > H + 10) continue;
          const named = E.kn[i] <= 10, col = ramp(E.top[i]);
          ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832);
          if (named) { ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = .8; ctx.strokeStyle = edge; ctx.stroke(); } else { ctx.lineWidth = 1.6; ctx.strokeStyle = col; ctx.globalAlpha = .75; ctx.stroke(); ctx.globalAlpha = 1; }
          pts.push({ x, y, t: "ex", i });
        }
      } else {
        const Wb = G.wb, acc = css("--accent");
        for (let i = 0; i < wb.name.length; i++) {
          const x = X(wb.lon[i]), y = Y(wb.lat[i]);
          if (x < -10 || y < -10 || x > W + 10 || y > H + 10) continue;
          ctx.beginPath(); ctx.arc(x, y, r * .9, 0, 6.2832);
          if (Wb.top[i] == null) { ctx.fillStyle = muted; ctx.globalAlpha = .35; ctx.fill(); ctx.globalAlpha = 1; } else if (Wb.kn[i] <= 10) { ctx.fillStyle = ramp(Wb.top[i]); ctx.fill(); ctx.lineWidth = .8; ctx.strokeStyle = edge; ctx.stroke(); } else { ctx.lineWidth = 1.4; ctx.strokeStyle = ramp(Wb.top[i]); ctx.globalAlpha = .7; ctx.stroke(); ctx.globalAlpha = 1; }
          pts.push({ x, y, t: "wb", i });
        }
        void acc;
      }
      // report sites: the answer key
      const sc = css("--site"), pc = css("--panel");
      for (let i = 0; i < G.sites.length; i++) {
        const s = G.sites[i], x = X(s.lo), y = Y(s.la), q = r + 3.5;
        ctx.beginPath(); ctx.moveTo(x, y - q); ctx.lineTo(x + q, y); ctx.lineTo(x, y + q); ctx.lineTo(x - q, y); ctx.closePath();
        ctx.lineWidth = 3.5; ctx.strokeStyle = pc; ctx.stroke(); ctx.lineWidth = 1.8; ctx.strokeStyle = sc; ctx.stroke();
        pts.push({ x, y, t: "site", i });
      }
    }

    function nearest(mx, my) {
      let best = null, bd = 144;
      for (const p of pts) { const d = (p.x - mx) ** 2 + (p.y - my) ** 2 - (p.t === "site" ? 30 : 0); if (d < bd) { bd = d; best = p; } }
      return best;
    }
    function tipHtml(p) {
      if (p.t === "site") { const s = G.sites[p.i]; return `<b>Report site: ${esc(s.wells[0])}</b>${esc(s.field)}<br>Reported top ${fmt(s.tvd)} m${s.ok ? `<br>Predicted without this field ${fmt(s.pred)} m (${s.err > 0 ? "+" : ""}${fmt(s.err)} m)` : "<br>Not used in the model"}`; }
      if (p.t === "ex") { const E = G.ex, i = p.i; return `<b>${esc(E.n[i])}</b>Predicted top ${fmt(E.top[i])} m, ${fmt(E.th[i])} m thick<br>Hordaland top ${fmt(E.ho[i])} m, Rogaland top ${fmt(E.ro[i])} m<br>${E.kn[i] <= 10 ? `Green Clay named in a report ${E.kn[i].toFixed(1)} km away` : `Not named within 10 km (nearest ${fmt(E.kn[i])} km)`}${E.dev[i] ? "<br>Deviated well: depths are along the hole" : ""}`; }
      const Wb = G.wb, i = p.i;
      return `<b>${esc(wb.name[i])}</b>${Wb.top[i] == null ? "No prediction: no reference well within 10 km" : `Predicted top ${fmt(Wb.top[i])} m, ${fmt(Wb.th[i])} m thick<br>${Wb.kn[i] <= 10 ? `Green Clay named in a report ${Wb.kn[i].toFixed(1)} km away` : `Not named within 10 km (nearest ${fmt(Wb.kn[i])} km)`}<br>Click for details`}`;
    }

    let drag = null, moved = false;
    cv.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY }; moved = false; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener("pointermove", (e) => {
      const b = cv.getBoundingClientRect(), mx = e.clientX - b.left, my = e.clientY - b.top;
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
        cx -= dx / scale; cy += dy / scale; drag = { x: e.clientX, y: e.clientY }; tip.hidden = true; draw(); return;
      }
      const p = nearest(mx, my);
      if (!p) { tip.hidden = true; return; }
      tip.innerHTML = tipHtml(p); tip.hidden = false;
      tip.style.left = Math.min(W - 270, mx + 14) + "px"; tip.style.top = Math.min(H - tip.offsetHeight - 6, my + 14) + "px";
    });
    cv.addEventListener("pointerup", (e) => {
      const b = cv.getBoundingClientRect(), p = moved ? null : nearest(e.clientX - b.left, e.clientY - b.top);
      drag = null;
      if (p && p.t === "wb") window.dispatchEvent(new CustomEvent("gc-pick", { detail: p.i }));
    });
    cv.addEventListener("pointerleave", () => { tip.hidden = true; });
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const b = cv.getBoundingClientRect(), mx = e.clientX - b.left, my = e.clientY - b.top, f = Math.exp(-e.deltaY * .0015);
      const lonK = (mx - W / 2) / scale + cx, lat = cy - (my - H / 2) / scale;
      scale = Math.max(8, Math.min(4000, scale * f)); cx = lonK - (mx - W / 2) / scale; cy = lat + (my - H / 2) / scale; draw();
    }, { passive: false });
    document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => view(VIEWS[b.dataset.view])));
    document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", () => {
      mode = b.dataset.mode; document.querySelectorAll("[data-mode]").forEach((o) => o.classList.toggle("on", o === b)); draw();
    }));
    const stops = RAMP.map((c, i) => `rgb(${c.join(",")}) ${i / (RAMP.length - 1) * 100}%`).join(", ");
    $("#legend").innerHTML = `<span class="ramp">Top at ${fmt(D0)} m <i style="background:linear-gradient(90deg, ${stops})"></i> ${fmt(D1)} m</span>` +
      `<span class="key"><span class="sw" style="background:var(--c1);border-color:transparent"></span>named in reports nearby</span>` +
      `<span class="key"><span class="sw" style="border-color:var(--c1)"></span>model only</span>` +
      `<span class="key"><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1l6 6-6 6-6-6z" fill="none" stroke="var(--site)" stroke-width="1.8"/></svg>report site with a depth</span>`;
    new ResizeObserver(() => { const first = !W; size(); first ? view(VIEWS.north) : draw(); }).observe(wrap);
    window.addEventListener("gc-redraw", draw);
    window.GreenClay.map = { setMode: (m) => document.querySelector(`[data-mode="${m}"]`).click(), points: () => pts.length };
  }
})();
