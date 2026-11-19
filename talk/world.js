// Nature's Plug talk: the three 3D scenes behind the slides.
//   map   the shelf, with every wellbore left to plug stacked in hexagonal columns (one slab = one wellbore)
//   well  a cut-away of one well, where the clay closes the space behind the casing
//   logs  two wells drawn to the same depth scale: Fram passes, Visund fails
// All numbers come from talk/data.js, which talk/build-data.mjs computes with the app's engine.
(function () {
  "use strict";
  const PI = Math.PI, RAD = PI / 180;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const hex = (h, a) => { const n = parseInt(h.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a == null ? 1 : a]; };
  const shade = (c, k, a) => [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k), a == null ? c[3] : a];
  const fmt = (n) => Number(n).toLocaleString("en-US");

  // Colours. The status colours are the app's; the same values are in talk.css.
  const COL = {
    bg: "#0a1412", sea: "#0c1a19", land: "#1b2d26", landLine: "#4b685c", grid: "#1d3431", field: "#6b8b7f",
    plain: "#c4d6ce", pass: "#2fcb93", fail: "#f0703a", thin: "#c79a78", none: "#4d5b56", co2: "#6fb1ff", ctl: "#f2f7f4",
  };
  const F = {}; for (const k in COL) F[k] = hex(COL[k]);

  const S = 5;          // hexagon radius, km
  const SLAB = 0.62;    // height of one wellbore in a column, km
  const LOGN = 0, LOGF = 1, LOGP = 2;

  function create(canvas, labelsEl, wrap) {
    const D = window.NP_TALK, R = window.NPGL && window.NPGL.create(canvas);
    if (!R || !D) return null;
    const reduce = !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const light = (() => { const v = [0.42, 0.78, 0.46], l = Math.hypot(v[0], v[1], v[2]); return v.map((x) => x / l); })();

    // ---- map projection, the same one build-data.mjs uses
    const pj = D.proj, tq = (p) => Math.tan(PI / 4 + (p * RAD) / 2);
    const nn = Math.log(Math.cos(pj.phi1 * RAD) / Math.cos(pj.phi2 * RAD)) / Math.log(tq(pj.phi2) / tq(pj.phi1));
    const FF = (Math.cos(pj.phi1 * RAD) * Math.pow(tq(pj.phi1), nn)) / nn, rho0 = (6371 * FF) / Math.pow(tq(pj.phi0), nn);
    const km = (lon, lat) => { const rho = (6371 * FF) / Math.pow(tq(lat), nn), th = nn * (lon - pj.lam0) * RAD; return [rho * Math.sin(th), rho0 - rho * Math.cos(th)]; };

    // ---------------------------------------------------------------- labels
    const labels = [];
    function addLabel(set, cls, html, pos) {
      const el = document.createElement("div"); el.className = "l3 " + cls;
      const inner = document.createElement("span"); inner.innerHTML = html; el.appendChild(inner); labelsEl.appendChild(el);
      const L = { set, el, inner, pos, dyn: null, on: false, shown: false };
      labels.push(L); return L;
    }
    const setText = (L, html) => { if (L.html !== html) { L.html = html; L.inner.innerHTML = html; L.w = 0; } };
    addEventListener("resize", () => { for (const L of labels) L.w = 0; });

    // ================================================================= MAP
    const map = (() => {
      const X0 = -640, X1 = 1160, Y0 = -700, Y1 = 1700;
      const small = Math.min(window.innerWidth, window.innerHeight) < 700;
      const tw = small ? 1536 : 3072, th = small ? 2048 : 4096;
      const cv = document.createElement("canvas"); cv.width = tw; cv.height = th;
      const c = cv.getContext("2d"), kx = tw / (X1 - X0), ky = th / (Y1 - Y0);
      const path = (r) => { c.beginPath(); for (let k = 0; k < r.length; k += 2) { const x = (r[k] - X0) * kx, y = (Y1 - r[k + 1]) * ky; if (k) c.lineTo(x, y); else c.moveTo(x, y); } c.closePath(); };
      c.fillStyle = COL.sea; c.fillRect(0, 0, tw, th);
      c.fillStyle = COL.land; c.strokeStyle = "rgba(75, 104, 92, 0.55)"; c.lineWidth = small ? 1 : 1.4; c.lineJoin = "round";
      for (const r of D.land) { path(r); c.fill(); c.stroke(); }
      c.fillStyle = "rgba(150, 200, 180, 0.10)"; c.strokeStyle = "rgba(150, 200, 180, 0.30)"; c.lineWidth = small ? 0.8 : 1.2;
      for (const f of D.fields) for (const r of f.r) { path(r); c.fill(); c.stroke(); }
      const ground = new R.Ground(14000, (x, z) => [(x - X0) / (X1 - X0), (-z - Y0) / (Y1 - Y0)], cv);

      // crisp lines on top of the texture
      const lp = [], lc = [];
      const seg = (x1, y1, x2, y2, col) => { lp.push(x1, 0, -y1, x2, 0, -y2); lc.push(col[0], col[1], col[2], col[3], col[0], col[1], col[2], col[3]); };
      const ringSeg = (r, col) => { for (let k = 0; k < r.length - 2; k += 2) seg(r[k], r[k + 1], r[k + 2], r[k + 3], col); };
      const cGrid = hex(COL.grid, 0.9), cCoast = hex(COL.landLine, 0.85), cField = hex(COL.field, 0.5);
      for (let k = 0; k < D.quads.length; k += 4) seg(D.quads[k], D.quads[k + 1], D.quads[k + 2], D.quads[k + 3], cGrid);
      for (const r of D.land) ringSeg(r, cCoast);
      for (const f of D.fields) for (const r of f.r) ringSeg(r, cField);
      const lines = new R.Lines(lp, lc);
      const cp = [], cc = [], cCo2 = hex(COL.co2, 0.95);
      for (const l of D.co2) for (const r of l.r) for (let k = 0; k < r.length - 2; k += 2) { cp.push(r[k], 0, -r[k + 1], r[k + 2], 0, -r[k + 3]); cc.push(...cCo2, ...cCo2); }
      const co2Lines = new R.Lines(cp, cc);

      // ---- hexagonal bins: every wellbore becomes one slab in the column of its hexagon
      const wb = D.wb, n = wb.x.length, binMap = new Map();
      for (let i = 0; i < n; i++) {
        const x = wb.x[i], y = wb.y[i], q = ((Math.sqrt(3) / 3) * x - y / 3) / S, r = ((2 / 3) * y) / S, s = -q - r;
        let rq = Math.round(q), rr = Math.round(r), rs = Math.round(s);
        const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs - s);
        if (dq > dr && dq > ds) rq = -rr - rs; else if (dr > ds) rr = -rq - rs;
        const key = rq + "," + rr;
        if (!binMap.has(key)) binMap.set(key, { X: S * Math.sqrt(3) * (rq + rr / 2), Y: S * 1.5 * rr, idx: [] });
        binMap.get(key).idx.push(i);
      }
      const classOf = (i, minLen, radius) => { const j = wb.c[i]; return j < 0 || wb.d[i] > radius ? LOGN : D.ctl[j].len >= minLen ? LOGP : LOGF; };
      const bins = [...binMap.values()];
      let yMin = Infinity, yMax = -Infinity;
      for (const b of bins) { yMin = Math.min(yMin, b.Y); yMax = Math.max(yMax, b.Y); }
      let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      const slabWb = new Int32Array(n), slabBin = new Int32Array(n), aBuf = new Float32Array(n * 4), dBuf = new Float32Array(n);
      let ii = 0;
      bins.forEach((b, bi) => {
        b.Z = -b.Y; b.h = b.idx.length; b.i0 = ii;
        b.delay = 0.1 + (1.9 * (b.Y - yMin)) / (yMax - yMin) + rnd() * 0.18;
        b.idx.sort((p, q) => classOf(q, D.defaults.minLen, D.defaults.radiusKm) - classOf(p, D.defaults.minLen, D.defaults.radiusKm) || wb.f[p] - wb.f[q] || p - q);
        const tally = new Map(); for (const i of b.idx) tally.set(wb.f[i], (tally.get(wb.f[i]) || 0) + 1);
        b.field = [...tally.entries()].sort((p, q) => q[1] - p[1])[0][0];
        b.idx.forEach((i, k) => { slabWb[ii] = i; slabBin[ii] = bi; aBuf[ii * 4] = b.X; aBuf[ii * 4 + 1] = b.Z; aBuf[ii * 4 + 2] = k * SLAB; aBuf[ii * 4 + 3] = SLAB; dBuf[ii] = b.delay; ii++; });
      });
      const cols = new R.Inst(window.NPGL.hexPrism(), n);
      cols.setA(aBuf); cols.setD(dBuf);
      // tallest column of each field, for labels
      const fieldTop = new Map();
      for (const b of bins) { const t = fieldTop.get(b.field); if (!t || b.h > t.h) fieldTop.set(b.field, b); }
      const fieldByName = new Map(D.fields.map((f, i) => [f.n, i]));

      // ---- colours
      const st = { mode: "plain", minLen: D.defaults.minLen, radius: D.defaults.radiusKm, focus: null, hover: -1 };
      const cur = new Float32Array(n * 4), from = new Float32Array(n * 4), tgt = new Float32Array(n * 4);
      let colT0 = -1; const COLDUR = 520;
      const slabColor = (i) => {
        if (st.mode === "log") return [F.none, F.fail, F.pass][classOf(i, st.minLen, st.radius)];
        if (st.mode === "fm") return [F.none, F.fail, F.thin, F.pass][wb.m[i]];
        return F.plain;
      };
      const focusOn = () => st.focus != null || st.hover >= 0;
      const inFocus = (f) => (st.hover >= 0 ? f === st.hover : st.focus ? st.focus.has(f) : true);
      function retarget(instant) {
        for (let k = 0; k < n; k++) {
          const i = slabWb[k], col = slabColor(i), o = k * 4;
          // a faint brightness step from slab to slab makes single wellbores readable in close-ups
          const v = 0.9 + 0.1 * ((k - bins[slabBin[k]].i0) % 2);
          tgt[o] = col[0] * v; tgt[o + 1] = col[1] * v; tgt[o + 2] = col[2] * v; tgt[o + 3] = inFocus(wb.f[i]) ? 1 : 0;
        }
        if (instant || reduce) { cur.set(tgt); cols.setC(cur); colT0 = -1; } else { from.set(cur); colT0 = performance.now(); }
        for (const b of bins) { // glow colour = mean colour of the column
          let r = 0, g = 0, bl = 0, w = 0;
          for (let k = b.i0; k < b.i0 + b.h; k++) { r += tgt[k * 4]; g += tgt[k * 4 + 1]; bl += tgt[k * 4 + 2]; w += tgt[k * 4 + 3]; }
          b.glow = [r / b.h, g / b.h, bl / b.h, w / b.h];
        }
        // the discs of the control wells follow the length threshold
        for (let k = 0; k < ctlA.length; k++) { const col = ctlA[k].len >= st.minLen ? F.pass : F.fail; dc[k * 4] = col[0]; dc[k * 4 + 1] = col[1]; dc[k * 4 + 2] = col[2]; dc[k * 4 + 3] = 1; }
        discs.setC(dc); rings.setC(dc);
      }
      function counts() {
        const log = [0, 0, 0], fm = [0, 0, 0, 0];
        for (let i = 0; i < n; i++) { log[classOf(i, st.minLen, st.radius)]++; fm[wb.m[i]]++; }
        return { log, fm };
      }

      // ---- control wells that could be assessed: a disc for their reach and a dot
      const ctlA = D.ctl.filter((q) => q.a && q.x != null);
      const dc = new Float32Array(ctlA.length * 4), da = new Float32Array(ctlA.length * 4);
      ctlA.forEach((q, k) => { da[k * 4] = q.x; da[k * 4 + 1] = -q.y; da[k * 4 + 2] = 0.06; da[k * 4 + 3] = 0; });
      const discs = new R.Inst(window.NPGL.disc(72), ctlA.length);
      discs.setA(da); discs.setD(new Float32Array(ctlA.length));
      const loop = new R.Geo(); for (let k = 0; k < 96; k++) { const a = (2 * PI * k) / 96; loop.v([Math.cos(a), 0, Math.sin(a)], [0, 1, 0], [1, 1, 1, 1]); }
      const rings = new R.Inst(loop, ctlA.length, true);
      rings.setA(da); rings.setD(new Float32Array(ctlA.length));
      const dots = new R.Bills(ctlA.length);
      ctlA.forEach((q, k) => { dots.pos.set([q.x, 0.5, -q.y, 1.5], k * 4); dots.col.set([F.ctl[0], F.ctl[1], F.ctl[2], 1], k * 4); });
      dots.upload();
      const glows = new R.Bills(bins.length);

      // ---- beams over the fields named in Havtil's report
      const beams = D.useFields.filter((u) => u.left > 0).map((u) => {
        const b = fieldTop.get(u.i), g = new R.Geo();
        g.tube({ r0: 0, r1: 9, y0: 0, y1: 210, seg: 32, cx: b.X, cz: b.Z, col: shade(F.pass, 1.15, 0.42), colB: shade(F.pass, 1.15, 0), top: false, bottom: false });
        return { u, b, mesh: new R.Mesh(g), a: 0, to: 0 };
      });

      // ---- labels above the tallest column of a field
      const fieldLabels = new Map();
      function label(name, html) {
        const fi = fieldByName.get(name), b = fieldTop.get(fi);
        if (!b) return null;
        if (!fieldLabels.has(name)) { const L0 = addLabel("map", "ct tag", "", [b.X, 0, b.Z]); L0.yield = true; L0.dyn = () => [b.X, (b.h * SLAB + 3.5) * an.ys, b.Z]; fieldLabels.set(name, L0); }
        const L = fieldLabels.get(name); setText(L, html || name); return L;
      }
      function showLabels(list) { // list of [name, html]
        const keep = new Set();
        list.forEach(([name, html], k) => { const L = label(name, html); if (L) { L.on = true; L.pri = k; keep.add(L); } });
        for (const L of fieldLabels.values()) if (!keep.has(L)) L.on = false;
      }

      const an = { ys: 1, dim: 1, reveal: 99, revealT0: -1, discs: 0, discsTo: 0, radius: st.radius, co2: 0, co2To: 0, glow: 1, glowTo: 1 };
      const growth = (b, T) => easeOut(clamp((T - b.delay) / 0.9, 0, 1));

      function update(now, dt, camDist) {
        an.ys += (clamp(camDist / 400, 1, 2.4) - an.ys) * Math.min(1, dt / 260);
        if (an.revealT0 >= 0) { an.reveal = (now - an.revealT0) / 1000; if (an.reveal > 4) { an.reveal = 99; an.revealT0 = -1; } }
        if (colT0 >= 0) {
          const t = clamp((now - colT0) / COLDUR, 0, 1), e = ease(t);
          for (let k = 0; k < n * 4; k++) cur[k] = from[k] + (tgt[k] - from[k]) * e;
          cols.setC(cur); if (t >= 1) colT0 = -1;
        }
        const k = Math.min(1, dt / 220);
        an.dim += ((focusOn() ? 0.22 : 1) - an.dim) * k; an.discs += (an.discsTo - an.discs) * k; an.co2 += (an.co2To - an.co2) * k; an.glow += (an.glowTo - an.glow) * k;
        an.radius += (st.radius - an.radius) * Math.min(1, dt / 120);
        for (const b of beams) b.a += (b.to - b.a) * k;
        const dim = focusOn();
        bins.forEach((b, bi) => {
          const g = growth(b, an.reveal), o = bi * 4, w = dim ? 0.25 + 0.75 * b.glow[3] : 1;
          glows.pos[o] = b.X; glows.pos[o + 1] = b.h * SLAB * g * an.ys + 0.5; glows.pos[o + 2] = b.Z; glows.pos[o + 3] = 5.5 + 1.5 * Math.sqrt(b.h);
          glows.col[o] = b.glow[0]; glows.col[o + 1] = b.glow[1]; glows.col[o + 2] = b.glow[2]; glows.col[o + 3] = 0.3 * g * w * an.glow;
        });
        glows.upload();
      }

      function draw(camT) {
        const fog = [F.bg[0], F.bg[1], F.bg[2], 1 / 2400];
        R.depthWrite(false); R.blend("alpha");
        R.use("tex", { uSea: F.sea.slice(0, 3), uFog: fog, uSpot: [camT[0], camT[2], 520, 0.55], uAlpha: 1 });
        ground.draw();
        R.use("line", { uFog: fog, uAlpha: 1 }); lines.draw();
        if (an.co2 > 0.01) { R.use("line", { uFog: fog, uAlpha: an.co2 }); co2Lines.draw(); }
        if (an.discs > 0.01) {
          const u = { uLight: light, uFog: fog, uR: an.radius, uT: 99, uYS: 1, uGap: 1, uFlat: 1, uDim: 1, uEmis: 0 };
          R.use("inst", Object.assign({ uAlpha: 0.16 * an.discs }, u)); discs.draw();
          R.use("inst", Object.assign({ uAlpha: 0.9 * an.discs }, u)); rings.draw();
        }
        R.depthWrite(true);
        R.use("inst", { uLight: light, uFog: fog, uR: S * 0.86, uT: an.reveal, uYS: an.ys, uGap: 0.84, uFlat: 0, uDim: an.dim, uEmis: 0.12, uAlpha: 1 });
        cols.draw();
        R.depthWrite(false);
        if (an.discs > 0.01) { R.use("bill", { uAlpha: an.discs, uSoft: 0.5 }); dots.draw(); }
        R.blend("add");
        for (const b of beams) if (b.a > 0.01) { R.use("mesh", { uLight: light, uFog: fog, uAlpha: b.a, uEmis: 0, uFlat: 1 }); b.mesh.draw(); }
        R.use("bill", { uAlpha: 1, uSoft: 1.6 }); glows.draw();
        R.blend("alpha"); R.depthWrite(true);
      }

      function pickAt(px, py) {
        let best = null, bd = 12;
        for (const b of bins) {
          const g = growth(b, an.reveal); if (g < 0.5) continue;
          const p0 = R.project(b.X, 0, b.Z), p1 = R.project(b.X, b.h * SLAB * g * an.ys, b.Z);
          if (!p0 || !p1) continue;
          const vx = p1[0] - p0[0], vy = p1[1] - p0[1], l2 = vx * vx + vy * vy || 1, t = clamp(((px - p0[0]) * vx + (py - p0[1]) * vy) / l2, 0, 1);
          const d = Math.hypot(px - (p0[0] + vx * t), py - (p0[1] + vy * t)) - 4;
          if (d < bd) { bd = d; best = b; }
        }
        return best;
      }

      retarget(true);
      return {
        st, bins, ctlA, counts, update, draw, pickAt, showLabels, fieldByName, fieldTop,
        mode(m, instant) { if (st.mode !== m) { st.mode = m; retarget(instant); } },
        params(p, instant) { let ch = false; if (p.minLen != null && p.minLen !== st.minLen) { st.minLen = p.minLen; ch = true; } if (p.radius != null && p.radius !== st.radius) { st.radius = p.radius; ch = true; } if (ch) retarget(instant); },
        focus(names) { const s = names && names.length ? new Set(names.map((x) => fieldByName.get(x))) : null; st.focus = s; retarget(false); },
        hover(fi) { if (st.hover !== fi) { st.hover = fi; retarget(false); } },
        reveal(state, now) { if (state === "hidden") { an.reveal = -1; an.revealT0 = -1; } else if (state === "grow" && !reduce) { an.reveal = 0; an.revealT0 = now == null ? performance.now() : now; } else { an.reveal = 99; an.revealT0 = -1; } },
        discs(a) { an.discsTo = a; }, co2(a) { an.co2To = a; }, glow(a) { an.glowTo = a; },
        beams(names) { for (const b of beams) b.to = names && names.includes(b.u.n) ? 1 : 0; },
      };
    })();

    // ================================================================= WELL (the idea)
    // A schematic, not to scale: in a real well the gap behind the casing is a few centimetres wide.
    // The lowest part of the gap is cemented. Above the top of the cement it is open, and that is where
    // the clay moves in: sideways from the wall of the hole, at the depth where the clay lies.
    const well = (() => {
      const RO = 11, RH = 2.35, RC = 1.25, A0 = PI, A1 = 2 * PI, CLAY0 = 11, CLAY1 = 20, TOC = CLAY0, TOPY = 28; // the clay lies directly above the top of the cement
      const slate = hex("#3a4c55"), sand = hex("#b79c5e"), clayCol = hex("#1f9470"), steel = hex("#c3ced2"), cem = hex("#a7afad");
      const g = new R.Geo();
      const layer = (y0, y1, col) => g.tube({ r0: RH, r1: RO, y0, y1, a0: A0, a1: A1, seg: 56, col: shade(col, 0.78), colIn: shade(col, 0.42), colTop: col, colCut: shade(col, 1.12) });
      layer(0, 6, sand); layer(6, CLAY0, slate); layer(CLAY1, TOPY, slate);
      g.tube({ r0: RC, r1: RH, y0: 0.6, y1: TOC, a0: A0, a1: A1, seg: 40, col: shade(cem, 0.8), colTop: shade(cem, 1.05), colCut: cem, inner: false, outer: false });
      g.tube({ r0: RC - 0.22, r1: RC, y0: 0.6, y1: 31.5, seg: 40, col: shade(steel, 0.72), colB: shade(steel, 1.05), colIn: shade(steel, 0.3), colTop: shade(steel, 1.1) });
      const rock = new R.Mesh(g);
      // the fluid that stands in the open part of the gap, shown on the cut plane
      const fl = new R.Geo(), fcol = hex("#6f97a8", 0.3);
      for (const s of [-1, 1]) fl.quad([s * RC, TOC, -0.03], [s * RH, TOC, -0.03], [s * RH, TOPY, -0.03], [s * RC, TOPY, -0.03], [0, 0, 1], fcol);
      const fluid = new R.Mesh(fl);
      // arrows on the clay: the direction it moves in
      const ar = new R.Geo(), acol = hex("#eaf2ee");
      for (const s of [-1, 1]) for (const y of [13.2, 17.8]) {
        const x0 = s * (RH + 3.3), x1 = s * (RH + 1.35), x2 = s * (RH + 0.5), z = 0.06;
        ar.quad([x0, y - 0.09, z], [x1, y - 0.09, z], [x1, y + 0.09, z], [x0, y + 0.09, z], [0, 0, 1], acol);
        const k = ar.v([x1, y - 0.42, z], [0, 0, 1], acol); ar.v([x2, y, z], [0, 0, 1], acol); ar.v([x1, y + 0.42, z], [0, 0, 1], acol);
        ar.i.push(k, k + 1, k + 2);
      }
      const arrows = new R.Mesh(ar);
      const clayMesh = new R.Mesh(new R.Geo(), true);
      // the clay closes over its whole thickness, right down to the cement; only its upper edge tapers off
      const rAt = (u, c) => RH - (RH - RC) * c * smooth(1, 0.86, u);
      function buildClay(c) {
        const q = new R.Geo(), ny = 22, seg = 44, glow = 1 + 0.06 * c;
        const cIn = shade(clayCol, 0.5 * glow), cCut = shade(clayCol, 1.14 * glow);
        for (let j = 0; j < ny; j++) {
          const u0 = j / ny, u1 = (j + 1) / ny, ya = lerp(CLAY0, CLAY1, u0), yb = lerp(CLAY0, CLAY1, u1), ra = rAt(u0, c), rb = rAt(u1, c);
          for (let k = 0; k < seg; k++) {
            const ta = A0 + ((A1 - A0) * k) / seg, tb = A0 + ((A1 - A0) * (k + 1)) / seg, ca = Math.cos(ta), sa = Math.sin(ta), cb = Math.cos(tb), sb = Math.sin(tb);
            const i0 = q.v([ra * ca, ya, ra * sa], [-ca, 0, -sa], cIn); q.v([ra * cb, ya, ra * sb], [-cb, 0, -sb], cIn); q.v([rb * cb, yb, rb * sb], [-cb, 0, -sb], cIn); q.v([rb * ca, yb, rb * sa], [-ca, 0, -sa], cIn);
            q.i.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3);
          }
          q.quad([-ra, ya, 0], [-RO, ya, 0], [-RO, yb, 0], [-rb, yb, 0], [0, 0, 1], cCut);
          q.quad([ra, ya, 0], [RO, ya, 0], [RO, yb, 0], [rb, yb, 0], [0, 0, 1], cCut);
        }
        q.tube({ r0: RH, r1: RO, y0: CLAY0, y1: CLAY1, a0: A0, a1: A1, seg: 56, col: shade(clayCol, 0.8 * glow), colTop: clayCol, inner: false, cuts: false });
        clayMesh.set(q);
      }
      // gas: fine bubbles along the casing through the cement, larger ones in the open gap above it
      const NB = 64, bub = new R.Bills(NB), bubs = [];
      let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
      for (let k = 0; k < NB; k++) bubs.push({ side: k % 2 ? 1 : -1, y: 1.2 + rnd() * 29, v: 2.6 + rnd() * 2.2, r: 0.2 + rnd() * 0.16, ph: rnd() * 6.28 });
      const gasCol = hex("#ffa15e");
      const st = { creep: 0, to: 0, t0: -1, from: 0, now: 0, compact: false };
      const L = {
        over: addLabel("well", "rm cap", "OVERBURDEN", [-RO + 0.6, 24.6, 0.05]),
        clay: addLabel("well", "rm cap", "DUCTILE CLAY", [-RO + 0.6, 15.5, 0.05]),
        res: addLabel("well", "rm cap", "RESERVOIR", [-RO + 0.6, 3, 0.05]),
        cas: addLabel("well", "ct cap", "STEEL CASING", [0, 32, 0]),
        ann: addLabel("well", "rm cap", "← ANNULUS", [RH + 0.5, 24.6, 0.05]),
        cem: addLabel("well", "rm cap", "← CEMENT", [RH + 0.5, 7.5, 0.05]),
        state: addLabel("well", "rm note", "", [RH + 0.7, 15.5, 0.05]),
      };
      for (const k in L) L[k].on = true;
      buildClay(0);

      function update(now, dt) {
        st.now = now;
        if (st.t0 >= 0) {
          const t = clamp((now - st.t0) / (reduce ? 1 : 2600), 0, 1);
          st.creep = lerp(st.from, st.to, ease(t)); if (t >= 1) st.t0 = -1;
          buildClay(st.creep);
        }
        const closed = st.creep > 0.93;
        for (let k = 0; k < NB; k++) {
          const b = bubs[k]; b.y += ((b.v * dt) / 1000) * (b.y < TOC ? 0.55 : 1);
          if ((closed && b.y > CLAY0 - 0.4 && b.y < CLAY1 + 0.5) || b.y > 31) b.y = 1.2 + rnd() * 1.6; // stopped at the clay, or out at the top
          const u = (b.y - CLAY0) / (CLAY1 - CLAY0), moved = u > 0 && u < 1 ? RH - rAt(u, st.creep) : 0, width = RH - RC - moved;
          const open = smooth(TOC, TOC + 1.2, b.y); // 0 inside the cement, 1 in the open gap
          const x = lerp(RC + 0.1, RC + 0.12 + clamp(width - 0.24, 0, 2) * (0.5 + 0.38 * Math.sin(b.ph + b.y * 1.7)), open);
          const o = k * 4;
          bub.pos[o] = b.side * x; bub.pos[o + 1] = b.y; bub.pos[o + 2] = 0.12; bub.pos[o + 3] = lerp(0.11, b.r * (width < 0.3 ? 0.6 : 1), open);
          bub.col[o] = gasCol[0]; bub.col[o + 1] = gasCol[1]; bub.col[o + 2] = gasCol[2]; bub.col[o + 3] = smooth(1.2, 2.2, b.y) * (1 - smooth(29, 31, b.y));
        }
        bub.upload();
        setText(L.state, st.creep > 0.93 ? "<b>Closed by the clay</b><br>The gas stops below it" : st.creep > 0.05 ? "<b>The clay moves in</b><br>from the sides" : "<b>Open behind the casing</b><br>Gas has a way up");
      }
      function draw() {
        const fog = [F.bg[0], F.bg[1], F.bg[2], 0];
        R.use("mesh", { uLight: light, uFog: fog, uAlpha: 1, uEmis: 0, uFlat: 0 }); rock.draw();
        R.use("mesh", { uLight: light, uFog: fog, uAlpha: 1, uEmis: 0.06 + 0.1 * st.creep, uFlat: 0 }); clayMesh.draw();
        R.depthWrite(false);
        R.use("mesh", { uLight: light, uFog: fog, uAlpha: 1, uEmis: 0, uFlat: 1 }); fluid.draw();
        const aa = (reduce ? 0.85 : 0.62 + 0.3 * Math.sin(st.now / 420)) * (1 - smooth(0.4, 0.9, st.creep));
        if (aa > 0.01) { R.use("mesh", { uLight: light, uFog: fog, uAlpha: aa, uEmis: 0, uFlat: 1 }); arrows.draw(); }
        R.blend("add");
        R.use("bill", { uAlpha: 0.95, uSoft: 0.9 }); bub.draw();
        R.blend("alpha"); R.depthWrite(true);
      }
      return {
        st, update, draw,
        creep(to, instant) { st.to = to; if (instant || reduce) { st.creep = to; st.t0 = -1; buildClay(to); } else { st.from = st.creep; st.t0 = performance.now(); } },
        setCreep(v) { st.t0 = -1; st.to = v; st.creep = v; buildClay(v); },
        /** On a narrow screen only the names of the layers and the casing are shown. */
        compact(on) { st.compact = !!on; L.state.on = L.ann.on = L.cem.on = !on; setText(L.clay, on ? "CLAY" : "DUCTILE CLAY"); },
      };
    })();

    // ================================================================= LOGS (Fram and Visund, same depth scale)
    const logs = (() => {
      const RCORE = 20, RB = 1.3, U = 10; // one unit is 10 m
      const GC = { Nordland: "#2d3f47", Hordaland: "#28483f", Rogaland: "#32584c", Shetland: "#3d4556" };
      // name, position, and the side its notes go on: Fram to the left, Visund to the right, group names between the two
      const wellsDef = [["fram", -85, -1], ["visund", 85, 1]];
      const W = {};
      for (const [key, x0, side] of wellsDef) {
        const d = D.wells[key], bottom = d.ztop + 200, g = new R.Geo(), tr = new R.Geo(), cg = new R.Geo();
        const seabed = d.groups[0][1], sea = -d.kb / U; // depths are measured from the rig floor, which stands above the sea
        for (const [name, top, base] of d.groups) {
          if (top >= bottom) break;
          const y0 = -Math.min(base, bottom) / U, y1 = -top / U;
          // above the reservoir top the column is coloured by group; from the reservoir top down it is sand-coloured
          const parts = top < d.ztop && base > d.ztop ? [[-d.ztop / U, y1, GC[name] || "#434a5a"], [y0, -d.ztop / U, "#a98f57"]] : [[y0, y1, top >= d.ztop ? "#a98f57" : GC[name] || "#434a5a"]];
          for (const [a, b, colHex] of parts) {
            const col = hex(colHex);
            g.tube({ r0: RB * 1.25, r1: RCORE, y0: a, y1: b, a0: PI, a1: 2 * PI, seg: 40, cx: x0, col: shade(col, 0.9), colIn: shade(col, 0.5), colTop: shade(col, 1.25), colCut: shade(col, 1.45) });
          }
        }
        const steel = hex("#aeb9bd");
        g.tube({ r0: 0, r1: RB, y0: -bottom / U, y1: 0, seg: 20, cx: x0, col: shade(steel, 0.7), colB: shade(steel, 1.05) });
        // every run with the clay signature: a pale sleeve around the well
        const pale = hex("#7fb39f");
        for (const [top, base] of d.clay) cg.tube({ r0: RB, r1: 3.6, y0: -base / U, y1: -top / U, seg: 24, cx: x0, col: shade(pale, 0.8), colTop: pale });
        // sea surface and reservoir top
        tr.tube({ r0: 0, r1: RCORE, y0: sea - 0.3, y1: sea, seg: 48, cx: x0, col: hex("#4f8fb0", 0.3), bottom: false });
        tr.tube({ r0: RB * 1.25, r1: RCORE, y0: -seabed / U, y1: sea - 0.3, a0: PI, a1: 2 * PI, seg: 40, cx: x0, col: hex("#3f7fa6", 0.13), top: false, bottom: false, inner: false });
        tr.tube({ r0: 0, r1: RCORE + 3, y0: -d.ztop / U - 0.4, y1: -d.ztop / U, seg: 48, cx: x0, col: hex("#e0b862", 0.5), bottom: false });
        const w = { key, x0, d, bottom, seabed, stat: new R.Mesh(g), clayMesh: new R.Mesh(cg), trans: new R.Mesh(tr), best: new R.Mesh(new R.Geo(), true), win: new R.Mesh(new R.Geo(), true), k: d.i0, lab: {} };
        const lx = x0 + side * (RCORE + 5), gx = x0 - side * (RCORE + 4), A = side < 0 ? "l" : "r", G = side < 0 ? "r" : "l";
        w.lab.name = addLabel("logs", "ct tag", "<b>" + d.name + "</b> " + d.field, [x0, 9, 0]);
        w.lab.sea = addLabel("logs", G + "m dim", "SEA LEVEL", [gx, sea, 0]);
        if (key === "fram") { // one scale bar serves both wells: they are drawn to the same depth scale
          const bx = x0 - RCORE - 14, mk = new R.Geo(), mc = hex("#b9c8c1");
          mk.box(bx - 0.3, -50, -0.3, bx + 0.3, 0, 0.3, mc); mk.box(bx - 2.4, -0.3, -0.3, bx + 2.4, 0.3, 0.3, mc); mk.box(bx - 2.4, -50.3, -0.3, bx + 2.4, -49.7, 0.3, mc);
          w.marks = new R.Mesh(mk); w.lab.scale = addLabel("logs", "lm dim", "500 m", [bx - 1.5, -25, 0]);
        }
        w.lab.groups = d.groups.filter((q) => q[1] < d.ztop && Math.min(q[2], d.ztop) - q[1] >= 150).map((q) => addLabel("logs", G + "m dim", q[0].toUpperCase(), [gx, -(q[1] + Math.min(q[2], d.ztop)) / 2 / U, 0]));
        w.lab.clay = addLabel("logs", A + "m note", "<b>" + fmt(d.clayM) + " m</b> with the<br>clay signature", [lx, -(d.clay[0][0] + d.clay[d.clay.length - 1][1]) / 2 / U, 0]);
        w.lab.holds = addLabel("logs", A + "t note", "", [lx, 0, 0]);
        w.lab.best = addLabel("logs", A + "b note good", "", [lx, 0, 0]);
        w.lab.res = addLabel("logs", A + "b note sand", "<b>" + d.zone + "</b><br>reservoir top,<br>" + fmt(d.ztop) + " m", [lx, -d.ztop / U, 0]);
        W[key] = w;
      }
      const st = { mode: "contrast", step: 4, compact: false };
      function result(key) {
        const w = W[key], s = w.d.sweep, k = w.k;
        return { pp: s.pp[k], zmin: s.zmin[k], len: s.len[k], top: s.top[k], base: s.base[k], pass: s.len[k] >= D.defaults.minLen, isDefault: k === w.d.i0 };
      }
      function rebuild(key) {
        const w = W[key], r = result(key), g = new R.Geo(), t = new R.Geo(), x0 = w.x0;
        const good = hex("#3fe6ac"), bad = hex("#f0703a");
        if (r.top != null && r.len > 0) g.tube({ r0: RB, r1: 5.2, y0: -r.base / U, y1: -r.top / U, seg: 28, cx: x0, col: r.pass ? good : shade(bad, 0.95), colTop: r.pass ? good : bad });
        if (r.zmin != null) {
          const y = -r.zmin / U, wc = r.pass ? good : hex("#e9f2ee");
          t.tube({ r0: 0, r1: RCORE + 3, y0: y - 0.5, y1: y, seg: 48, cx: x0, col: shade(wc, 1, 0.55), bottom: false });
          // the window where the rock is strong enough: from that depth down to the reservoir top
          t.tube({ r0: RCORE + 2.4, r1: RCORE + 3, y0: -w.d.ztop / U, y1: y, seg: 48, a0: PI, a1: 2 * PI, cx: x0, col: shade(wc, 1, 0.3), top: false, bottom: false, cuts: false });
        }
        w.best.set(g); w.win.set(t);
        w.lab.holds.pos[1] = r.zmin == null ? 0 : -r.zmin / U;
        setText(w.lab.holds, r.zmin == null ? "" : "Rock holds the<br>pressure from<br><b>" + fmt(Math.round(r.zmin)) + " m</b>");
        if (r.top != null && r.len > 0) w.lab.best.pos[1] = -(r.top + Math.min(r.base, r.top + 60)) / 2 / U;
        setText(w.lab.best, r.len > 0 ? "<b>" + r.len + " m</b> of clay<br>in one piece" : "");
        w.lab.best.el.classList.toggle("good", r.pass); w.lab.best.el.classList.toggle("bad", !r.pass);
        apply();
      }
      function apply() {
        for (const key in W) {
          const w = W[key], r = result(key), vis = st.mode === "contrast" || key === "fram", s = st.mode === "contrast" ? 4 : st.step;
          w.vis = vis;
          const notes = vis && !st.compact;
          w.lab.name.on = vis; w.lab.sea.on = vis && key === "fram"; if (w.lab.scale) w.lab.scale.on = vis; w.lab.groups.forEach((L) => { L.on = vis && !(st.compact && key === "visund"); });
          w.lab.res.on = notes && s >= 2;
          w.lab.holds.on = notes && s >= 2 && r.zmin != null;
          w.lab.best.on = notes && s >= 3 && r.len > 0;
          // in the contrast view the clay total is shown where no interval qualifies
          w.lab.clay.on = notes && (st.mode === "contrast" ? r.len === 0 : s === 1);
          w.showWin = s >= 2; w.showBest = s >= 3; w.showClay = s >= 1;
        }
      }
      function draw() {
        const fog = [F.bg[0], F.bg[1], F.bg[2], 0];
        for (const key in W) { const w = W[key]; if (!w.vis) continue; R.use("mesh", { uLight: light, uFog: fog, uAlpha: 1, uEmis: 0.04, uFlat: 0 }); w.stat.draw(); if (w.showClay) w.clayMesh.draw(); if (w.marks) { R.use("mesh", { uLight: light, uFog: fog, uAlpha: 1, uEmis: 0, uFlat: 1 }); w.marks.draw(); } }
        for (const key in W) { const w = W[key]; if (!w.vis || !w.showBest) continue; R.use("mesh", { uLight: light, uFog: fog, uAlpha: 1, uEmis: 0.55, uFlat: 0 }); w.best.draw(); }
        R.depthWrite(false);
        for (const key in W) {
          const w = W[key]; if (!w.vis) continue;
          R.use("mesh", { uLight: light, uFog: fog, uAlpha: 1, uEmis: 0.3, uFlat: 1 }); w.trans.draw();
          if (w.showWin) { R.use("mesh", { uLight: light, uFog: fog, uAlpha: 1, uEmis: 0.3, uFlat: 1 }); w.win.draw(); }
        }
        R.depthWrite(true);
      }
      rebuild("fram"); rebuild("visund");
      return {
        st, W, draw, result, update() {},
        view(mode, step) { st.mode = mode; st.step = step == null ? 4 : step; apply(); },
        compact(on) { st.compact = !!on; apply(); },
        /** Move the reservoir pressure of one well by a number of 0.01 steps from where it is, or pass null to reset. */
        setK(key, k) { const w = W[key]; w.k = k == null ? w.d.i0 : clamp(k, 0, w.d.sweep.pp.length - 1); rebuild(key); return result(key); },
        range(key) { const w = W[key]; return { n: w.d.sweep.pp.length, i0: w.d.i0, k: w.k }; },
      };
    })();

    // ================================================================= camera, loop, input
    const sets = { map, well, logs };
    const NEAR = { map: [6, 16000], well: [0.5, 600], logs: [8, 5000] };
    let cur = "map";
    const cam = { t: [0, 0, 0], az: 0, el: 0.6, dist: 900, fov: 34 * RAD, sx: 0, sy: 0 };
    let fromCam = null, toCam = null, t0 = 0, dur = 0, drift = 0, swapTimer = 0, lastInput = -1e9, stFx = 1, stFy = 1;
    const user = { az: 0, el: 0, zoom: 1 };
    const KEYS = ["az", "el", "dist", "sx", "sy"];
    const copyCam = (c) => ({ t: c.t.slice(), az: c.az, el: c.el, dist: c.dist, fov: c.fov, sx: c.sx, sy: c.sy });
    const setCam = (c) => { cam.t = c.t.slice(); for (const k of KEYS) cam[k] = c[k]; cam.fov = c.fov; };
    function bake() { cam.az += user.az; cam.el = clamp(cam.el + user.el, 0.03, 1.5); cam.dist *= user.zoom; user.az = 0; user.el = 0; user.zoom = 1; }
    function fly(target, ms) {
      bake(); fromCam = copyCam(cam); toCam = target;
      // turn the short way round
      while (toCam.az - fromCam.az > PI) fromCam.az += 2 * PI;
      while (fromCam.az - toCam.az > PI) fromCam.az -= 2 * PI;
      t0 = performance.now(); dur = reduce ? 1 : ms;
    }
    function resolve(s) {
      const t = s.ll ? (() => { const p = km(s.ll[0], s.ll[1]); return [p[0], s.y || 0, -p[1]]; })() : s.t.slice();
      return { t, az: (s.az || 0) * RAD, el: (s.el == null ? 35 : s.el) * RAD, dist: s.dist, fov: 34 * RAD, sx: s.sx || 0, sy: s.sy || 0 };
    }
    /** Move to a shot: { set, t | ll, az, el, dist, sx, sy, drift, dur }. Angles in degrees; drift is a slow sway. */
    function shot(s, instant) {
      const target = resolve(s);
      drift = reduce ? 0 : (s.drift || 0) * RAD;
      clearTimeout(swapTimer);
      if (instant) { cur = s.set; bake(); setCam(target); fromCam = toCam = null; wrap.classList.remove("dip"); return; }
      if (s.set !== cur) {
        wrap.classList.add("dip");
        fly(Object.assign(copyCam(cam), { dist: cam.dist * 0.8 }), 300);
        swapTimer = setTimeout(() => {
          cur = s.set; setCam(target); cam.dist = target.dist * 1.22; user.az = user.el = 0; user.zoom = 1;
          fly(target, 1300); wrap.classList.remove("dip");
        }, reduce ? 0 : 300);
      } else { wrap.classList.remove("dip"); fly(target, s.dur || 1600); }
    }

    let hoverCb = null, frameCb = null, interactive = true, last = performance.now(), running = true;
    function frame(now) {
      if (!running) return;
      requestAnimationFrame(frame);
      const dt = Math.min(60, now - last); last = now;
      if (toCam) {
        const t = clamp((now - t0) / dur, 0, 1), e = ease(t);
        for (const k of KEYS) cam[k] = lerp(fromCam[k], toCam[k], e);
        for (let k = 0; k < 3; k++) cam.t[k] = lerp(fromCam.t[k], toCam.t[k], e);
        if (t >= 1) { toCam = fromCam = null; }
      }
      const idle = now - lastInput > 5000;
      const dz = idle && drift ? drift * Math.sin(now / 5200) : 0;
      // The picture inside the stage rectangle is the same whatever the shape of the window.
      const eff = { t: cam.t, az: cam.az + user.az + dz, el: clamp(cam.el + user.el, 0.03, 1.52), dist: cam.dist * user.zoom, fov: 2 * Math.atan(Math.tan(cam.fov / 2) / stFy), sx: cam.sx * stFx, sy: cam.sy * stFy, near: NEAR[cur][0], far: NEAR[cur][1] };
      const S_ = sets[cur];
      S_.update(now, dt, eff.dist);
      R.begin(eff, F.bg);
      S_.draw(cam.t);
      const placed = [];
      for (const L of labels.slice().sort((a, b) => (a.pri || 0) - (b.pri || 0))) {
        const want = L.on && L.set === cur;
        const q = want && L.dyn ? L.dyn() : L.pos;
        let p = want ? R.project(q[0], q[1], q[2]) : null;
        if (p && (p[0] < -200 || p[0] > R.view.w + 200 || p[1] < -100 || p[1] > R.view.h + 100)) p = null;
        if (p && L.yield) {
          if (!L.w) { const r = L.inner.getBoundingClientRect(); L.w = r.width || 1; L.h = r.height; }
          const box = [p[0] - L.w / 2 - 4, p[1] - L.h * 1.45 - 4, p[0] + L.w / 2 + 4, p[1] + 4];
          if (placed.some((o) => box[0] < o[2] && box[2] > o[0] && box[1] < o[3] && box[3] > o[1])) p = null; else placed.push(box);
        }
        if (p) L.el.style.transform = "translate(" + p[0].toFixed(1) + "px," + p[1].toFixed(1) + "px)";
        if (!!p !== L.shown) { L.shown = !!p; L.el.classList.toggle("on", !!p); }
      }
      if (frameCb) frameCb(now);
    }

    // ---- pointer: drag to look around, wheel to zoom, double click to reset, hover a column for its field
    let drag = null;
    canvas.addEventListener("pointerdown", (e) => { if (!interactive) return; drag = { x: e.clientX, y: e.clientY, az: user.az, el: user.el }; lastInput = performance.now(); try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ } });
    canvas.addEventListener("pointermove", (e) => {
      if (!interactive) return;
      if (drag) {
        user.az = drag.az - (e.clientX - drag.x) * 0.005; user.el = drag.el + (e.clientY - drag.y) * 0.004; lastInput = performance.now();
        if (hoverCb) hoverCb(null); map.hover(-1);
      } else if (cur === "map" && hoverCb) {
        const r = canvas.getBoundingClientRect(), b = map.pickAt(e.clientX - r.left, e.clientY - r.top);
        map.hover(b && b.field >= 0 ? b.field : -1);
        hoverCb(b ? { field: b.field, x: e.clientX, y: e.clientY } : null);
      }
    });
    const endDrag = () => { drag = null; };
    canvas.addEventListener("pointerup", endDrag); canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("pointerleave", () => { if (!drag) { map.hover(-1); if (hoverCb) hoverCb(null); } });
    canvas.addEventListener("wheel", (e) => { if (!interactive) return; e.preventDefault(); user.zoom = clamp(user.zoom * Math.exp(e.deltaY * 0.0012), 0.35, 2.4); lastInput = performance.now(); }, { passive: false });
    canvas.addEventListener("dblclick", () => { resetView(); });
    function resetView() { const tgt = toCam || copyCam(cam); fromCam = Object.assign(copyCam(cam), { az: cam.az + user.az, el: clamp(cam.el + user.el, 0.03, 1.5), dist: cam.dist * user.zoom }); user.az = user.el = 0; user.zoom = 1; toCam = tgt; t0 = performance.now(); dur = reduce ? 1 : 600; lastInput = -1e9; }
    canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); running = false; wrap.classList.add("lost"); });
    canvas.addEventListener("webglcontextrestored", () => { window.location.reload(); });

    requestAnimationFrame(frame);
    return {
      map, well, logs, shot, resetView, km,
      get set() { return cur; },
      onHover(cb) { hoverCb = cb; }, onFrame(cb) { frameCb = cb; },
      interactive(on) { interactive = on; canvas.style.pointerEvents = on ? "auto" : "none"; },
      /** Share of the window the 16:9 stage covers, across and down. */
      stage(fx, fy) { stFx = fx; stFy = fy; },
    };
  }

  window.NPWorld = { create, COL };
})();
