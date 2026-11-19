// Nature's Plug talk: slides, steps, speaker notes, the clock, and the links between the page and the 3D scenes.
// Every number shown is read from talk/data.js; nothing is typed in twice.
(function () {
  "use strict";
  const D = window.NP_TALK;
  const $ = (s, r) => (r || document).querySelector(s), $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt = (n) => Number(n).toLocaleString("en-US");
  const body = document.body, root = document.documentElement;
  root.lang = "en";
  const slides = $$(".slide"), N = slides.length, ids = slides.map((s) => s.id);
  const MAIN = 8; // slides 1 to 8 are the talk, the rest are backup
  const isPresenter = location.hash === "#presenter";
  const reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  // ---- the 3D scenes. Without WebGL the slides still work over a plain background.
  const noop = new Proxy(function () {}, { get: () => noop, apply: () => noop });
  let world = null;
  if (!isPresenter && D) { try { world = window.NPWorld.create($("#gl"), $("#labels"), $("#world")); } catch (e) { console.warn("3D scene not available: " + e.message); world = null; } }
  if (!world) body.classList.add("no-gl");
  const W = world || noop;

  // ---- numbers
  const wb = D.wb, nWb = wb.x.length, DEF_LEN = D.defaults.minLen, DEF_RAD = D.defaults.radiusKm;
  const byField = D.fields.map(() => []);
  for (let i = 0; i < nWb; i++) if (wb.f[i] >= 0) byField[wb.f[i]].push(i);
  const cls = (i, L, R) => { const j = wb.c[i]; return j < 0 || wb.d[i] > R ? 0 : D.ctl[j].len >= L ? 2 : 1; };
  function tally(L, R, list) {
    const t = [0, 0, 0], fs = new Set();
    const one = (i) => { const c = cls(i, L, R); t[c]++; if (c === 2 && wb.f[i] >= 0) fs.add(wb.f[i]); };
    if (list) list.forEach(one); else for (let i = 0; i < nWb; i++) one(i);
    return { t, fields: fs.size };
  }
  const base = tally(DEF_LEN, DEF_RAD);
  if (base.t.join() !== D.totals.log.join() || base.fields !== D.totals.passFields) console.warn("The slide numbers differ from the engine's: rebuild talk/data.js");
  const WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen", "Twenty"];

  // ---- camera positions, one per slide and step. Angles in degrees, map distances in km.
  const mLogs = { set: "logs", t: [-92, -95, 0], az: 10, el: 4, dist: 410, sx: 0.46 };
  const SHOTS = {
    cover: [{ set: "map", ll: [3.55, 60.72], az: -32, el: 12, dist: 270, sx: 0.5, sy: 0.02, drift: 9 }],
    problem: [{ set: "map", ll: [3.7, 59.7], az: -10, el: 35, dist: 1080, sx: 0.42, sy: -0.02, drift: 3 }],
    idea: [{ set: "well", t: [0, 16.4, 0], az: 18, el: 9, dist: 66, sx: 0.38, drift: 4 }],
    built: [{ set: "map", ll: [3.2, 60.0], az: 20, el: 24, dist: 900, sx: 0.3, sy: -0.62, drift: 4 }],
    result: [{ set: "map", ll: [3.3, 59.9], az: -8, el: 40, dist: 700, sx: 0.46, drift: 3 }],
    greenclay: [{ set: "map", ll: [3.1, 60.85], az: -18, el: 30, dist: 330, sx: 0.5, drift: 5 }],
    limits: [{ set: "map", ll: [3.3, 60.6], az: 30, el: 15, dist: 380, sx: 0.5, drift: 7 }],
    next: [{ set: "map", ll: [3.6, 59.7], az: -20, el: 38, dist: 760, sx: 0.5, drift: 3 }],
    method: [mLogs, mLogs, mLogs, { set: "map", ll: [3.59, 61.03], az: -16, el: 50, dist: 235, sx: 0.44 }],
    contrast: [{ set: "logs", t: [0, -143, 0], az: 7, el: 4, dist: 610, sx: 0.39 }],
    validation: [{ set: "map", ll: [3.0, 57.8], az: -12, el: 36, dist: 620, sx: 0.44, drift: 3 }],
  };
  // On an upright screen the scene sits in the upper part and the camera backs off.
  const adapt = (s) => Object.assign({}, s, { sx: 0, sy: s.set === "logs" ? 0.5 : 0.46, dist: s.dist * clamp(0.9 / (innerWidth / innerHeight), 1, 2.4) * (s.set === "logs" ? 1.2 : 1) });

  function mapState(o) {
    W.map.mode(o.mode || "plain"); W.map.params({ minLen: o.minLen || DEF_LEN, radius: o.radius || DEF_RAD });
    W.map.showLabels(o.labels || []); W.map.discs(o.discs || 0); W.map.beams(o.beams || null); W.map.co2(o.co2 || 0);
    W.map.focus(o.focus || null); W.map.glow(o.glow == null ? 1 : o.glow); if (!o.keepReveal) W.map.reveal("shown");
  }
  const names = (list) => list.map((n) => [n, n]);
  const useNames = D.useFields.filter((u) => u.left > 0).map((u) => u.n);

  // ---- per-slide behaviour
  let labelTimer = 0, countRaf = 0;
  function countUp() {
    const el = $("#count-left"), t0 = performance.now(), dur = reduce ? 1 : 3000, total = D.totals.left;
    cancelAnimationFrame(countRaf);
    const tick = (now) => { const t = clamp((now - t0) / dur, 0, 1); el.textContent = fmt(Math.round(total * (1 - Math.pow(1 - t, 2.2)))); if (t < 1) countRaf = requestAnimationFrame(tick); };
    countRaf = requestAnimationFrame(tick);
  }
  const res = { level: "log", minLen: DEF_LEN, radius: DEF_RAD, drag: false };
  const DEFS = {
    cover: { scrim: "wide", enter() { mapState({ mode: "plain", glow: 0.6 }); } },
    problem: {
      enter(c) {
        const lab = ["Troll", "Ekofisk", "Gullfaks", "Johan Sverdrup", "Heidrun"].map((n) => { const f = D.fields.find((q) => q.n === n); return [n, "<b>" + n + "</b> " + fmt(f.left)]; });
        mapState({ mode: "plain", keepReveal: true });
        if (c.instant || reduce || !world) { W.map.reveal("shown"); W.map.showLabels(lab); $("#count-left").textContent = fmt(D.totals.left); }
        else { W.map.reveal("grow"); countUp(); labelTimer = setTimeout(() => W.map.showLabels(lab), 2300); }
      },
    },
    idea: {
      steps: 1, scrim: "none",
      enter(c) { W.well.creep(c.step ? 1 : 0, true); },
      step(s, c) { if (!c.changed) W.well.creep(s ? 1 : 0); $("#creep-btn").textContent = s ? "Open it again" : "Let the clay creep"; if (!world) $("#creep").value = s ? 100 : 0; },
    },
    built: { enter() { mapState({ mode: "log", glow: 0.7 }); } },
    result: {
      steps: 1,
      enter(c) { res.level = "log"; res.radius = DEF_RAD; res.minLen = c.step ? D.defaults.strongLen : DEF_LEN; paintResult(true); mapState({ mode: "log", minLen: res.minLen, labels: names(["Troll", "Grane", "Johan Sverdrup", "Balder", "Brage"]) }); },
      step(s, c) { if (!c.changed) tweenLen(s ? D.defaults.strongLen : DEF_LEN); },
    },
    greenclay: { scrim: "wide", enter() { mapState({ mode: "fm", glow: 0.8, labels: names(["Troll", "Oseberg", "Brage", "Visund"]) }); } },
    limits: { scrim: "wide", enter() { mapState({ mode: "log", glow: 0.7 }); } },
    next: { scrim: "wide", enter() { mapState({ mode: "log", co2: 1 }); } },
    method: {
      steps: 3, scrim: (s) => (s < 3 ? "none" : "left"),
      step(s) {
        $$("#tests .test").forEach((b, k) => { b.classList.toggle("on", k === s); b.setAttribute("aria-pressed", k === s ? "true" : "false"); });
        if (s < 3) W.logs.view("method", s + 1);
        else mapState({ mode: "log", discs: 1, labels: [["Fram", "<b>35/11-7</b> Fram"]] });
      },
    },
    contrast: { scrim: "none", enter() { for (const key of ["fram", "visund"]) { $("#pp-" + key).value = D.wells[key].i0; paintWell(key); W.logs.setK(key, null); } W.logs.view("contrast"); } },
    validation: {
      enter() { mapState({ mode: "fm", focus: useNames, beams: useNames, labels: D.useFields.filter((u) => u.left > 0).map((u) => [u.n, "<b>" + u.n + "</b> " + u.present + " of " + u.left]) }); },
    },
  };
  for (const id of ids) { DEFS[id].steps = DEFS[id].steps || 0; DEFS[id].shots = SHOTS[id]; }

  // ---- result slide
  function paintResult(instant) {
    const { t, fields } = tally(res.minLen, res.radius), isDef = res.minLen === DEF_LEN && res.radius === DEF_RAD, fm = D.totals.fm;
    $("#res-head").textContent = fmt(t[2]);
    const row = (sw, n, text) => '<div class="lg"><i class="sw ' + sw + '"></i><b>' + fmt(n) + "</b><span>" + text + "</span></div>";
    if (res.level === "log") {
      $("#res-level").textContent = "Log level · " + D.totals.controls.all + " wells with logs, " + D.totals.controls.assessed + " assessed";
      $("#legend").innerHTML = row("pass", t[2], "sit near a well that passes") + row("fail", t[1], "sit near a well that fails") + row("none", t[0], "have no assessed well within " + res.radius + " km");
    } else {
      $("#res-level").textContent = "Formation level · " + fmt(D.totals.layer1.all) + " wells, " + D.totals.layer1.assessed + " assessed";
      $("#legend").innerHTML = row("pass", fm[3], "have the clay group where the pressure holds") + row("thin", fm[2], "have less than 50 m of it there") + row("fail", fm[1], "have the clay above that depth") + row("none", fm[0], "have no assessed well within 10 km");
    }
    $("#res-note").textContent = isDef ? (WORDS[fields] || fields) + " fields have at least one such wellbore, among them Troll, Grane, Johan Sverdrup, Balder and Brage."
      : (fields === 1 ? "One field has" : (WORDS[fields] || fields) + " fields have") + " at least one such wellbore with these settings. The defaults are " + DEF_LEN + " m and " + DEF_RAD + " km.";
    $("#minlen").value = res.minLen; $("#minlen-out").textContent = res.minLen + " m";
    $("#radius").value = res.radius; $("#radius-out").textContent = res.radius + " km";
    for (const id of ["lv-log", "lv-fm"]) { const on = (id === "lv-log") === (res.level === "log"); $("#" + id).classList.toggle("on", on); $("#" + id).setAttribute("aria-pressed", on ? "true" : "false"); }
    for (const id of ["minlen", "radius"]) $("#" + id).disabled = res.level !== "log";
    W.map.mode(res.level, instant); W.map.params({ minLen: res.minLen, radius: res.radius }, instant);
    W.map.discs(res.level === "log" && (res.drag || res.radius !== DEF_RAD) ? 0.85 : 0);
  }
  let tweenTimer = 0;
  function tweenLen(to) {
    clearInterval(tweenTimer); res.level = "log";
    if (reduce) { res.minLen = to; paintResult(); return; }
    tweenTimer = setInterval(() => { if (res.minLen === to) { clearInterval(tweenTimer); return; } res.minLen += res.minLen < to ? 5 : -5; paintResult(); }, 150);
  }
  $("#minlen").addEventListener("input", (e) => { clearInterval(tweenTimer); res.minLen = +e.target.value; paintResult(); });
  $("#radius").addEventListener("input", (e) => { res.radius = +e.target.value; res.drag = true; paintResult(); });
  $("#radius").addEventListener("change", () => { res.drag = false; paintResult(); });
  $("#lv-log").addEventListener("click", () => { res.level = "log"; paintResult(); });
  $("#lv-fm").addEventListener("click", () => { clearInterval(tweenTimer); res.level = "fm"; paintResult(); });

  // ---- contrast slide: the reservoir pressure of each well can be moved, as in the app
  function paintWell(key) {
    const d = D.wells[key], s = d.sweep, k = clamp(+$("#pp-" + key).value, 0, s.pp.length - 1), len = s.len[k], zmin = s.zmin[k], pass = len >= DEF_LEN;
    $("#pp-" + key + "-out").textContent = s.pp[k].toFixed(2);
    const v = $("#v-" + key); v.textContent = pass ? "Passes" : "Fails"; v.className = "verdict " + (pass ? "pass" : "fail");
    const z = zmin == null ? "" : fmt(Math.round(zmin));
    $("#s-" + key).textContent = zmin == null ? "The rock does not hold this pressure anywhere above the reservoir."
      : pass ? len + " m of clay lies below " + z + " m, where the rock holds the pressure."
      : len === 0 ? fmt(d.clayM) + " m of clay lies above " + z + " m, where the rock starts to hold."
      : "Only " + len + " m of clay lies below " + z + " m, where the rock starts to hold.";
    return k;
  }
  for (const key of ["fram", "visund"]) {
    const inp = $("#pp-" + key), d = D.wells[key];
    inp.max = d.sweep.pp.length - 1; inp.value = d.i0;
    inp.addEventListener("input", () => { W.logs.setK(key, paintWell(key)); });
    paintWell(key);
  }

  // ---- validation slide
  $("#meters").innerHTML = D.useFields.filter((u) => u.left > 0).map((u) =>
    '<div class="meter" tabindex="0" data-name="' + u.n + '"><span class="name">' + u.n + '</span><span class="track"><span class="fill" style="width:' + ((100 * u.present) / u.left).toFixed(1) + '%"></span></span><span class="val">' + u.present + " of " + u.left + "</span></div>").join("");
  $$("#meters .meter").forEach((m) => {
    const on = () => { W.map.beams([m.dataset.name]); W.map.focus([m.dataset.name]); }, off = () => { if (ids[cur] === "validation") { W.map.beams(useNames); W.map.focus(useNames); } };
    m.addEventListener("pointerenter", on); m.addEventListener("focus", on); m.addEventListener("pointerleave", off); m.addEventListener("blur", off);
  });

  // ---- idea slide
  let creepDrag = false;
  $("#creep-btn").addEventListener("click", () => go(cur, step ? 0 : 1));
  $("#creep").addEventListener("input", (e) => { creepDrag = true; const v = +e.target.value / 100; W.well.setCreep(v); step = v > 0.93 ? 1 : 0; $("#creep-btn").textContent = step ? "Open it again" : "Let the clay creep"; });
  $("#creep").addEventListener("change", () => { creepDrag = false; });
  if (world) world.onFrame(() => { if (ids[cur] === "idea" && !creepDrag) $("#creep").value = Math.round(world.well.st.creep * 100); });

  // ---- method slide: the cards are the steps
  $$("#tests .test").forEach((b) => b.addEventListener("click", () => go(cur, +b.dataset.step)));

  // ---- built slide: the screenshot leans with the pointer; the app opens in its own tab when the talk is served beside it
  const appLink = $("#open-app"), hasApp = /^https?:$/.test(location.protocol) && /\/talk\/(index\.html)?$/.test(location.pathname);
  if (!hasApp) appLink.hidden = true;
  addEventListener("pointermove", (e) => {
    if (ids[cur] !== "built" || mode !== "stage") return;
    const img = $("#shot3d img"); img.style.setProperty("--ry", (((e.clientX / innerWidth) - 0.5) * 8).toFixed(2) + "deg"); img.style.setProperty("--rx", ((0.5 - e.clientY / innerHeight) * 6).toFixed(2) + "deg");
  });
  const openApp = () => { if (hasApp) { try { window.open(appLink.href, "np-app"); } catch (e) { /* blocked: use the link */ } } };

  // ---- hover on the map: which field, how many wellbores
  const tip = $("#tip");
  const hideTip = () => tip.classList.remove("on");
  if (world) world.onHover((h) => {
    if (!h || mode !== "stage") return hideTip();
    const f = h.field >= 0 ? D.fields[h.field] : null, list = f ? byField[h.field] : null, m = world.map.st;
    let line = f ? fmt(f.left) + " wellbores left to plug" : "Wellbores outside a field";
    if (f && m.mode === "log") { const t = tally(m.minLen, m.radius, list).t; line += "<br>" + t[2] + " pass · " + t[1] + " fail · " + t[0] + " not covered"; }
    if (f && m.mode === "fm") line += "<br>" + f.fm[3] + " clay present · " + f.fm[2] + " thin · " + f.fm[1] + " absent · " + f.fm[0] + " not covered";
    tip.innerHTML = "<b>" + (f ? f.n : "No field") + "</b>" + line;
    tip.style.transform = "translate(" + Math.min(innerWidth - 340, h.x + 16) + "px," + Math.max(8, h.y - 64) + "px)";
    tip.classList.add("on");
  });

  // ---- navigation
  let cur = -1, step = 0, mode = "stage";
  function go(i, st, how) {
    i = clamp(i, 0, N - 1);
    const def = DEFS[ids[i]], changed = i !== cur, s = clamp(st == null ? 0 : st, 0, def.steps);
    if (!changed && s === step && how !== "force") return;
    if (changed || how === "force") {
      clearTimeout(labelTimer); cancelAnimationFrame(countRaf); clearInterval(tweenTimer); $("#count-left").textContent = fmt(D.totals.left);
      slides.forEach((el, k) => { el.classList.toggle("active", k === i); if (mode === "stage") el.setAttribute("aria-hidden", k === i ? "false" : "true"); else el.removeAttribute("aria-hidden"); });
      body.dataset.slide = ids[i]; hideTip();
    }
    cur = i; step = s;
    body.dataset.scrim = typeof def.scrim === "function" ? def.scrim(s) : def.scrim || "left";
    const spec = def.shots[Math.min(s, def.shots.length - 1)], ctx = { changed: changed || how === "force", instant: how === "instant", step: s };
    W.shot(mode === "scroll" ? adapt(spec) : spec, how === "instant");
    if (ctx.changed && def.enter) def.enter(ctx);
    if (def.step) def.step(s, ctx);
    chrome();
    if (mode === "scroll" && how !== "scroll" && how !== "instant") slides[i].scrollIntoView({ block: "start" });
    send();
  }
  const next = () => { const d = DEFS[ids[cur]]; if (step < d.steps) go(cur, step + 1); else if (cur < N - 1) go(cur + 1, 0); };
  const prev = () => { if (step > 0) go(cur, step - 1); else if (cur > 0) go(cur - 1, DEFS[ids[cur - 1]].steps); };

  // ---- controls around the stage
  const dots = $("#dots");
  ids.forEach((id, k) => {
    if (k === MAIN) { const g = document.createElement("span"); g.className = "gap"; dots.appendChild(g); }
    const b = document.createElement("button"); b.type = "button"; b.title = (k + 1) + ". " + slides[k].dataset.title; b.setAttribute("aria-label", "Slide " + (k + 1) + ": " + slides[k].dataset.title);
    b.addEventListener("click", () => go(k, 0)); dots.appendChild(b);
  });
  function chrome() {
    $$("button", dots).forEach((b, k) => { b.classList.toggle("on", k === cur); b.classList.toggle("done", k < cur); });
    $("#pageno").textContent = (cur + 1) + " / " + N;
    const el = slides[cur];
    $("#nt-no").textContent = (cur + 1) + " / " + N; $("#nt-title").textContent = el.dataset.title; $("#nt-time").textContent = el.dataset.time;
    $("#nt-body").innerHTML = $(".notes", el).innerHTML;
    $("#nt-next").textContent = cur < N - 1 ? "Next: " + slides[cur + 1].dataset.title : "Last slide";
    try { history.replaceState(null, "", "#" + ids[cur]); } catch (e) { /* the address stays as it is */ }
  }
  const toggleNotes = (on) => $("#notes").classList.toggle("open", on);
  const toggleHelp = (on) => $("#help").classList.toggle("open", on);
  function fullscreen() {
    try { const p = document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* not available here */ }
  }
  function presenterWindow() {
    let w = null;
    try { w = window.open(location.href.split("#")[0] + "#presenter", "np-presenter", "width=980,height=760"); } catch (e) { w = null; }
    if (!w) toggleNotes(true);
  }
  $("#b-prev").addEventListener("click", prev); $("#b-next").addEventListener("click", next);
  $("#b-notes").addEventListener("click", () => toggleNotes()); $("#nt-close").addEventListener("click", () => toggleNotes(false));
  $("#b-full").addEventListener("click", fullscreen);
  $("#b-help").addEventListener("click", () => toggleHelp()); $("#help-close").addEventListener("click", () => toggleHelp(false));
  $("#help").addEventListener("click", (e) => { if (e.target.id === "help") toggleHelp(false); });
  // After a mouse click, keys go back to the slides instead of the control that was clicked.
  addEventListener("click", (e) => { const t = e.target.closest && e.target.closest("button, a"); if (t && e.detail > 0) t.blur(); });
  addEventListener("pointerup", (e) => { if (e.target.tagName === "INPUT" && e.target.type === "range") e.target.blur(); });

  // ---- the clock
  const timer = { run: false, acc: 0, t0: 0 };
  const elapsed = () => timer.acc + (timer.run ? Date.now() - timer.t0 : 0);
  function paintClock() {
    const s = Math.floor(elapsed() / 1000), txt = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    for (const el of [$("#timer"), $("#pv-clock")]) { el.textContent = txt; el.classList.toggle("run", timer.run); el.classList.toggle("late", s >= 210 && s < 240); el.classList.toggle("over", s >= 240); }
    $("#pv-timer").textContent = timer.run ? "Pause the clock" : elapsed() ? "Continue the clock" : "Start the clock";
  }
  function toggleTimer() { if (timer.run) { timer.acc = elapsed(); timer.run = false; } else { timer.t0 = Date.now(); timer.run = true; } paintClock(); send(); }
  function resetTimer() { timer.run = false; timer.acc = 0; paintClock(); send(); }
  $("#timer").addEventListener("click", (e) => (e.shiftKey ? resetTimer() : toggleTimer()));
  setInterval(paintClock, 250);

  // ---- a second window with the notes follows this one (same browser, same address)
  let chan = null, linked = false;
  try { chan = new BroadcastChannel("np-talk"); } catch (e) { chan = null; }
  function send() { if (chan && !isPresenter) chan.postMessage({ type: "state", i: cur, step, timer }); }
  const pv = { i: 0 };
  function pvPaint() {
    const el = slides[pv.i];
    $("#pv-no").textContent = (pv.i + 1) + " / " + N; $("#pv-title").textContent = el.dataset.title; $("#pv-time").textContent = el.dataset.time;
    $("#pv-notes").innerHTML = $(".notes", el).innerHTML;
    $("#pv-nexttitle").textContent = (pv.i < N - 1 ? "Next: " + slides[pv.i + 1].dataset.title : "Last slide") + (linked ? "" : " · not linked to a slide window");
  }
  const cmd = (c) => { if (linked && chan) chan.postMessage({ type: "cmd", cmd: c }); else if (c === "next") { pv.i = Math.min(N - 1, pv.i + 1); pvPaint(); } else if (c === "prev") { pv.i = Math.max(0, pv.i - 1); pvPaint(); } else if (c === "timer") toggleTimer(); else if (c === "reset") resetTimer(); };
  if (chan) chan.onmessage = (ev) => {
    const m = ev.data || {};
    if (isPresenter) { if (m.type === "state") { linked = true; pv.i = clamp(m.i, 0, N - 1); Object.assign(timer, m.timer); pvPaint(); paintClock(); } }
    else if (m.type === "hello") send();
    else if (m.type === "cmd") { if (m.cmd === "next") next(); else if (m.cmd === "prev") prev(); else if (m.cmd === "timer") toggleTimer(); else if (m.cmd === "reset") resetTimer(); }
  };
  $("#pv-prev").addEventListener("click", () => cmd("prev")); $("#pv-next").addEventListener("click", () => cmd("next")); $("#pv-timer").addEventListener("click", () => cmd("timer"));

  // ---- keys
  addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target, k = e.key, tag = t && t.tagName;
    if (tag === "INPUT" && t.type === "range" && /^Arrow|^Home$|^End$|^Page/.test(k)) return; // a focused slider keeps its own keys
    if ((tag === "BUTTON" || tag === "A") && (k === " " || k === "Enter")) return;
    const act = (fn) => { e.preventDefault(); fn(); };
    if (k === "Escape") return act(() => { toggleHelp(false); toggleNotes(false); });
    if (isPresenter) {
      if (k === "ArrowRight" || k === "PageDown" || k === " " || k === "ArrowDown") act(() => cmd("next"));
      else if (k === "ArrowLeft" || k === "PageUp" || k === "ArrowUp" || k === "Backspace") act(() => cmd("prev"));
      else if (k === "t") act(() => cmd("timer")); else if (k === "T") act(() => cmd("reset"));
      return;
    }
    if (k === "ArrowRight" || k === "PageDown" || k === " " || (k === "ArrowDown" && mode === "stage")) act(next);
    else if (k === "ArrowLeft" || k === "PageUp" || k === "Backspace" || (k === "ArrowUp" && mode === "stage")) act(prev);
    else if (k === "Home") act(() => go(0, 0)); else if (k === "End") act(() => go(N - 1, 0));
    else if (/^[0-9]$/.test(k)) act(() => go(k === "0" ? 9 : +k - 1, 0)); // slide 11 is reached with the arrow keys
    else if (k === "n" || k === "N") act(() => toggleNotes());
    else if (k === "p" || k === "P") act(presenterWindow);
    else if (k === "f" || k === "F") act(fullscreen);
    else if (k === "t") act(toggleTimer); else if (k === "T") act(resetTimer);
    else if (k === "r" || k === "R") act(() => W.resetView());
    else if (k === "h" || k === "H" || k === "?") act(() => toggleHelp());
    else if (k === "d" || k === "D") act(openApp);
  });

  // ---- layout: a scaled stage on a wide screen, a scrolling column on a narrow or upright one
  function layout() {
    const w = innerWidth, h = innerHeight, scroll = !isPresenter && (w < 760 || w / h < 1.05), m = scroll ? "scroll" : "stage", k = scroll ? 0.58 : Math.min(w / 1920, h / 1080);
    root.style.setProperty("--k", k.toFixed(4));
    W.stage(scroll ? 1 : (1920 * k) / w, scroll ? 1 : (1080 * k) / h);
    if (m !== mode) { mode = m; body.classList.toggle("scroll", scroll); W.interactive(!scroll); W.logs.compact(scroll); W.well.compact(scroll); if (cur >= 0) go(cur, step, "force"); }
  }
  addEventListener("resize", layout);
  const io = "IntersectionObserver" in window ? new IntersectionObserver((ents) => {
    if (mode !== "scroll") return;
    let best = null; for (const en of ents) if (en.isIntersecting && (!best || en.intersectionRatio > best.intersectionRatio)) best = en;
    if (best) go(ids.indexOf(best.target.id), 0, "scroll");
  }, { root: $("#deck"), threshold: [0.5] }) : null;
  if (io) slides.forEach((s) => io.observe(s));
  addEventListener("hashchange", () => { const k = ids.indexOf(location.hash.slice(1)); if (k >= 0 && k !== cur) go(k, 0); });

  // ---- start
  if (isPresenter) {
    body.classList.add("presenter"); document.title = "Notes: Nature’s Plug";
    pvPaint(); paintClock(); if (chan) chan.postMessage({ type: "hello" });
  } else {
    mode = ""; layout();
    go(Math.max(0, ids.indexOf(location.hash.slice(1))), 0, "instant");
    paintClock();
    const wake = () => { try { if (navigator.wakeLock) navigator.wakeLock.request("screen").catch(() => {}); } catch (e) { /* not available */ } removeEventListener("pointerdown", wake); removeEventListener("keydown", wake); };
    addEventListener("pointerdown", wake); addEventListener("keydown", wake);
  }
  window.NPDeck = { go, next, prev, get state() { return { cur, step, mode, id: ids[cur] }; }, world };
})();
