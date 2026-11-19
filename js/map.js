// Canvas map: land, quadrants, field outlines, wellbores left to plug, control wells, formation-level wells.
// No tiles and no libraries, so it works offline.
import { clamp, cssVars, reducedMotion, title } from "./util.js";

const D2R = Math.PI / 180;
const my = (lat) => (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));
export const REGIONS = { north: [1.2, 55.9, 6.4, 62.4], norw: [1.5, 62.2, 13.5, 68.3], barents: [14.5, 70.3, 33.5, 74.7], all: [-0.5, 55.4, 33.5, 74.9] };

const ring = (pts) => {
  const a = new Float32Array(pts.length * 2);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  pts.forEach(([lon, lat], i) => {
    const y = my(lat);
    a[2 * i] = lon; a[2 * i + 1] = y;
    if (lon < x0) x0 = lon; if (lon > x1) x1 = lon; if (y < y0) y0 = y; if (y > y1) y1 = y;
  });
  return { a, x0, y0, x1, y1 };
};

export function createMap(canvas, data, on) {
  const ctx = canvas.getContext("2d");
  const view = { cx: 3.4, cy: my(59.4), k: 60 };
  const show = { l1: false, co2: false, quads: true };
  let W = 0, H = 0, dpr = 1, result = null, level = "log", sel = null, hover = null, col = {}, raf = 0, anim = 0;

  // ---- geometry in map units (x = longitude in degrees, y = Mercator latitude in the same units)
  const land = data.geo.land.map(ring);
  const co2 = data.geo.co2.map((c) => ({ name: c.name, operator: c.operator, rings: c.rings.map(ring) }));
  const quads = data.geo.quadrants.map(([name, w, s, e, n]) => ({ name, x0: w, y0: my(s), x1: e, y1: my(n) }));
  const fields = data.fieldGeo.map((f) => {
    const rings = f.rings.map(ring);
    return {
      name: f.name, left: f.left, wi: data.fieldIdx.has(f.name) ? data.fieldIdx.get(f.name) : -1, rings,
      x: f.c[0], y: my(f.c[1]), x0: f.bbox[0], y0: my(f.bbox[1]), x1: f.bbox[2], y1: my(f.bbox[3]),
    };
  });
  const P = (lat, lon) => ({ x: Float32Array.from(lon), y: Float32Array.from(lat, my) });
  const wb = P(data.wb.lat, data.wb.lon);
  const ctl = P(data.controls.map((c) => c.lat ?? 0), data.controls.map((c) => c.lon ?? 0));
  const l1 = P(data.layer1.map((w) => w.la), data.layer1.map((w) => w.lo));

  const sx = (x) => (x - view.cx) * view.k + W / 2;
  const sy = (y) => (view.cy - y) * view.k + H / 2;
  const wx = (px) => view.cx + (px - W / 2) / view.k;
  const wy = (py) => view.cy - (py - H / 2) / view.k;

  function theme() {
    col = cssVars(["sea", "land", "land-line", "grid", "field", "pass", "fail", "thin", "none", "panel", "ink", "ink-2", "muted", "accent"]);
    render();
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    dpr = Math.min(2.5, window.devicePixelRatio || 1);
    W = r.width; H = r.height;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    render();
  }

  const render = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };

  // ---- class helpers
  const wbClass = (i) => (result ? (level === "log" ? result.cls[i] : result.cls1[i]) : 0);
  const classColor = (c) => (level === "log" ? [col.none, col.fail, col.pass][c] : [col.none, col.fail, col.thin, col.pass][c]);
  const ctlColor = (i) => (!result || !result.ctl[i].assessed ? null : result.ctl[i].cls === 2 ? col.pass : col.fail);
  const l1Color = (i) => (!result || !result.l1[i].assessed ? null : [col.none, col.fail, col.thin, col.pass][result.l1[i].cls]);
  const rWb = () => clamp(view.k / 40, 2.1, 4.6);
  const rCtl = () => clamp(view.k / 30, 3.6, 8.5);

  function path(r) {
    const a = r.a;
    ctx.moveTo(sx(a[0]), sy(a[1]));
    for (let i = 2; i < a.length; i += 2) ctx.lineTo(sx(a[i]), sy(a[i + 1]));
    ctx.closePath();
  }

  function draw() {
    if (!W) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = col.sea; ctx.fillRect(0, 0, W, H);
    const X0 = wx(0), X1 = wx(W), Y1 = wy(0), Y0 = wy(H);
    const vis = (o) => o.x1 >= X0 && o.x0 <= X1 && o.y1 >= Y0 && o.y0 <= Y1;

    // quadrant grid
    if (show.quads && view.k >= 14) {
      ctx.strokeStyle = col.grid; ctx.lineWidth = 1; ctx.beginPath();
      for (const q of quads) if (vis(q)) ctx.rect(sx(q.x0), sy(q.y1), (q.x1 - q.x0) * view.k, (q.y1 - q.y0) * view.k);
      ctx.stroke();
      if (view.k >= 52) {
        ctx.fillStyle = col.muted; ctx.globalAlpha = 0.55; ctx.font = "10px ui-monospace, Menlo, monospace"; ctx.textAlign = "left"; ctx.textBaseline = "top";
        for (const q of quads) if (vis(q)) ctx.fillText(q.name, sx(q.x0) + 4, sy(q.y1) + 3);
        ctx.globalAlpha = 1;
      }
    }

    // land
    ctx.fillStyle = col.land; ctx.strokeStyle = col["land-line"]; ctx.lineWidth = 1; ctx.beginPath();
    for (const r of land) if (vis(r)) path(r);
    ctx.fill(); ctx.stroke();

    // CO2 storage licences
    if (show.co2) {
      ctx.strokeStyle = col.accent; ctx.lineWidth = 1.4; ctx.setLineDash([5, 4]); ctx.beginPath();
      for (const c of co2) for (const r of c.rings) if (vis(r)) path(r);
      ctx.stroke(); ctx.setLineDash([]);
    }

    // field outlines, tinted by the largest class among their wellbores
    for (const f of fields) {
      if (!vis(f) || !f.rings.length) continue;
      ctx.beginPath(); for (const r of f.rings) path(r);
      let tint = null;
      if (result && f.wi >= 0) {
        const F = result.fields[f.wi], a = level === "log" ? F.log : F.fm;
        let best = 0; for (let c = 1; c < a.length; c++) if (a[c] > a[best]) best = c;
        if (a[best] > 0) tint = classColor(best);
      }
      if (tint) { ctx.fillStyle = tint; ctx.globalAlpha = 0.16; ctx.fill(); ctx.globalAlpha = 1; }
      ctx.strokeStyle = col.field; ctx.lineWidth = f.left ? 1 : 0.6; ctx.stroke();
    }
    if (sel && sel.type === "field") {
      const f = fields[sel.i];
      if (f) { ctx.beginPath(); for (const r of f.rings) path(r); ctx.strokeStyle = col.ink; ctx.lineWidth = 2; ctx.stroke(); }
    }

    // formation-level wells
    if (show.l1) {
      const s = clamp(view.k / 60, 2.2, 4.2);
      for (let pass = 0; pass < 2; pass++) {
        for (let i = 0; i < l1.x.length; i++) {
          const x = sx(l1.x[i]), y = sy(l1.y[i]);
          if (x < -9 || x > W + 9 || y < -9 || y > H + 9) continue;
          const c = l1Color(i);
          if (pass === 0 && !c && view.k >= 170) { ctx.strokeStyle = col.none; ctx.lineWidth = 0.8; ctx.strokeRect(x - s * 0.8, y - s * 0.8, 1.6 * s, 1.6 * s); }
          if (pass === 1 && c) { ctx.fillStyle = c; ctx.fillRect(x - s, y - s, 2 * s, 2 * s); ctx.strokeStyle = col.panel; ctx.lineWidth = 1; ctx.strokeRect(x - s, y - s, 2 * s, 2 * s); }
        }
      }
    }

    // wellbores left to plug: grey first, colours on top
    const r = rWb(), order = level === "log" ? [0, 1, 2] : [0, 1, 2, 3];
    for (const c of order) {
      ctx.beginPath();
      for (let i = 0; i < wb.x.length; i++) {
        if (wbClass(i) !== c) continue;
        const x = sx(wb.x[i]), y = sy(wb.y[i]);
        if (x < -6 || x > W + 6 || y < -6 || y > H + 6) continue;
        ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 6.2832);
      }
      ctx.fillStyle = classColor(c); ctx.fill();
      if (r >= 3) { ctx.strokeStyle = col.panel; ctx.lineWidth = 0.8; ctx.stroke(); }
    }

    // control wells (open logs): diamonds
    const d = rCtl();
    for (let i = 0; i < ctl.x.length; i++) {
      if (data.controls[i].lat == null) continue;
      const x = sx(ctl.x[i]), y = sy(ctl.y[i]);
      if (x < -12 || x > W + 12 || y < -12 || y > H + 12) continue;
      const cc = ctlColor(i), e = cc ? d : d * 0.72;
      ctx.beginPath(); ctx.moveTo(x, y - e); ctx.lineTo(x + e, y); ctx.lineTo(x, y + e); ctx.lineTo(x - e, y); ctx.closePath();
      if (cc) { ctx.lineWidth = 3.4; ctx.strokeStyle = col.panel; ctx.stroke(); }
      ctx.fillStyle = cc || col.panel; ctx.fill();
      ctx.lineWidth = cc ? 1.2 : 1; ctx.strokeStyle = cc ? col["ink-2"] : col.muted; ctx.stroke();
    }

    // field names
    ctx.font = "600 11px system-ui, -apple-system, 'Segoe UI', sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const max = view.k < 40 ? 9 : view.k < 90 ? 20 : view.k < 220 ? 48 : 300, placed = [];
    const cand = fields.filter((f) => f.left > 0 && f.x >= X0 && f.x <= X1 && f.y >= Y0 && f.y <= Y1).sort((a, b) => b.left - a.left);
    for (const f of cand) {
      if (placed.length >= max) break;
      const t = title(f.name), w = ctx.measureText(t).width + 8, x = sx(f.x), y = sy(f.y) - (view.k < 200 ? 11 : 0);
      const box = [x - w / 2, y - 8, x + w / 2, y + 8];
      if (placed.some((p) => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])) continue;
      placed.push(box);
      ctx.lineWidth = 3.5; ctx.strokeStyle = col.panel; ctx.lineJoin = "round"; ctx.strokeText(t, x, y);
      ctx.fillStyle = col.ink; ctx.fillText(t, x, y);
    }

    // hover and selection rings
    const mark = (o, w, colr) => {
      if (!o || o.type === "field") return;
      const p = o.type === "wb" ? wb : o.type === "ctl" ? ctl : l1, rad = o.type === "ctl" ? d + 5 : o.type === "wb" ? r + 4.5 : 8;
      ctx.beginPath(); ctx.arc(sx(p.x[o.i]), sy(p.y[o.i]), rad, 0, 6.2832);
      ctx.lineWidth = w + 2.2; ctx.strokeStyle = col.panel; ctx.stroke();
      ctx.lineWidth = w; ctx.strokeStyle = colr; ctx.stroke();
    };
    mark(hover, 1.4, col["ink-2"]);
    mark(sel, 2.4, col.ink);
  }

  // ---- hit testing
  function inRing(r, x, y) {
    const a = r.a; let inside = false;
    for (let i = 0, j = a.length - 2; i < a.length; j = i, i += 2) {
      const xi = a[i], yi = a[i + 1], xj = a[j], yj = a[j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function hit(px, py) {
    const near = (p, lim, skip) => {
      let best = -1, bd = lim * lim;
      for (let i = 0; i < p.x.length; i++) {
        if (skip && skip(i)) continue;
        const dx = sx(p.x[i]) - px, dy = sy(p.y[i]) - py, dd = dx * dx + dy * dy;
        if (dd < bd) { bd = dd; best = i; }
      }
      return best;
    };
    let i = near(ctl, rCtl() + 4, (k) => data.controls[k].lat == null);
    if (i >= 0) return { type: "ctl", i };
    i = near(wb, Math.max(6, rWb() + 3));
    if (i >= 0) return { type: "wb", i };
    if (show.l1) { i = near(l1, 7); if (i >= 0) return { type: "l1", i }; }
    const x = wx(px), y = wy(py);
    for (let k = 0; k < fields.length; k++) {
      const f = fields[k];
      if (x < f.x0 || x > f.x1 || y < f.y0 || y > f.y1) continue;
      if (f.rings.some((r) => inRing(r, x, y))) return { type: "field", i: k };
    }
    return null;
  }

  // ---- view changes
  function zoomAt(px, py, f) {
    const X = wx(px), Y = wy(py), k = clamp(view.k * f, 7, 9000);
    view.k = k; view.cx = X - (px - W / 2) / k; view.cy = Y + (py - H / 2) / k;
    render();
  }
  function target(b, pad = 40) {
    const [w, s, e, n] = b, y0 = my(s), y1 = my(n);
    const k = clamp(Math.min((W - 2 * pad) / Math.max(1e-6, e - w), (H - 2 * pad) / Math.max(1e-6, y1 - y0)), 7, 2400);
    return { cx: (w + e) / 2, cy: (y0 + y1) / 2, k };
  }
  function fly(to) {
    cancelAnimationFrame(anim);
    if (reducedMotion() || !W) { Object.assign(view, to); render(); return; }
    const from = { ...view }, t0 = performance.now(), dur = 520;
    const step = (now) => {
      const t = clamp((now - t0) / dur, 0, 1), e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      view.cx = from.cx + (to.cx - from.cx) * e; view.cy = from.cy + (to.cy - from.cy) * e;
      view.k = Math.exp(Math.log(from.k) + (Math.log(to.k) - Math.log(from.k)) * e);
      draw();
      if (t < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  }

  // ---- pointer and keyboard
  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy, moved: false };
    cancelAnimationFrame(anim);
  });
  canvas.addEventListener("pointermove", (e) => {
    const b = canvas.getBoundingClientRect(), px = e.clientX - b.left, py = e.clientY - b.top;
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; canvas.classList.add("is-drag"); }
      if (drag.moved) { view.cx = drag.cx - dx / view.k; view.cy = drag.cy + dy / view.k; on.hover?.(null); render(); }
      return;
    }
    const h = hit(px, py);
    canvas.classList.toggle("is-hit", !!h);
    if ((h && (!hover || h.type !== hover.type || h.i !== hover.i)) || (!h && hover)) { hover = h; render(); }
    on.hover?.(h, px, py);
  });
  const end = (e) => {
    if (!drag) return;
    const moved = drag.moved; drag = null; canvas.classList.remove("is-drag");
    if (moved || e.type === "pointercancel") return;
    const b = canvas.getBoundingClientRect();
    on.select?.(hit(e.clientX - b.left, e.clientY - b.top));
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
  canvas.addEventListener("pointerleave", () => { if (hover) { hover = null; render(); } on.hover?.(null); });
  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const b = canvas.getBoundingClientRect();
    zoomAt(e.clientX - b.left, e.clientY - b.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.012 : 0.0017)));
  }, { passive: false });
  canvas.addEventListener("dblclick", (e) => { const b = canvas.getBoundingClientRect(); zoomAt(e.clientX - b.left, e.clientY - b.top, 1.9); });
  canvas.addEventListener("keydown", (e) => {
    const s = 60 / view.k;
    if (e.key === "ArrowLeft") view.cx -= s; else if (e.key === "ArrowRight") view.cx += s;
    else if (e.key === "ArrowUp") view.cy += s; else if (e.key === "ArrowDown") view.cy -= s;
    else if (e.key === "+" || e.key === "=") return zoomAt(W / 2, H / 2, 1.5);
    else if (e.key === "-") return zoomAt(W / 2, H / 2, 1 / 1.5);
    else return;
    e.preventDefault(); render();
  });
  new ResizeObserver(resize).observe(canvas);

  theme(); resize();
  Object.assign(view, target(REGIONS.north));

  return {
    setResult(r) { result = r; render(); },
    setLevel(l) { level = l; render(); },
    setSelection(s) { sel = s; render(); },
    setShow(key, v) { show[key] = v; render(); },
    isShown: (key) => show[key],
    zoomBy: (f) => zoomAt(W / 2, H / 2, f),
    fitRegion: (name) => fly(target(REGIONS[name] || REGIONS.north)),
    fitField(i) {
      const f = data.fieldGeo[i]; if (!f) return;
      const [w, s, e, n] = f.bbox, mx = Math.max(0.12, (e - w) * 0.9), mly = Math.max(0.06, (n - s) * 0.9);
      fly(target([w - mx, s - mly, e + mx, n + mly]));
    },
    /** Bring a point into view; zoom in if the map is far out. */
    focus(lon, lat, minK = 150) {
      const x = sx(lon), y = sy(my(lat)), inside = x > W * 0.15 && x < W * 0.85 && y > H * 0.15 && y < H * 0.85;
      if (inside && view.k >= minK) return;
      fly({ cx: lon, cy: my(lat), k: Math.max(view.k, minK) });
    },
    theme, resize, render,
    fieldGeoIndexOf: (name) => data.fieldGeoByName.get(name) ?? -1,
  };
}
