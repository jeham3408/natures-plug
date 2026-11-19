/* seismic-viewer front end. Plain ES2020, no dependencies, no build step.
 *
 * Part 1: pure helpers (coordinate mapping, ticks, colour maps). They are unit-checked in node.
 * Part 2: the browser application.
 *
 * Coordinate convention used everywhere below
 * -------------------------------------------
 * The server sends an image with m pixels along an axis, made from n source samples by block-mean
 * with an integer factor f: pixel k covers the source samples [k*f, (k+1)*f).  The image therefore
 * spans the continuous source coordinate u in [0, m*f), where sample s occupies [s, s+1) and has
 * its centre at u = s + 0.5.  Sample s has the value (line number or time) v0 + s*dv.
 * A position along the plot is a fraction fr in [0,1] (0 = left or top edge of the plot area).
 */
'use strict';

/* ======================================================================================
 * 1. Pure helpers
 * ====================================================================================== */

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/** Block-mean factor the server uses for src samples and a pixel limit (contract: ceil(src/limit), limit clamped to 64..4096). */
function blockFactor(src, limit) {
  const lim = clamp(Math.round(Number(limit) || 0), 64, 4096);
  return Math.max(1, Math.ceil(src / lim));
}

/** The factor actually used, given what came back (m pixels from src samples). Prefers the factor implied by
 *  the limit we asked for; falls back to inferring it from the sizes. */
function resolveFactor(src, m, limit) {
  if (!(src > 0) || !(m > 0) || m >= src) return 1;
  const fits = (f) => f >= 1 && (Math.ceil(src / f) === m || Math.floor(src / f) === m);
  if (limit != null) { const f = blockFactor(src, limit); if (fits(f)) return f; }
  const c = Math.ceil(src / m); if (fits(c)) return c;
  const fl = Math.floor(src / m); if (fits(fl)) return fl;
  return src / m;
}

/** v0: value of source sample 0; dv: value step per source sample; n: source samples; m: image pixels;
 *  f: block factor; flip: true when the axis is drawn reversed (sample 0 at the right / bottom edge). */
function makeAxis(v0, dv, n, m, f, flip) { return { v0, dv, n, m, f, flip: !!flip }; }

/** Build an axis from the first and last value reported by the server. */
function lineAxis(v0, v1, n, m, limit, fallbackStep) {
  const dv = (n > 1 && v1 !== v0) ? (v1 - v0) / (n - 1) : (fallbackStep || 1);
  return makeAxis(v0, dv, n, m, resolveFactor(n, m, limit), false);
}

/** value -> fraction of the plot (centre of the sample that has this value). */
function axisValueToFrac(ax, v) {
  const fr = ((v - ax.v0) / ax.dv + 0.5) / (ax.m * ax.f);
  return ax.flip ? 1 - fr : fr;
}
/** fraction of the plot -> continuous value. */
function axisFracToValue(ax, fr) {
  const g = ax.flip ? 1 - fr : fr;
  return ax.v0 + (g * ax.m * ax.f - 0.5) * ax.dv;
}
/** fraction of the plot -> image pixel index along this axis (in image order, i.e. un-flipped). */
function axisFracToPixel(ax, fr) {
  const g = ax.flip ? 1 - fr : fr;
  return clamp(Math.floor(g * ax.m), 0, ax.m - 1);
}
/** fraction of the plot -> source sample index. */
function axisFracToSample(ax, fr) {
  const g = ax.flip ? 1 - fr : fr;
  return clamp(Math.floor(g * ax.m * ax.f), 0, ax.n - 1);
}
/** first and last source sample covered by image pixel k. */
function axisPixelSamples(ax, k) {
  const a = Math.floor(k * ax.f);
  return [Math.min(a, ax.n - 1), Math.min(Math.ceil((k + 1) * ax.f), ax.n) - 1];
}

function roundTo(v, digits) { const p = Math.pow(10, digits); return Math.round(v * p) / p; }

/** Nearest stored line number / sample time on a regular grid. */
function snapLine(v, first, step, n) {
  const k = clamp(Math.round((v - first) / step), 0, n - 1);
  return roundTo(first + k * step, 6);
}
/** Snap an interval to the grid and make it at least minSamples wide. */
function snapRange(lo, hi, first, step, n, minSamples) {
  if (lo > hi) { const t = lo; lo = hi; hi = t; }
  let k0 = clamp(Math.round((lo - first) / step), 0, n - 1);
  let k1 = clamp(Math.round((hi - first) / step), 0, n - 1);
  const need = Math.min(minSamples || 1, n);
  while (k1 - k0 + 1 < need) {
    if (k0 > 0) k0--;
    if (k1 - k0 + 1 < need && k1 < n - 1) k1++;
  }
  return [roundTo(first + k0 * step, 6), roundTo(first + k1 * step, 6)];
}

/** "Nice" tick values inside [lo, hi] (either order), about `target` of them. */
function niceTicks(lo, hi, target, integer) {
  const a = Math.min(lo, hi), b = Math.max(lo, hi), span = b - a;
  if (!(span > 0) || !Number.isFinite(span)) return [];
  const raw = span / Math.max(1, target);
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  let step = (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  if (integer && step < 1) step = 1;
  const out = [];
  const k0 = Math.ceil(a / step - 1e-9), k1 = Math.floor(b / step + 1e-9);
  for (let k = k0; k <= k1 && out.length < 200; k++) out.push(Number((k * step).toPrecision(12)));
  return out;
}

/** Tick values for a line-number axis that are STORED line numbers, about `target` of them.
 *  Spacing = step * N with N a "nice" integer (1, 2, 5, 10, ...). Round numbers are used when they are stored
 *  lines (step 1: 6000, 6500, ...); otherwise the ticks start from the first line (4175, 4275, ... for odd inlines). */
function gridTicks(lo, hi, target, first, step) {
  const a = Math.min(lo, hi), b = Math.max(lo, hi), span = b - a, st = Math.abs(step) || 1;
  if (!(span > 0) || !Number.isFinite(span)) return [];
  const raw = span / Math.max(1, target) / st;                 // wanted spacing in stored lines
  let N = 1;
  if (raw > 1) { const p = Math.pow(10, Math.floor(Math.log10(raw))), m = raw / p; N = Math.max(1, Math.round((m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p)); }
  const D = st * N;
  const offset = ((first % D) + D) % D;                        // stored lines are congruent to `first` modulo st
  const origin = (offset % st === 0) ? 0 : first;              // multiples of D are stored lines only if `first` is a multiple of st
  const out = [];
  const k0 = Math.ceil((a - origin) / D - 1e-9), k1 = Math.floor((b - origin) / D + 1e-9);
  for (let k = k0; k <= k1 && out.length < 200; k++) out.push(origin + k * D);
  return out;
}

/** fraction of the plot -> value of the source sample under it, always inside the image window (the last block of
 *  a block-averaged image is partial, so the continuous coordinate may run past the last sample). */
function axisFracToSampleValue(ax, fr) { return roundTo(ax.v0 + axisFracToSample(ax, fr) * ax.dv, 6); }

/** Pixel limit (w or h) to ask the server for, for `src` samples shown on `plotPx` device pixels.
 *  The server reduces by the integer factor ceil(src / limit). Normal mode picks the largest factor that still gives
 *  at least one image pixel per device pixel (never fewer pixels than the screen shows, at most maxPx), so a window
 *  only slightly larger than the plot is NOT halved. Preview mode picks the smallest image that fills the plot. */
function requestLimit(src, plotPx, maxPx, preview) {
  const P = Math.max(1, plotPx), M = Math.max(64, maxPx);
  const f = preview ? Math.max(1, Math.ceil(src / Math.min(P, M))) : Math.max(1, Math.ceil(src / M), Math.floor(src / P));
  return clamp(Math.ceil(src / f), 64, 4096);
}

/** Full transition width in Hz of a Hamming-windowed FIR with `taps` coefficients (3.3 / (taps * dt)). */
function transitionHz(taps, dtMs) { return taps > 0 ? 3300 / (taps * dtMs) : 0; }

/** Time (ms) from the first / last sample within which the filter window reaches past the data (zero padding). */
function edgeZoneMs(info, dtMs) {
  if (!info || !(info.taps > 1)) return 0;
  let z = (info.taps - 1) / 2 * dtMs;
  if (info.attr === 'rms' && info.win_ms > 0) z += (rmsWindowSamples(info.win_ms, dtMs) - 1) / 2 * dtMs;
  return z;
}

/** JPEG quality per view: noisy attributes compress badly, so they get a lower quality to stay small. */
function jpegQuality(attr, filtered) { return attr === 'ifreq' ? 60 : (attr === 'amp' && !filtered) ? 80 : 72; }

/** 8-bit pixel -> data value (contract pixel coding). */
function decodeValue(p, signed, vmax) {
  return signed ? (p - 128) / 127 * vmax : p / 255 * vmax;
}

/** Compass letter (8 points) of a map vector [east, north]. */
function compassLetter(dx, dy) {
  if (!dx && !dy) return '';
  const bearing = Math.atan2(dx, dy) * 180 / Math.PI;       // clockwise from north
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][((Math.round(bearing / 45) % 8) + 8) % 8];
}

/** How to draw the map so that north is up and east is right as nearly as flips (and a transpose) allow.
 *  The slice image has columns = crossline (increasing right) and rows = inline (increasing down).
 *  Returns transposed (inline on the horizontal axis), flipH (horizontal axis numbers DEcrease to the right),
 *  flipV (vertical axis numbers INcrease upward), and the screen direction of north as [x right, y up]. */
function mapOrientation(ilVec, xlVec) {
  const unit = (v) => { const L = Math.hypot(v[0], v[1]) || 1; return [v[0] / L, v[1] / L]; };
  const neg = (v) => [-v[0], -v[1]];
  const il = unit(ilVec), xl = unit(xlVec);
  let best = null;
  for (const transposed of [false, true]) for (const flipH of [false, true]) for (const flipV of [false, true]) {
    const hVec = transposed ? il : xl, vVec = transposed ? xl : il;
    const right = flipH ? neg(hVec) : hVec;      // map direction of "screen right"
    const up = flipV ? vVec : neg(vVec);         // map direction of "screen up"
    const score = right[0] + up[1] - (transposed ? 1e-6 : 0);
    if (!best || score > best.score + 1e-12) best = { transposed, flipH, flipV, right, up, score };
  }
  const nx = best.right[1], ny = best.up[1], L = Math.hypot(nx, ny) || 1;
  best.north = [nx / L, ny / L];
  return best;
}

/** RMS window in samples as the server defines it (odd integer nearest win/dt, >= 3), and the nominal half window
 *  drawn on screen: the contract states the RMS map covers [t - win/2, t + win/2]. */
function rmsWindowSamples(winMs, dtMs) {
  return Math.max(3, 2 * Math.round((winMs / dtMs - 1) / 2) + 1);
}
function rmsHalfWindow(winMs, dtMs) { return Math.max(winMs, 3 * dtMs) / 2; }

/** Band-pass validation: 0 <= low < high <= Nyquist. */
function validateBand(flo, fhi, nyq) {
  if (!Number.isFinite(flo) || !Number.isFinite(fhi)) return 'Enter both corner frequencies as numbers.';
  if (flo < 0) return 'The low corner cannot be negative.';
  if (fhi > nyq + 1e-9) return 'The high corner cannot exceed the Nyquist frequency (' + fmtNum(nyq) + ' Hz).';
  if (fhi < 0.01) return 'The high corner must be at least 0.01 Hz.';
  if (!(flo < fhi)) return 'The low corner must be below the high corner.';
  return '';
}
/** Corners to send: null = that side is open (0 Hz low corner = low-pass only, Nyquist high corner = high-pass only). */
function bandParams(on, flo, fhi, nyq) {
  if (!on || validateBand(flo, fhi, nyq)) return null;
  const lo = flo > 0 ? flo : null, hi = fhi < nyq - 1e-9 ? fhi : null;
  return (lo == null && hi == null) ? null : { flo: lo, fhi: hi };
}

/* ---- colour maps ---- */
const CMAPS = {
  /* diverging, t in [-1, 1]; exactly white at 0; negative blue, positive red */
  seismic: { diverging: true, label: 'Seismic (red-white-blue)',
    stops: [[-1, [0, 0, 77]], [-0.5, [16, 60, 235]], [0, [255, 255, 255]], [0.5, [232, 28, 28]], [1, [110, 0, 0]]] },
  grey: { label: 'Greyscale',
    stops: [[0, [0, 0, 0]], [1, [255, 255, 255]]] },
  viridis: { label: 'Viridis-like (sequential)',
    stops: [[0, [68, 1, 84]], [0.111, [72, 40, 120]], [0.222, [62, 73, 137]], [0.333, [49, 104, 142]], [0.444, [38, 130, 142]],
      [0.556, [31, 158, 137]], [0.667, [53, 183, 121]], [0.778, [110, 206, 88]], [0.889, [181, 222, 43]], [1, [253, 231, 37]]] },
  magma: { label: 'Magma-like (sequential)',
    stops: [[0, [0, 0, 4]], [0.1, [20, 14, 54]], [0.2, [59, 15, 112]], [0.3, [100, 26, 128]], [0.4, [140, 41, 129]], [0.5, [183, 55, 121]],
      [0.6, [222, 73, 104]], [0.7, [247, 112, 92]], [0.8, [254, 159, 109]], [0.9, [254, 207, 146]], [1, [252, 253, 191]]] },
};
const CMAPS_SIGNED = ['seismic', 'grey'];
const CMAPS_UNSIGNED = ['viridis', 'magma', 'grey'];

function interpStops(stops, t) {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i], w = (t - a[0]) / (b[0] - a[0]);
      return [Math.round(a[1][0] + (b[1][0] - a[1][0]) * w), Math.round(a[1][1] + (b[1][1] - a[1][1]) * w), Math.round(a[1][2] + (b[1][2] - a[1][2]) * w)];
    }
  }
  return stops[stops.length - 1][1];
}
/** Colour of a normalised value: signed data t in [-1,1], unsigned data t in [0,1]. */
function cmapRGB(name, t, signed) {
  const cm = CMAPS[name] || CMAPS.grey;
  if (cm.diverging) return interpStops(cm.stops, t);
  return interpStops(cm.stops, signed ? (t + 1) / 2 : t);
}
/** 256-entry lookup table, packed as 0xAABBGGRR (little-endian RGBA). Gain rescales the 8-bit code before the lookup. */
function buildLut(name, signed, gain, polarity) {
  const lut = new Uint32Array(256);
  for (let p = 0; p < 256; p++) {
    const t = signed ? clamp((p - 128) / 127 * gain, -1, 1) * (polarity < 0 ? -1 : 1) : clamp(p / 255 * gain, 0, 1);
    const c = cmapRGB(name, t === 0 ? 0 : t, signed);
    lut[p] = (0xff000000 | (c[2] << 16) | (c[1] << 8) | c[0]) >>> 0;
  }
  return lut;
}

/* ---- formatting ---- */
function fmtNum(v) { return String(roundTo(Number(v), 3)); }
function fmtVal(v) {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e6 || a < 1e-3) return v.toExponential(2).replace('e+', 'e');
  if (a >= 1000) return String(Math.round(v));
  return String(parseFloat(v.toPrecision(3)));
}

/** Largest rectangle with the given aspect (w/h) centred in box {x,y,w,h}; integer pixels. */
function fitRect(box, aspect) {
  let w = box.w, h = box.w / aspect;
  if (h > box.h) { h = box.h; w = box.h * aspect; }
  w = Math.max(8, Math.round(w)); h = Math.max(8, Math.round(h));
  return { x: Math.round(box.x + (box.w - w) / 2), y: Math.round(box.y + (box.h - h) / 2), w, h };
}
/** Nice scale-bar length (1, 2, 5 x 10^k metres) not longer than maxMetres. */
function niceScaleLength(maxMetres) {
  if (!(maxMetres > 0)) return 0;
  const p = Math.pow(10, Math.floor(Math.log10(maxMetres)));
  const m = maxMetres / p;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
}

if (typeof module === 'object' && module.exports) {
  module.exports = { clamp, blockFactor, resolveFactor, makeAxis, lineAxis, axisValueToFrac, axisFracToValue, axisFracToPixel,
    axisFracToSample, axisPixelSamples, snapLine, snapRange, niceTicks, decodeValue, compassLetter, mapOrientation,
    rmsWindowSamples, rmsHalfWindow, validateBand, bandParams, CMAPS, cmapRGB, buildLut, fmtNum, fmtVal, fitRect, niceScaleLength,
    gridTicks, axisFracToSampleValue, requestLimit, transitionHz, edgeZoneMs, jpegQuality };
}

/* ======================================================================================
 * 2. Browser application
 * ====================================================================================== */
if (typeof document !== 'undefined') (function () {

  const $ = (id) => document.getElementById(id);
  const COL = { ink: '#e8efec', ink2: '#c5d0cb', muted: '#93a19b', frame: '#6b7a74', grid: '#2b3a35', field: '#0d1815',
    il: '#f0703a', xl: '#2fcb93', t: '#ffd84d' };
  const FONT = '11px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  const FONT_B = '600 11px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  const KEY_NAME = { il: 'Inline', xl: 'Crossline', t: 'Two-way time (ms)' };
  const KEY_SHORT = { il: 'IL', xl: 'XL', t: 'TWT' };
  const ATTR_NAME = { amp: 'Amplitude', rms: 'RMS amplitude', env: 'Envelope', ifreq: 'Instantaneous frequency', sd: 'Spectral decomposition' };
  // MAX_T: sections are requested with the TIME axis unreduced up to this many samples (averaging 3-4 samples per
  // row removes most energy above 40 Hz). PNG_PIXELS: smaller images are fetched as lossless PNG.
  const DEBOUNCE_MS = 120, SETTLE_MS = 260, MAX_W = 1600, MAX_W_NOISY = 1100, MAX_T = 1024, DPR_CAP = 1.5, PNG_PIXELS = 150000;
  const HINT = 'Click or drag: move cross-hair. Shift-drag: zoom. Double-click: full extent.';

  // which cube: index.html?ds=<id> (see /api/datasets); without it the server's first cube answers
  const DS = (typeof location !== 'undefined') ? new URLSearchParams(location.search).get('ds') : null;
  const API = 'api/' + (DS ? encodeURIComponent(DS) + '/' : '');
  if (typeof window !== 'undefined') { window.SV_DS = DS; window.SV_API = API; }
  let META = null, ORIENT = null;
  const S = { il: 0, xl: 0, t: 0, attr: 'amp', bp: false, flo: 5, fhi: 60, win: 100, f0: 30,
    cmS: 'seismic', cmU: 'viridis', pol: 1, gain: 1, zoom: { il: null, xl: null, map: null } };
  const P = {};
  let lastBand = null;         // last valid band actually in use

  /* ---------- grid helpers ---------- */
  function grid(key) {
    if (key === 'il') return { first: META.il0, step: META.il_step, n: META.n_il };
    if (key === 'xl') return { first: META.xl0, step: META.xl_step, n: META.n_xl };
    return { first: META.t0_ms, step: META.dt_ms, n: META.n_t };
  }
  function gridLast(g) { return roundTo(g.first + (g.n - 1) * g.step, 6); }
  function gridIndex(key, v) { const g = grid(key); return clamp(Math.round((v - g.first) / g.step), 0, g.n - 1); }
  function f0Range() {
    const sv = META.server || {}, nyq = META.nyquist_hz;
    const lo = Number.isFinite(sv.f0_min) ? sv.f0_min : Math.min(5, Math.floor(0.8 * nyq));
    const hi = Number.isFinite(sv.f0_max) ? sv.f0_max : Math.floor(0.8 * nyq);
    return [lo, Math.max(lo, hi)];
  }
  function snap(key, v) { const g = grid(key); return snapLine(v, g.first, g.step, g.n); }
  function band() { return bandParams(S.bp, S.flo, S.fhi, META.nyquist_hz); }
  function isSigned(attr) { return attr === 'amp'; }

  /* ======================= Panels ======================= */
  class Panel {
    constructor(key) {
      this.key = key;
      const root = this.root = $('p-' + key);
      this.canvas = root.querySelector('canvas');
      this.ctx = this.canvas.getContext('2d');
      this.elMain = root.querySelector('.p-main'); this.elSub = root.querySelector('.p-sub');
      this.elSpin = root.querySelector('.spinner'); this.elLoad = root.querySelector('.p-load'); this.elTime = root.querySelector('.p-time');
      this.elReset = root.querySelector('.p-reset');
      this.elErr = root.querySelector('.p-error'); this.elErrMsg = this.elErr.querySelector('p'); this.elRetry = this.elErr.querySelector('button');
      this.elRead = root.querySelector('.p-read');
      this.img = null; this.seq = 0; this.ctrl = null; this.timer = 0; this.retryTimer = 0; this.sizeTimer = 0;
      this.shownBase = null; this.pendingUrl = null; this.error = null; this.attempt = 0; this.liveDirty = false;
      this.cssW = 0; this.cssH = 0; this.dpr = 1; this.rect = null; this.drag = null; this.raf = 0;
      this.ptr = null;             // last pointer position over the canvas (CSS px), null when the pointer is elsewhere
      this.elRead.textContent = HINT;

      const c = this.canvas;
      c.addEventListener('pointerdown', (e) => this.onDown(e));
      c.addEventListener('pointermove', (e) => this.onMove(e));
      c.addEventListener('pointerup', (e) => this.onUp(e));
      c.addEventListener('pointercancel', () => { this.drag = null; this.invalidate(); });
      c.addEventListener('pointerleave', () => { this.ptr = null; if (!this.drag) this.elRead.textContent = HINT; });
      c.addEventListener('dblclick', (e) => { e.preventDefault(); this.resetZoom(); });
      this.elReset.addEventListener('click', () => this.resetZoom());
      this.elRetry.addEventListener('click', () => { this.attempt = 0; this.fetchNow(true, false); });
      if (window.ResizeObserver) new ResizeObserver(() => this.resize()).observe(this.canvas.parentElement);
      this.resize();
    }

    get zoom() { return S.zoom[this.key]; }
    /** Which state variable each plot axis belongs to. */
    keys() {
      if (this.key === 'il') return { h: 'xl', v: 't' };
      if (this.key === 'xl') return { h: 'il', v: 't' };
      return ORIENT.transposed ? { h: 'il', v: 'xl' } : { h: 'xl', v: 'il' };
    }
    range(key) {
      const z = this.zoom;
      if (z && z[key]) return z[key];
      const g = grid(key); return [g.first, gridLast(g)];
    }
    margins() { return { l: 60, t: 20, r: 74, b: 40 }; }
    availRect() {
      const M = this.margins();
      return { x: M.l, y: M.t, w: Math.max(40, this.cssW - M.l - M.r), h: Math.max(40, this.cssH - M.t - M.b) };
    }
    /** Plot rectangle in CSS pixels. Sections fill the available area; the map is letterboxed to true metric aspect. */
    plotRect(forRequest) {
      const A = this.availRect();
      if (this.key !== 'map') return A;
      const k = this.keys(), img = forRequest ? null : this.img;
      let wm, hm;
      if (img) {
        wm = img.hAxis.m * img.hAxis.f * Math.abs(img.hAxis.dv) * metresPerLine(img.hKey);
        hm = img.vAxis.m * img.vAxis.f * Math.abs(img.vAxis.dv) * metresPerLine(img.vKey);
      } else {
        wm = this.count(k.h) * Math.abs(grid(k.h).step) * metresPerLine(k.h);
        hm = this.count(k.v) * Math.abs(grid(k.v).step) * metresPerLine(k.v);
      }
      return fitRect(A, (wm > 0 && hm > 0) ? wm / hm : 1);
    }
    /** Number of source samples of `key` in the current window. */
    count(key) { const r = this.range(key), g = grid(key); return Math.round(Math.abs((r[1] - r[0]) / g.step)) + 1; }
    /** Views that are cheap enough on the server to follow a moving slider live. */
    cheapLive() { return S.attr === 'amp' && !band(); }
    /** w,h limits to ask the server for (see requestLimit). Sections keep the full time sampling (up to MAX_T rows);
     *  a preview (while a slider moves) is only as large as the plot in CSS pixels. Also returns the image size
     *  that will come back. */
    reqSize(preview) {
      const R = this.plotRect(true), d = preview ? 1 : Math.min(window.devicePixelRatio || 1, DPR_CAP), k = this.keys();
      let pw = R.w * d, ph = R.h * d, nCols, nRows, h;
      const maxW = S.attr === 'ifreq' ? MAX_W_NOISY : MAX_W;
      if (this.key === 'map') {
        nCols = this.count('xl'); nRows = this.count('il');
        if (ORIENT.transposed) { const t = pw; pw = ph; ph = t; }              // image columns are drawn vertically
        h = requestLimit(nRows, ph, maxW, preview);
      } else {
        nCols = this.count(k.h); nRows = this.count('t');
        h = preview ? requestLimit(nRows, ph, MAX_T, true) : clamp(Math.ceil(nRows / Math.ceil(nRows / MAX_T)), 64, 4096);
      }
      const w = requestLimit(nCols, pw, maxW, preview);
      return { w, h, cols: Math.ceil(nCols / blockFactor(nCols, w)), rows: Math.ceil(nRows / blockFactor(nRows, h)) };
    }
    buildRequest(preview) {
      const q = [], z = this.zoom;
      let path;
      if (this.key === 'map') {
        path = API + 'slice';
        q.push('t=' + fmtNum(S.t));
        if (z) q.push('i0=' + z.il[0], 'i1=' + z.il[1], 'x0=' + z.xl[0], 'x1=' + z.xl[1]);
      } else {
        path = API + 'section';
        q.push('kind=' + this.key, 'line=' + (this.key === 'il' ? S.il : S.xl));
        if (z) { const c = this.key === 'il' ? z.xl : z.il; q.push('a0=' + c[0], 'a1=' + c[1], 't0=' + fmtNum(z.t[0]), 't1=' + fmtNum(z.t[1])); }
      }
      q.push('attr=' + S.attr);
      let filtered = S.attr !== 'amp';
      if (S.attr !== 'sd') {
        const b = band();
        if (b) { filtered = true; if (b.flo != null) q.push('flo=' + fmtNum(b.flo)); if (b.fhi != null) q.push('fhi=' + fmtNum(b.fhi)); }
      }
      if (S.attr === 'rms') q.push('win_ms=' + fmtNum(S.win));
      if (S.attr === 'sd') q.push('f0=' + fmtNum(S.f0));
      const base = path + '?' + q.join('&');
      const sz = this.reqSize(preview);
      // small images are fetched lossless; larger ones as JPEG with a quality that keeps them well under 400 kB
      const coding = (!preview && sz.cols * sz.rows <= PNG_PIXELS) ? '&fmt=png' : '&q=' + (preview ? 70 : jpegQuality(S.attr, filtered));
      return { base, w: sz.w, h: sz.h, preview: !!preview, url: base + '&w=' + sz.w + '&h=' + sz.h + coding };
    }

    /* ---------- networking ---------- */
    /** Ask for a new image. `live` = the position is being scrubbed (slider, arrow key, drag): cheap views then
     *  follow at once with small preview images, one request in flight at a time, and the full-quality image is
     *  fetched when the movement stops. Everything else is debounced. */
    schedule(delay, live) {
      clearTimeout(this.timer);
      if (live && this.cheapLive()) {
        // nothing in flight (or only a slow full-quality request, which is now out of date): show a preview at once;
        // a preview already in flight is allowed to finish, the newest position follows when it arrives
        if (!this.ctrl || !this.ctrlPreview) this.fetchNow(false, true); else this.liveDirty = true;
        this.timer = setTimeout(() => { this.liveDirty = false; this.fetchNow(false, false); }, SETTLE_MS);
        return;
      }
      this.liveDirty = false;
      this.timer = setTimeout(() => this.fetchNow(false, false), delay == null ? DEBOUNCE_MS : delay);
    }
    setLoading(on, text) {
      this.elSpin.hidden = !on;
      this.elLoad.textContent = on ? (text || 'loading…') : '';
    }
    showError(msg) {
      this.error = msg;
      this.elErrMsg.textContent = msg;
      this.elErr.hidden = false;
    }
    clearError() { this.error = null; this.elErr.hidden = true; }
    abort() {
      if (this.ctrl) { try { this.ctrl.abort(); } catch (e) { /* ignore */ } this.ctrl = null; }
      clearTimeout(this.retryTimer);
      this.pendingUrl = null;
    }
    async fetchNow(force, preview) {
      if (!preview) clearTimeout(this.timer);
      if (!META) return;
      const req = this.buildRequest(preview);
      if (!force && req.url === this.pendingUrl) return;                       // already on its way
      if (!force && !this.error && this.img && req.base === this.shownBase) {
        // Same data selection as on screen: refetch only if the new size changes the block-mean factors.
        // A preview never replaces an image of the same selection; a preview on screen is always replaced by the full one.
        const im = this.img, sameF = blockFactor(im.srcCols, req.w) === im.fCols && blockFactor(im.srcRows, req.h) === im.fRows;
        if (req.preview || (sameF && !im.preview)) { this.seq++; this.abort(); this.setLoading(false); return; }
      }
      this.abort();
      const seq = ++this.seq;
      const ctrl = this.ctrl = new AbortController();
      this.ctrlPreview = req.preview;
      this.pendingUrl = req.url;
      this.clearError();
      this.setLoading(true);
      const tStart = performance.now();
      try {
        const res = await fetch(req.url, { signal: ctrl.signal, cache: 'no-store' });
        if (!res.ok) {
          let msg = 'HTTP ' + res.status + ' ' + res.statusText;
          try { const j = await res.json(); if (j && j.error) msg = String(j.error); } catch (e) { /* keep the status text */ }
          const err = new Error(msg); err.server = true; throw err;
        }
        let info;
        try { info = JSON.parse(res.headers.get('X-SV-Info')); } catch (e) { info = null; }
        if (!info || typeof info !== 'object') { const err = new Error('The response has no readable X-SV-Info header.'); err.server = true; throw err; }
        const blob = await res.blob();
        if (seq !== this.seq) return;
        let dec;
        try { dec = await decodeGrey(blob); } catch (e) { const err = new Error('The image could not be decoded.'); err.server = true; throw err; }
        if (seq !== this.seq) return;                                          // a newer request exists: drop this one
        this.ctrl = null; this.pendingUrl = null; this.attempt = 0;
        this.setImage(dec, info, req, { bytes: blob.size, total: performance.now() - tStart, lossless: blob.type === 'image/png' });
        this.setLoading(false);
        if (this.liveDirty) { this.liveDirty = false; this.fetchNow(false, true); }   // the position moved on meanwhile
      } catch (e) {
        if (seq !== this.seq || (e && e.name === 'AbortError')) return;
        this.ctrl = null; this.pendingUrl = null;
        if (e && e.server) { this.setLoading(false); this.showError(e.message); return; }
        // network failure: retry automatically a few times, then offer a button
        if (this.attempt < 3) {
          this.attempt++;
          this.setLoading(true, 'network error, retry ' + this.attempt + '/3…');
          this.retryTimer = setTimeout(() => { if (seq === this.seq) this.fetchNow(true, false); }, 900 * this.attempt);
        } else {
          this.setLoading(false);
          this.showError('Network failure: the server did not answer (' + (e && e.message ? e.message : 'no details') + ').');
        }
      }
    }

    setImage(dec, info, req, net) {
      const M = META, cols = dec.cols, rows = dec.rows;
      const srcCols = info.src_cols > 0 ? info.src_cols : cols, srcRows = info.src_rows > 0 ? info.src_rows : rows;
      let hAxis, vAxis, hKey, vKey, transposed = false;
      if (this.key === 'map') {
        const xAx = lineAxis(info.x0, info.x1, srcCols, cols, req.w, M.xl_step);
        const iAx = lineAxis(info.i0, info.i1, srcRows, rows, req.h, M.il_step);
        transposed = ORIENT.transposed;
        if (transposed) { hAxis = iAx; vAxis = xAx; hKey = 'il'; vKey = 'xl'; } else { hAxis = xAx; vAxis = iAx; hKey = 'xl'; vKey = 'il'; }
        hAxis.flip = ORIENT.flipH; vAxis.flip = ORIENT.flipV;
      } else {
        hKey = this.key === 'il' ? 'xl' : 'il'; vKey = 't';
        hAxis = lineAxis(info.a0, info.a1, srcCols, cols, req.w, hKey === 'xl' ? M.xl_step : M.il_step);
        vAxis = lineAxis(info.t0, info.t1, srcRows, rows, req.h, M.dt_ms);
      }
      const colAxis = transposed ? vAxis : hAxis, rowAxis = transposed ? hAxis : vAxis;
      const signed = typeof info.signed === 'boolean' ? info.signed : isSigned(info.attr);
      this.img = { bytes: dec.bytes, cols, rows, srcCols, srcRows, fCols: colAxis.f, fRows: rowAxis.f, info, hAxis, vAxis, hKey, vKey,
        transposed, signed, vmax: Number(info.vmax) > 0 ? Number(info.vmax) : 1, unit: info.unit || 'amplitude', colored: null,
        preview: !!req.preview, lossless: !!net.lossless, edgeMs: edgeZoneMs(info, M.dt_ms) };
      this.shownBase = req.base;
      this.clearError();
      // title and timing
      const d = describeInfo(info) + this.reductionNote();
      if (this.key === 'map') {
        if (info.attr === 'rms') {
          const half = rmsHalfWindow(info.win_ms || S.win, M.dt_ms);
          this.elMain.textContent = 'RMS map ' + fmtNum(Math.max(M.t0_ms, info.t - half)) + '–' + fmtNum(Math.min(gridLast(grid('t')), info.t + half)) + ' ms';
        } else this.elMain.textContent = 'Time slice ' + fmtNum(info.t) + ' ms';
      } else this.elMain.textContent = (this.key === 'il' ? 'Inline ' : 'Crossline ') + info.line;
      this.elSub.textContent = d; this.elSub.title = d;
      this.canvas.setAttribute('aria-label', this.elMain.textContent + ', ' + d);
      const parts = [];
      if (Number.isFinite(info.ms)) parts.push('server ' + (info.ms < 10 ? info.ms.toFixed(1) : Math.round(info.ms)) + ' ms' + (info.cached ? ' (cached)' : '') +
        (info.queued_ms >= 1 ? ' + ' + Math.round(info.queued_ms) + ' ms queued' : ''));
      parts.push('total ' + Math.round(net.total) + ' ms', Math.round(net.bytes / 1024) + ' kB');
      this.elTime.textContent = parts.join(' · ');
      this.elTime.title = 'Server compute time (waiting for a free slot is shown separately as "queued"), total time including transfer and decoding, and image size. ' +
        srcCols + ' x ' + srcRows + ' samples received as ' + cols + ' x ' + rows + ' pixels.';
      this.recolor();
      if (this.ptr && !this.drag) this.hover(this.posAt(this.ptr.x, this.ptr.y));   // the pointer rests on a new image: refresh the read-out
      if (this.key === 'il') { syncBandMsg(); drawSpectrum(); }                     // they quote the filter actually applied
    }

    /** Text for the subtitle: what the pixels are when the server averaged samples, and the filter edge zone. */
    reductionNote() {
      const img = this.img; if (!img) return '';
      let s = '';
      if (img.vKey === 't') {
        if (img.vAxis.f > 1) s += ' · each row = mean of ' + img.vAxis.f + ' samples: above ≈' + fmtNum(roundTo(500 / (img.vAxis.f * META.dt_ms), 0)) + ' Hz is attenuated' + (img.preview ? ' (preview while moving)' : ', zoom in');
        if (img.hAxis.f > 1) s += ' · each column = mean of ' + img.hAxis.f + ' traces';
      } else if (img.hAxis.f > 1 || img.vAxis.f > 1) s += ' · each pixel = mean of ' + img.hAxis.f + ' × ' + img.vAxis.f + ' traces';
      if (this.key === 'map' && this.inEdgeZone(img.info.t)) s += ' · inside the filter edge zone (' + fmtNum(img.edgeMs) + ' ms from the first/last sample): values biased by zero padding';
      return s;
    }
    inEdgeZone(t) {
      const img = this.img, g = grid('t');
      if (!img || !(img.edgeMs > 0)) return false;
      const a = Math.min(g.first, gridLast(g)), b = Math.max(g.first, gridLast(g));
      return t - a < img.edgeMs || b - t < img.edgeMs;
    }

    /** Build the coloured image (display orientation) from the stored 8-bit codes; no network involved. */
    recolor() {
      const img = this.img; if (!img) return;
      const lut = buildLut(img.signed ? S.cmS : S.cmU, img.signed, S.gain, S.pol);
      const W = img.hAxis.m, H = img.vAxis.m, src = img.bytes, cols = img.cols;
      const c = img.colored || (img.colored = document.createElement('canvas'));
      if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      const cx = c.getContext('2d'), id = cx.createImageData(W, H), out = new Uint32Array(id.data.buffer);
      const fh = img.hAxis.flip, fv = img.vAxis.flip;
      if (!img.transposed && !fh && !fv) {
        for (let i = 0, n = W * H; i < n; i++) out[i] = lut[src[i]];
      } else {
        let o = 0;
        for (let Y = 0; Y < H; Y++) {
          const vi = fv ? H - 1 - Y : Y;
          for (let X = 0; X < W; X++) {
            const hi = fh ? W - 1 - X : X;
            out[o++] = lut[src[img.transposed ? hi * cols + vi : vi * cols + hi]];
          }
        }
      }
      cx.putImageData(id, 0, 0);
      this.draw();
    }

    /* ---------- layout and drawing ---------- */
    resize() {
      const body = this.canvas.parentElement;
      const w = body.clientWidth, h = body.clientHeight, dpr = window.devicePixelRatio || 1;
      if (!w || !h) return;
      if (w === this.cssW && h === this.cssH && dpr === this.dpr) return;
      this.cssW = w; this.cssH = h; this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
      this.draw();
      if (META) { clearTimeout(this.sizeTimer); this.sizeTimer = setTimeout(() => this.fetchNow(false, false), 300); }
    }
    invalidate() { if (!this.raf) this.raf = requestAnimationFrame(() => this.draw()); }

    draw() {
      if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0; }
      const ctx = this.ctx, W = this.cssW, H = this.cssH;
      if (!W || !H) return;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      if (!META) return;
      const R = this.rect = this.plotRect(false), img = this.img;
      ctx.font = FONT; ctx.lineWidth = 1;
      if (!img) {
        ctx.fillStyle = COL.field; ctx.fillRect(R.x, R.y, R.w, R.h);
        ctx.strokeStyle = COL.frame; ctx.strokeRect(R.x + 0.5, R.y + 0.5, R.w - 1, R.h - 1);
        ctx.fillStyle = COL.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(this.error ? 'No image' : 'Waiting for the first image…', R.x + R.w / 2, R.y + R.h / 2);
        return;
      }
      const hA = img.hAxis, vA = img.vAxis, hk = img.hKey, vk = img.vKey;

      // --- image ---
      const sx = R.w * this.dpr / img.colored.width, sy = R.h * this.dpr / img.colored.height;
      ctx.imageSmoothingEnabled = !(Math.min(sx, sy) >= 1 && Math.max(sx, sy) >= 2.5);   // nearest neighbour when magnifying strongly
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img.colored, R.x, R.y, R.w, R.h);
      ctx.imageSmoothingEnabled = true;

      // --- axes ---
      const X = (v) => R.x + axisValueToFrac(hA, v) * R.w, Y = (v) => R.y + axisValueToFrac(vA, v) * R.h;
      ctx.strokeStyle = COL.frame; ctx.fillStyle = COL.ink2;
      ctx.strokeRect(R.x - 0.5, R.y - 0.5, R.w + 1, R.h + 1);
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const ticks = (ax, key, target) => {             // line axes: only stored line numbers get a tick
        const lo = axisFracToValue(ax, 0), hi = axisFracToValue(ax, 1);
        if (key === 't') return niceTicks(lo, hi, target, false);
        const g = grid(key); return gridTicks(lo, hi, target, g.first, g.step);
      };
      const hTicks = ticks(hA, hk, Math.max(2, R.w / 85));   // at least two labels on a narrow panel
      ctx.beginPath();
      for (const v of hTicks) {
        const x = Math.floor(X(v)) + 0.5;               // the device-independent pixel that contains the exact position
        ctx.moveTo(x, R.y + R.h); ctx.lineTo(x, R.y + R.h + 5);
        ctx.fillText(fmtNum(v), clamp(x, R.x + 8, R.x + R.w - 8), R.y + R.h + 7);
      }
      ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      const vTicks = ticks(vA, vk, Math.max(2, R.h / 42));
      for (const v of vTicks) {
        const y = Math.floor(Y(v)) + 0.5;
        ctx.moveTo(R.x - 5, y); ctx.lineTo(R.x, y);
        ctx.fillText(fmtNum(v), R.x - 8, y);
      }
      ctx.stroke();
      // axis titles
      ctx.fillStyle = COL.ink; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      const titleY = R.y + R.h + 33;
      ctx.fillText(KEY_NAME[hk] + (hk === 't' ? '' : ' number'), R.x + R.w / 2, titleY);
      ctx.save(); ctx.translate(R.x - 46, R.y + R.h / 2); ctx.rotate(-Math.PI / 2);
      ctx.fillText(KEY_NAME[vk] + (vk === 't' ? '' : ' number'), 0, 0); ctx.restore();

      if (this.key === 'map') this.drawMapFurniture(ctx, R, img, titleY);
      else {
        // compass letters at the two ends of the horizontal axis
        const vec = hk === 'il' ? META.il_axis_m : META.xl_axis_m;
        const right = compassLetter(vec[0], vec[1]), left = compassLetter(-vec[0], -vec[1]);
        ctx.font = FONT_B; ctx.fillStyle = COL.ink;
        ctx.textAlign = 'left'; ctx.fillText('◂ ' + left, R.x, titleY);
        ctx.textAlign = 'right'; ctx.fillText(right + ' ▸', R.x + R.w, titleY);
        ctx.font = FONT;
      }

      // --- markers ---
      ctx.save(); ctx.beginPath(); ctx.rect(R.x, R.y, R.w, R.h); ctx.clip();
      if (vk === 't' && img.edgeMs > 0) this.drawEdgeZone(ctx, R, Y, img);
      this.drawNotes(ctx, R, img);
      if (vk === 't' && S.attr === 'rms') {                       // RMS window band on the sections
        const half = rmsHalfWindow(img.info.attr === 'rms' && img.info.win_ms > 0 ? img.info.win_ms : S.win, META.dt_ms);
        const y0 = Y(S.t - half), y1 = Y(S.t + half);
        ctx.fillStyle = 'rgba(255, 216, 77, 0.18)'; ctx.fillRect(R.x, y0, R.w, y1 - y0);
        ctx.setLineDash([5, 4]); hairline(ctx, R.x, y0, R.x + R.w, y0, COL.t); hairline(ctx, R.x, y1, R.x + R.w, y1, COL.t); ctx.setLineDash([]);
      }
      const mx = X(S[hk]), my = Y(S[vk]);
      hairline(ctx, mx, R.y, mx, R.y + R.h, COL[hk]);
      hairline(ctx, R.x, my, R.x + R.w, my, COL[vk]);
      // wells, logs and horizons (wells.js), drawn inside the plot
      if (window.SVWells) { try { window.SVWells.draw(this, ctx, R, X, Y, img); } catch (e) { console.error(e); } }
      if (window.SV3D) window.SV3D.touch(this.key);            // the 3D view shows the same image as a plane
      // label of the horizontal marker, inside the plot
      if (my >= R.y && my <= R.y + R.h) {
        const txt = KEY_SHORT[vk] + ' ' + fmtNum(S[vk]) + (vk === 't' ? ' ms' : '');
        ctx.font = FONT_B; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        const tw = ctx.measureText(txt).width, ty = my > R.y + 18 ? my - 5 : my + 14;
        ctx.fillStyle = 'rgba(8, 16, 14, 0.78)'; ctx.fillRect(R.x + 3, ty - 11, tw + 8, 14);
        ctx.fillStyle = COL[vk]; ctx.fillText(txt, R.x + 7, ty);
      }
      // zoom rubber band
      if (this.drag && this.drag.mode === 'zoom') {
        const d = this.drag, x0 = R.x + Math.min(d.fx0, d.fx1) * R.w, y0 = R.y + Math.min(d.fy0, d.fy1) * R.h;
        const w = Math.abs(d.fx1 - d.fx0) * R.w, h = Math.abs(d.fy1 - d.fy0) * R.h;
        ctx.fillStyle = 'rgba(255, 255, 255, 0.14)'; ctx.fillRect(x0, y0, w, h);
        ctx.setLineDash([4, 3]); ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.strokeRect(x0 + 0.5, y0 + 0.5, w, h);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, y0 + 0.5, w, h); ctx.setLineDash([]);
      }
      ctx.restore();
      // label of the vertical marker, above the plot
      if (mx >= R.x - 0.5 && mx <= R.x + R.w + 0.5) {
        const txt = KEY_SHORT[hk] + ' ' + fmtNum(S[hk]) + (hk === 't' ? ' ms' : '');
        ctx.font = FONT_B; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        const tw = ctx.measureText(txt).width;
        ctx.fillStyle = COL[hk]; ctx.fillText(txt, clamp(mx, R.x + tw / 2, R.x + R.w - tw / 2), R.y - 6);
        ctx.font = FONT;
      }

      this.drawColourBar(ctx, R, img);
      this.elReset.disabled = !this.zoom;
    }

    /** Striped strips along the left and right edge of a section where the filter window reaches past the first or
     *  last sample of the cube (the data are zero-padded there, so amplitudes are biased). */
    drawEdgeZone(ctx, R, Y, img) {
      const g = grid('t'), half = Math.abs(g.step) / 2, tA = g.first, tB = gridLast(g);
      const spans = [[Y(tA - half), Y(tA + img.edgeMs)], [Y(tB - img.edgeMs), Y(tB + half)]];
      for (const sp of spans) {
        const y0 = Math.max(R.y, Math.min(sp[0], sp[1])), y1 = Math.min(R.y + R.h, Math.max(sp[0], sp[1]));
        if (!(y1 - y0 > 1)) continue;
        for (const x of [R.x, R.x + R.w - 5]) {
          ctx.fillStyle = 'rgba(8, 16, 14, 0.75)'; ctx.fillRect(x, y0, 5, y1 - y0);
          ctx.fillStyle = COL.t;
          for (let y = Math.ceil(y0 / 6) * 6; y < y1 - 1; y += 6) ctx.fillRect(x, y, 5, 2);
        }
      }
    }
    /** Short notices inside the plot (bottom left): things that change how the picture should be read. */
    drawNotes(ctx, R, img) {
      const notes = [];
      if (img.preview) notes.push('preview while moving');
      if (img.vKey === 't') {
        if (img.vAxis.f > 1) notes.push('rows = mean of ' + img.vAxis.f + ' samples: >' + fmtNum(roundTo(500 / (img.vAxis.f * META.dt_ms), 0)) + ' Hz attenuated');
        else {
          const perPx = img.vAxis.m / (R.h * this.dpr);              // samples per device pixel row
          // the data are complete (the read-out gives true samples) but the screen cannot draw them all
          if (perPx > 1.5) notes.push('screen: ' + perPx.toFixed(1) + ' samples per pixel row, above ≈' + fmtNum(roundTo(500 / (perPx * META.dt_ms), 0)) + ' Hz is not resolved' +
            (img.signed && S.cmS === 'seismic' ? ' (± blends to purple)' : '') + '; zoom in');
        }
        if (img.edgeMs > 0) notes.push('striped margin: filter edge zone, ' + fmtNum(img.edgeMs) + ' ms (zero padding)');
      } else if (this.inEdgeZone(img.info.t)) notes.push('inside the filter edge zone (zero padding): biased');
      if (!notes.length || R.h < 90) return;
      ctx.font = FONT; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      let y = R.y + R.h - 6;
      for (let i = notes.length - 1; i >= 0; i--) {
        const tw = Math.min(ctx.measureText(notes[i]).width, R.w - 22);
        ctx.fillStyle = 'rgba(8, 16, 14, 0.78)'; ctx.fillRect(R.x + 8, y - 11, tw + 8, 14);
        ctx.fillStyle = COL.ink2; ctx.fillText(notes[i], R.x + 12, y, R.w - 22);
        y -= 15;
      }
    }

    drawColourBar(ctx, R, img) {
      const isMap = this.key === 'map';
      const x = R.x + R.w + 10, w = 12;
      const y0 = R.y + (isMap && R.h > 150 ? 54 : 0), h = R.y + R.h - y0;
      const name = img.signed ? S.cmS : S.cmU, pol = S.pol < 0 ? -1 : 1;
      const steps = Math.max(2, Math.round(h));
      for (let i = 0; i < steps; i++) {
        const u = 1 - i / (steps - 1);                                   // 1 at the top
        const c = cmapRGB(name, img.signed ? (u * 2 - 1) * pol : u, img.signed);
        ctx.fillStyle = 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
        ctx.fillRect(x, y0 + i * h / steps, w, h / steps + 0.6);
      }
      ctx.strokeStyle = COL.frame; ctx.lineWidth = 1; ctx.strokeRect(x - 0.5, y0 - 0.5, w + 1, h + 1);
      const top = img.vmax / S.gain;
      ctx.font = FONT; ctx.fillStyle = COL.ink2; ctx.textAlign = 'left';
      ctx.textBaseline = 'top'; ctx.fillText((img.signed ? '+' : '') + fmtVal(top), x + w + 4, y0 - 1);
      ctx.textBaseline = 'alphabetic'; ctx.fillText(img.signed ? '−' + fmtVal(top) : '0', x + w + 4, y0 + h + 1);
      if (img.signed && h > 60) { ctx.textBaseline = 'middle'; ctx.fillText('0', x + w + 4, y0 + h / 2); }
      // unit, written along the bar (between the end labels; for signed data between "+max" and "0")
      if (h > (img.signed ? 190 : 110)) {
        ctx.save(); ctx.translate(x + w + 6, y0 + h / 2); ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = COL.muted;
        ctx.fillText(String(img.unit), img.signed ? h / 4 : 0, 0);
        ctx.restore();
      }
    }

    drawMapFurniture(ctx, R, img, titleY) {
      // north arrow in the right gutter, direction computed from the survey vectors
      const n = ORIENT.north, cx = R.x + R.w + 34, cy = R.y + (R.h > 150 ? 26 : -4), L = 12;
      if (R.h > 150) {
        const dx = n[0], dy = -n[1];                                   // canvas y points down
        const hx = cx + dx * L, hy = cy + dy * L, tx = cx - dx * L, ty = cy - dy * L;
        ctx.strokeStyle = COL.ink; ctx.fillStyle = COL.ink; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(hx + dx * 3, hy + dy * 3);
        ctx.lineTo(hx - dx * 5 - dy * 4.5, hy - dy * 5 + dx * 4.5); ctx.lineTo(hx - dx * 5 + dy * 4.5, hy - dy * 5 - dx * 4.5); ctx.closePath(); ctx.fill();
        ctx.font = FONT_B; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('N', cx + dx * (L + 11), cy + dy * (L + 11));
        ctx.font = FONT; ctx.lineWidth = 1;
      }
      // scale bar, true to the (isotropic) map scale
      const metresAcross = img.hAxis.m * img.hAxis.f * Math.abs(img.hAxis.dv) * metresPerLine(img.hKey);
      const len = niceScaleLength(metresAcross * 0.28);
      if (len > 0) {
        const label = len >= 1000 ? fmtNum(len / 1000) + ' km' : fmtNum(len) + ' m';
        const px = len / metresAcross * R.w, y = titleY - 4;
        ctx.font = FONT;
        // keep clear of the centred axis title: a narrow (letterboxed) map has free room to its right
        const need = R.x + R.w / 2 + ctx.measureText(KEY_NAME[img.hKey] + ' number').width / 2 + 14 + ctx.measureText(label).width + 6 + px;
        let x1 = R.x + R.w;
        if (x1 < need) x1 = Math.min(this.cssW - 4, need);
        if (x1 >= need - 0.5) {
          const x0 = x1 - px;
          ctx.strokeStyle = COL.ink; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(x0, y - 4); ctx.lineTo(x0, y + 0.5); ctx.lineTo(x1, y + 0.5); ctx.lineTo(x1, y - 4); ctx.stroke();
          ctx.lineWidth = 1; ctx.fillStyle = COL.ink; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
          ctx.fillText(label, x0 - 6, titleY);
        }
      }
    }

    /* ---------- interaction ---------- */
    /** Canvas position (CSS px) -> fractions of the plot rectangle. */
    posAt(x, y) {
      const R = this.rect; if (!R || !this.img) return null;
      return { x, y, fx: (x - R.x) / R.w, fy: (y - R.y) / R.h, inside: x >= R.x && x <= R.x + R.w && y >= R.y && y <= R.y + R.h };
    }
    evtPos(e) {
      const b = this.canvas.getBoundingClientRect();
      this.ptr = { x: e.clientX - b.left, y: e.clientY - b.top };
      return this.posAt(this.ptr.x, this.ptr.y);
    }
    onDown(e) {
      if (e.button !== 0) return;
      const p = this.evtPos(e); if (!p || !p.inside) return;
      try { this.canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      e.preventDefault();
      if (e.shiftKey) this.drag = { mode: 'zoom', fx0: p.fx, fy0: p.fy, fx1: p.fx, fy1: p.fy };
      else { this.drag = { mode: 'pick' }; this.pick(p); }
      this.invalidate();
    }
    onMove(e) {
      const p = this.evtPos(e); if (!p) return;
      if (this.drag) {
        if (this.drag.mode === 'zoom') { this.drag.fx1 = clamp(p.fx, 0, 1); this.drag.fy1 = clamp(p.fy, 0, 1); this.invalidate(); }
        else this.pick(p);
      }
      this.hover(p);
    }
    onUp(e) {
      const d = this.drag; this.drag = null;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (d && d.mode === 'zoom') this.finishZoom(d);
      this.invalidate();
    }
    pick(p) {
      const img = this.img, fx = clamp(p.fx, 0, 1), fy = clamp(p.fy, 0, 1);
      // the sample under the pointer, never outside the image window (the last block may be partial)
      setPos({ [img.hKey]: axisFracToSampleValue(img.hAxis, fx), [img.vKey]: axisFracToSampleValue(img.vAxis, fy) }, DEBOUNCE_MS, true);
    }
    finishZoom(d) {
      const img = this.img, R = this.rect; if (!img || !R) return;
      if (Math.abs(d.fx1 - d.fx0) * R.w < 6 || Math.abs(d.fy1 - d.fy0) * R.h < 6) return;
      const rng = (ax, key, f0, f1) => { const g = grid(key); return snapRange(axisFracToSampleValue(ax, f0), axisFracToSampleValue(ax, f1), g.first, g.step, g.n, 4); };
      S.zoom[this.key] = { [img.hKey]: rng(img.hAxis, img.hKey, d.fx0, d.fx1), [img.vKey]: rng(img.vAxis, img.vKey, d.fy0, d.fy1) };
      this.afterZoom();
    }
    resetZoom() {
      if (!this.zoom) return;
      S.zoom[this.key] = null;
      this.afterZoom();
    }
    afterZoom() {
      this.elReset.disabled = !this.zoom;
      this.schedule(0);
      if (this.key === 'il') scheduleSpectrum(0);
      saveHash();
    }
    hover(p) {
      const img = this.img;
      if (!p || !p.inside || !img) { if (!this.drag) this.elRead.textContent = HINT; return; }
      const hp = axisFracToPixel(img.hAxis, p.fx), vp = axisFracToPixel(img.vAxis, p.fy);
      const code = img.bytes[img.transposed ? hp * img.cols + vp : vp * img.cols + hp];
      const val = clamp(decodeValue(code, img.signed, img.vmax), -img.vmax, img.vmax);
      const hv = axisFracToSampleValue(img.hAxis, clamp(p.fx, 0, 1)), vv = axisFracToSampleValue(img.vAxis, clamp(p.fy, 0, 1));
      const part = (k, v) => KEY_SHORT[k] + ' ' + fmtNum(v) + (k === 't' ? ' ms' : '');
      const bits = [];
      if (this.key === 'il') bits.push('IL ' + img.info.line); else if (this.key === 'xl') bits.push('XL ' + img.info.line);
      if (this.key === 'map' && img.transposed) bits.push(part(img.hKey, hv), part(img.vKey, vv)); else if (this.key === 'map') bits.push(part(img.vKey, vv), part(img.hKey, hv));
      else bits.push(part(img.hKey, hv), part(img.vKey, vv));
      if (this.key === 'map') bits.push('TWT ' + fmtNum(img.info.t) + ' ms');
      const clipped = img.signed ? (code <= 1 || code >= 255) : code >= 255;
      let s = (img.unit === 'Hz' ? 'frequency ' : 'value ') + (clipped ? (val < 0 ? '≤ ' : '≥ ') : '≈ ') + fmtVal(val) + (img.unit === 'Hz' ? ' Hz' : '');
      // read-out accuracy: lossless PNG is exact to half a grey level; JPEG is typically within 2 % of the scale
      // (more right next to a very strong event)
      const tol = img.lossless ? img.vmax * (img.signed ? 0.004 : 0.002) : img.vmax * 0.02;
      s += clipped ? ' (clipped at the colour-scale limit)' : ' ± ' + fmtVal(tol) + (img.lossless ? ' (8-bit, lossless)' : ' (8-bit JPEG, typical)');
      if (img.hAxis.f > 1 || img.vAxis.f > 1) s += ', mean of ' + img.hAxis.f + ' × ' + img.vAxis.f + ' samples';
      if (img.edgeMs > 0 && this.inEdgeZone(img.vKey === 't' ? vv : img.info.t)) s += ', in the filter edge zone';
      bits.push(s);
      this.elRead.textContent = bits.join(' · ');
    }
  }

  function metresPerLine(key) {             // metres per unit of line NUMBER (the vectors are per stored step)
    const v = key === 'il' ? META.il_axis_m : META.xl_axis_m, step = key === 'il' ? META.il_step : META.xl_step;
    return (Math.hypot(v[0], v[1]) || 1) / Math.abs(step || 1);
  }
  function hairline(ctx, x0, y0, x1, y1, colour) {
    const r = (v) => Math.floor(v) + 0.5;
    const ax = x0 === x1 ? r(x0) : x0, bx = x0 === x1 ? r(x1) : x1, ay = y0 === y1 ? r(y0) : y0, by = y0 === y1 ? r(y1) : y1;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)'; ctx.lineWidth = 3.5; ctx.stroke();
    ctx.strokeStyle = colour; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.lineWidth = 1;
  }
  function describeInfo(info) {
    let s = ATTR_NAME[info.attr] || String(info.attr);
    if (info.attr === 'rms' && info.win_ms != null) s += ', ' + fmtNum(info.win_ms) + ' ms window';
    const b6 = Array.isArray(info.band6) && info.band6.length === 2 ? info.band6 : null;
    if (info.attr === 'sd' && info.f0 != null) {
      s += ' at ' + fmtNum(info.f0) + ' Hz';
      if (b6) s += ' (a band, not one frequency: ' + fmtNum(roundTo(b6[0], 0)) + '–' + fmtNum(roundTo(b6[1], 0)) + ' Hz at −6 dB)';
    }
    if (info.flo != null && info.fhi != null) s += ' · band-pass ' + fmtNum(info.flo) + '–' + fmtNum(info.fhi) + ' Hz';
    else if (info.fhi != null) s += ' · low-pass ' + fmtNum(info.fhi) + ' Hz';
    else if (info.flo != null) s += ' · high-pass ' + fmtNum(info.flo) + ' Hz';
    if (info.attr !== 'sd' && (info.flo != null || info.fhi != null) && info.taps > 0) {
      s += ' (' + info.taps + ' taps, slopes ±' + fmtNum(roundTo(transitionHz(info.taps, META.dt_ms) / 2, 1)) + ' Hz';
      // the corner frequencies are the -6 dB points by design; say so when the filter could not reach them
      // (a real band that starts at 0 Hz means the low cut did not happen at all, however small the difference)
      if (b6 && ((info.flo != null && (Math.abs(b6[0] - info.flo) > 0.5 || b6[0] === 0)) || (info.fhi != null && Math.abs(b6[1] - info.fhi) > 0.5)))
        s += '; real −6 dB band ' + fmtNum(roundTo(b6[0], 1)) + '–' + fmtNum(roundTo(b6[1], 1)) + ' Hz';
      s += ')';
    }
    return s;
  }

  /** Greyscale image blob -> Uint8 codes (red channel). */
  async function decodeGrey(blob) {
    let bmp;
    if (window.createImageBitmap) {
      try { bmp = await createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' }); }
      catch (e) { bmp = await createImageBitmap(blob); }
    } else {
      bmp = await new Promise((resolve, reject) => {
        const im = new Image(), u = URL.createObjectURL(blob);
        im.onload = () => { URL.revokeObjectURL(u); resolve(im); };
        im.onerror = () => { URL.revokeObjectURL(u); reject(new Error('decode')); };
        im.src = u;
      });
    }
    const w = bmp.width, h = bmp.height;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const cx = c.getContext('2d', { willReadFrequently: true });
    cx.drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    const d = cx.getImageData(0, 0, w, h).data, out = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = d[j];
    return { bytes: out, cols: w, rows: h };
  }

  /* ======================= State changes ======================= */
  function setPos(p, delay, live) {
    const ch = {};
    for (const k of ['il', 'xl', 't']) {
      if (!(k in p) || !Number.isFinite(p[k])) continue;
      const v = snap(k, p[k]);
      if (v !== S[k]) { S[k] = v; ch[k] = true; }
    }
    syncPos();
    if (!ch.il && !ch.xl && !ch.t) return;
    if (ch.il) { P.il.schedule(delay, live); scheduleSpectrum(live ? SETTLE_MS : delay + 80); }
    if (ch.xl) P.xl.schedule(delay, live);
    if (ch.t) P.map.schedule(delay, live);
    for (const k in P) P[k].invalidate();
    saveHash();
  }
  function syncPos() {
    for (const k of ['il', 'xl', 't']) {
      const rng = $(k + '-rng'), num = $(k + '-num'), v = String(S[k]);
      if (rng.value !== v) rng.value = v;
      if (num.value !== v) num.value = v;
      // "previous" = lower number, like the slider, also when line numbers decrease along the stored order
      const g = grid(k), i = gridIndex(k, S[k]), up = g.step > 0;
      $(k + '-prev').disabled = up ? i <= 0 : i >= g.n - 1; $(k + '-next').disabled = up ? i >= g.n - 1 : i <= 0;
    }
  }
  function refetchAll(delay) { for (const k in P) P[k].schedule(delay); scheduleSpectrum(delay); saveHash(); }
  function recolorAll() { for (const k in P) P[k].recolor(); saveHash(); }

  /* ======================= Controls ======================= */
  function initControls() {
    for (const k of ['il', 'xl', 't']) {
      const g = grid(k), rng = $(k + '-rng'), num = $(k + '-num');
      for (const el of [rng, num]) { el.min = Math.min(g.first, gridLast(g)); el.max = Math.max(g.first, gridLast(g)); el.step = Math.abs(g.step); }
      rng.addEventListener('input', () => setPos({ [k]: Number(rng.value) }, DEBOUNCE_MS, true));
      num.addEventListener('change', () => { const v = Number(num.value); if (num.value !== '' && Number.isFinite(v)) setPos({ [k]: v }, 0); else syncPos(); });
      $(k + '-prev').addEventListener('click', () => setPos({ [k]: S[k] - Math.abs(g.step) }, DEBOUNCE_MS, true));
      $(k + '-next').addEventListener('click', () => setPos({ [k]: S[k] + Math.abs(g.step) }, DEBOUNCE_MS, true));
    }
    const nyq = META.nyquist_hz;

    $('attr').addEventListener('change', () => { S.attr = $('attr').value; syncControls(); for (const k in P) P[k].invalidate(); refetchAll(0); });

    $('win').min = fmtNum(3 * META.dt_ms); $('win').step = fmtNum(META.dt_ms);
    $('win').addEventListener('change', () => {
      const v = Number($('win').value);
      S.win = Number.isFinite(v) && $('win').value !== '' ? clamp(v, 3 * META.dt_ms, 1000) : S.win;
      syncControls(); for (const k in P) P[k].invalidate();
      if (S.attr === 'rms') refetchAll(0); else saveHash();
    });

    const f0R = f0Range();                         // the server refuses frequencies it cannot decompose correctly
    for (const el of [$('f0'), $('f0-rng')]) { el.min = f0R[0]; el.max = f0R[1]; }
    S.f0 = clamp(S.f0, f0R[0], f0R[1]);
    const setF0 = (v, delay) => {
      if (Number.isFinite(v)) S.f0 = clamp(v, f0R[0], f0R[1]);
      syncControls(); drawSpectrum();
      if (S.attr === 'sd') refetchAll(delay); else saveHash();
    };
    $('f0').addEventListener('change', () => setF0($('f0').value === '' ? NaN : Number($('f0').value), 0));
    $('f0-rng').addEventListener('input', () => setF0(Number($('f0-rng').value), DEBOUNCE_MS));

    $('flo').max = fmtNum(nyq); $('fhi').max = fmtNum(nyq);
    const bandChanged = () => {
      S.flo = $('flo').value === '' ? NaN : Number($('flo').value);
      S.fhi = $('fhi').value === '' ? NaN : Number($('fhi').value);
      applyBand();
    };
    $('flo').addEventListener('change', bandChanged); $('fhi').addEventListener('change', bandChanged);
    $('bp-on').addEventListener('change', () => { S.bp = $('bp-on').checked; applyBand(); });
    for (const b of document.querySelectorAll('.preset')) {
      b.addEventListener('click', () => {
        if (b.dataset.band === 'full') { S.bp = false; S.flo = 0; S.fhi = nyq; }
        else { const v = b.dataset.band.split(',').map(Number); S.bp = true; S.flo = v[0]; S.fhi = Math.min(v[1], nyq); }
        applyBand();
      });
    }

    $('cmap').addEventListener('change', () => { if (isSigned(S.attr)) S.cmS = $('cmap').value; else S.cmU = $('cmap').value; recolorAll(); });
    $('pol').addEventListener('change', () => { S.pol = $('pol').checked ? -1 : 1; recolorAll(); });
    $('gain').addEventListener('input', () => { S.gain = Math.pow(2, Number($('gain').value)); syncGain(); recolorAll(); });
    $('gain-reset').addEventListener('click', () => { S.gain = 1; syncGain(); recolorAll(); });
    syncControls(); syncPos();
  }

  /** Validate the band-pass fields, show a message, and refetch when the effective filter changed. */
  function applyBand() {
    syncControls();
    const sig = JSON.stringify(band());            // an invalid band counts as "no filter" until it is fixed
    if (sig !== lastBand) { lastBand = sig; refetchAll(0); } else { drawSpectrum(); saveHash(); }
  }

  function syncGain() {
    $('gain').value = String(roundTo(Math.log2(S.gain), 3));
    $('gain-out').textContent = S.gain.toFixed(2) + '×';
  }
  function syncControls() {
    const nyq = META.nyquist_hz, signed = isSigned(S.attr);
    $('attr').value = S.attr;
    $('ctl-win').hidden = S.attr !== 'rms'; $('ctl-f0').hidden = S.attr !== 'sd';
    if ($('leg-sd')) $('leg-sd').hidden = S.attr !== 'sd';
    $('win').value = fmtNum(S.win);
    $('f0').value = fmtNum(S.f0); $('f0-rng').value = fmtNum(S.f0);
    $('bp-on').checked = S.bp;
    if (document.activeElement !== $('flo')) $('flo').value = Number.isFinite(S.flo) ? fmtNum(S.flo) : '';
    if (document.activeElement !== $('fhi')) $('fhi').value = Number.isFinite(S.fhi) ? fmtNum(S.fhi) : '';
    const b = band();
    for (const btn of document.querySelectorAll('.preset')) {
      let on;
      if (btn.dataset.band === 'full') on = !b;
      else { const v = btn.dataset.band.split(',').map(Number); on = !!b && b.flo === v[0] && b.fhi === v[1]; }
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    const scaleNote = 'One colour scale per setting for the whole cube (99.5th percentile of a fixed sample of traces): panels, lines and times are directly comparable.';
    let attrMsg = '';
    if (S.attr === 'ifreq') attrMsg = 'Rate of change of the phase of the analytic trace (mean of the two neighbouring one-sample phase steps), valid from 0 Hz to Nyquist. It jumps where the envelope is small; a band-pass gives a cleaner picture. Colour scale: 0 to the high corner, or ' + fmtNum(Math.min(nyq, 100)) + ' Hz.';
    else if (S.attr === 'sd') attrMsg = 'Amplitude in a band of about ±31 % around the chosen frequency (Gaussian window of 0.6 periods standard deviation; shaded on the spectrum), not at a single frequency. Where the spectrum falls steeply, part of the picture leaks in from below the band. ' + scaleNote + ' The scale differs between frequencies: read the colour bar.';
    else if (S.attr !== 'amp' || band()) attrMsg = scaleNote;
    $('attr-msg').textContent = attrMsg;
    const bandErr = S.bp ? validateBand(S.flo, S.fhi, nyq) : '';
    $('flo').setAttribute('aria-invalid', bandErr ? 'true' : 'false'); $('fhi').setAttribute('aria-invalid', bandErr ? 'true' : 'false');
    let msg = '';
    if (bandErr) msg = bandErr + ' No filter is applied until this is fixed.';
    else if (S.attr === 'sd' && S.bp) msg = 'Note: the band-pass is ignored for spectral decomposition.';
    else if (S.bp) {
      if (!b) msg = 'Corners at 0 Hz and Nyquist: full band, no filter applied.';
      else if (b.flo == null) msg = 'Low corner at 0 Hz: low-pass only.';
      else if (b.fhi == null) msg = 'High corner at Nyquist: high-pass only.';
    }
    $('bp-msg').dataset.base = msg;
    syncBandMsg();
    // colour maps offered depend on whether the data are signed
    const sel = $('cmap'), list = signed ? CMAPS_SIGNED : CMAPS_UNSIGNED, cur = signed ? S.cmS : S.cmU;
    if (sel.dataset.kind !== String(signed)) {
      sel.textContent = '';
      for (const name of list) { const o = document.createElement('option'); o.value = name; o.textContent = CMAPS[name].label; sel.appendChild(o); }
      sel.dataset.kind = String(signed);
    }
    sel.value = cur;
    $('pol').checked = S.pol < 0; $('pol').disabled = !signed;
    $('pol-wrap').classList.toggle('off', !signed);
    syncGain();
  }

  /** Band-pass message = validation text + a warning when the requested corners cannot be realised: the filter has
   *  at most max_taps coefficients, so its slopes are at least 3.3 / (max_taps * dt) wide (4.1 Hz at 4 ms). */
  function syncBandMsg() {
    const el = $('bp-msg'); let msg = el.dataset.base || '';
    const b = band(), sv = META.server || {};
    if (b && S.attr !== 'sd' && sv.max_taps > 0) {
      const tw = transitionHz(sv.max_taps, META.dt_ms), warn = [];
      if (b.flo != null && b.flo < tw / 2) warn.push('a low corner below ' + fmtNum(roundTo(tw / 2, 1)) + ' Hz does not remove 0 Hz');
      if (b.flo != null && b.fhi != null && b.fhi - b.flo < tw) warn.push('a band narrower than ' + fmtNum(roundTo(tw, 1)) + ' Hz comes out wider than asked');
      if (warn.length) msg += (msg ? ' ' : '') + 'The filter has at most ' + sv.max_taps + ' coefficients (slopes about ±' + fmtNum(roundTo(tw / 2, 1)) + ' Hz): ' + warn.join(', and ') + '. The panel subtitles show the band really applied.';
    }
    el.textContent = msg;
  }

  /* ======================= Spectrum chart ======================= */
  const SPEC = { seq: 0, ctrl: null, timer: 0, data: null, url: null, error: null, loading: false };
  function scheduleSpectrum(delay) {
    clearTimeout(SPEC.timer);
    SPEC.timer = setTimeout(fetchSpectrum, delay == null ? 200 : delay);
  }
  async function fetchSpectrum() {
    if (!META) return;
    const q = ['kind=il', 'line=' + S.il], z = S.zoom.il;
    if (z) q.push('a0=' + z.xl[0], 'a1=' + z.xl[1], 't0=' + fmtNum(z.t[0]), 't1=' + fmtNum(z.t[1]));
    const b = band();
    if (b) { if (b.flo != null) q.push('flo=' + fmtNum(b.flo)); if (b.fhi != null) q.push('fhi=' + fmtNum(b.fhi)); }
    const url = API + 'spectrum?' + q.join('&');
    if (url === SPEC.url && (SPEC.data || SPEC.loading)) { drawSpectrum(); return; }
    if (SPEC.ctrl) { try { SPEC.ctrl.abort(); } catch (e) { /* ignore */ } }
    const seq = ++SPEC.seq, ctrl = SPEC.ctrl = new AbortController();
    SPEC.url = url; SPEC.loading = true;
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      let j = null;
      try { j = await res.json(); } catch (e) { j = null; }
      if (seq !== SPEC.seq) return;
      if (!res.ok || !j || !Array.isArray(j.f_hz) || !Array.isArray(j.raw)) throw new Error(j && j.error ? j.error : 'HTTP ' + res.status);
      SPEC.data = j; SPEC.error = null; SPEC.loading = false;
      $('spec-msg').textContent = 'Mean spectrum of ' + (j.n_traces != null ? j.n_traces + ' traces' : 'the traces') + ' in the inline ' + S.il + ' window' + (S.zoom.il ? ' (zoomed)' : '') + '.';
    } catch (e) {
      if (seq !== SPEC.seq || (e && e.name === 'AbortError')) return;
      SPEC.loading = false; SPEC.url = null; SPEC.error = String(e && e.message ? e.message : e);
      $('spec-msg').textContent = 'Spectrum not available: ' + SPEC.error;
      clearTimeout(SPEC.timer); SPEC.timer = setTimeout(fetchSpectrum, 4000);          // quiet automatic retry
    }
    drawSpectrum();
  }
  function drawSpectrum() {
    const c = $('spec'), box = c.parentElement, W = box.clientWidth, H = box.clientHeight;
    if (!W || !H || !META) return;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    const R = { x: 30, y: 8, w: W - 30 - 10, h: H - 8 - 32 }, nyq = META.nyquist_hz, d = SPEC.data;
    let ymax = 1;
    if (d && Array.isArray(d.filtered)) for (const v of d.filtered) if (v > ymax) ymax = v;
    const X = (f) => R.x + f / nyq * R.w, Y = (a) => R.y + R.h - a / ymax * R.h;
    ctx.font = FONT; ctx.lineWidth = 1;
    ctx.fillStyle = COL.field; ctx.fillRect(R.x, R.y, R.w, R.h);
    // pass band
    const b = band();
    if (b) {
      const x0 = X(b.flo == null ? 0 : b.flo), x1 = X(b.fhi == null ? nyq : b.fhi);
      ctx.fillStyle = 'rgba(47, 203, 147, 0.16)'; ctx.fillRect(x0, R.y, x1 - x0, R.h);
      ctx.strokeStyle = 'rgba(47, 203, 147, 0.8)'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(Math.round(x0) + 0.5, R.y); ctx.lineTo(Math.round(x0) + 0.5, R.y + R.h);
      ctx.moveTo(Math.round(x1) + 0.5, R.y); ctx.lineTo(Math.round(x1) + 0.5, R.y + R.h); ctx.stroke(); ctx.setLineDash([]);
    }
    // grid and ticks
    ctx.strokeStyle = COL.grid; ctx.fillStyle = COL.ink2; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.beginPath();
    for (const f of niceTicks(0, nyq, R.w / 42, false)) {
      const x = Math.round(X(f)) + 0.5;
      ctx.moveTo(x, R.y); ctx.lineTo(x, R.y + R.h + 4);
      ctx.fillText(fmtNum(f), x, R.y + R.h + 6);
    }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const a of [0, 0.5, 1]) {
      const y = Math.round(Y(a)) + 0.5;
      ctx.moveTo(R.x - 4, y); ctx.lineTo(R.x + R.w, y);
      ctx.fillText(String(a), R.x - 6, y);
    }
    ctx.stroke();
    ctx.strokeStyle = COL.frame; ctx.strokeRect(R.x - 0.5, R.y - 0.5, R.w + 1, R.h + 1);
    ctx.fillStyle = COL.ink2; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillText('Frequency (Hz), 0 to Nyquist ' + fmtNum(nyq), R.x + R.w / 2, H - 3);
    // curves
    ctx.save(); ctx.beginPath(); ctx.rect(R.x, R.y, R.w, R.h); ctx.clip();
    const curve = (arr, colour, dash, lw) => {
      ctx.beginPath();
      for (let i = 0; i < d.f_hz.length && i < arr.length; i++) { const x = X(d.f_hz[i]), y = Y(arr[i]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); }
      ctx.setLineDash(dash); ctx.strokeStyle = colour; ctx.lineWidth = lw; ctx.stroke(); ctx.setLineDash([]);
    };
    if (d) {
      curve(d.raw, '#b9c4bf', [4, 3], 1.4);
      if (Array.isArray(d.filtered)) curve(d.filtered, COL.xl, [], 2);
    } else {
      ctx.fillStyle = COL.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(SPEC.error ? 'no spectrum' : 'loading…', R.x + R.w / 2, R.y + R.h / 2);
    }
    // spectral-decomposition band (-6 dB limits of the kernel actually used) and centre frequency
    if (S.attr === 'sd') {
      const inf = P.il && P.il.img ? P.il.img.info : null;
      const b6 = inf && inf.attr === 'sd' && inf.f0 === S.f0 && Array.isArray(inf.band6) ? inf.band6 : [0.69 * S.f0, 1.31 * S.f0];
      const xa = X(b6[0]), xb = X(Math.min(b6[1], nyq));
      ctx.fillStyle = 'rgba(240, 112, 58, 0.22)'; ctx.fillRect(xa, R.y, xb - xa, R.h);
      const x = Math.round(X(S.f0)) + 0.5;
      ctx.setLineDash([6, 3]); ctx.strokeStyle = COL.il; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, R.y); ctx.lineTo(x, R.y + R.h); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = FONT_B; ctx.fillStyle = COL.il; ctx.textBaseline = 'top';
      const right = x < R.x + R.w - 70; ctx.textAlign = right ? 'left' : 'right';
      ctx.fillText(fmtNum(roundTo(b6[0], 0)) + '–' + fmtNum(roundTo(b6[1], 0)) + ' Hz', x + (right ? 5 : -5), R.y + 3);
    }
    ctx.restore();
  }

  /* ======================= location.hash ======================= */
  let hashTimer = 0;
  function saveHash() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(() => {
      try {
        const o = { il: S.il, xl: S.xl, t: S.t, attr: S.attr, bp: S.bp ? 1 : 0, flo: Number.isFinite(S.flo) ? S.flo : '', fhi: Number.isFinite(S.fhi) ? S.fhi : '',
          win: S.win, f0: S.f0, cs: S.cmS, cu: S.cmU, pol: S.pol, gain: roundTo(S.gain, 4) };
        const z = S.zoom;
        if (z.il) o.zi = [z.il.xl[0], z.il.xl[1], z.il.t[0], z.il.t[1]].join(',');
        if (z.xl) o.zx = [z.xl.il[0], z.xl.il[1], z.xl.t[0], z.xl.t[1]].join(',');
        if (z.map) o.zm = [z.map.il[0], z.map.il[1], z.map.xl[0], z.map.xl[1]].join(',');
        const str = '#' + Object.keys(o).map((k) => k + '=' + encodeURIComponent(o[k]).replace(/%2C/g, ',')).join('&');
        if (str !== location.hash) history.replaceState(null, '', str);
      } catch (e) { /* the hash is a convenience only */ }
    }, 250);
  }
  function loadHash() {
    try {
      const h = location.hash.replace(/^#/, ''); if (!h) return;
      const o = {};
      for (const part of h.split('&')) { const i = part.indexOf('='); if (i > 0) o[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1)); }
      const num = (k) => (o[k] != null && o[k] !== '' && Number.isFinite(Number(o[k]))) ? Number(o[k]) : null;
      for (const k of ['il', 'xl', 't']) { const v = num(k); if (v != null) S[k] = snap(k, v); }
      if (Object.prototype.hasOwnProperty.call(ATTR_NAME, o.attr)) S.attr = o.attr;   // not "in": that accepts "toString"
      if (o.bp != null) S.bp = o.bp === '1';
      if (num('flo') != null) S.flo = num('flo');
      if (num('fhi') != null) S.fhi = num('fhi');
      if (num('win') != null) S.win = clamp(num('win'), 3 * META.dt_ms, 1000);
      if (num('f0') != null) { const r = f0Range(); S.f0 = clamp(num('f0'), r[0], r[1]); }
      if (CMAPS_SIGNED.includes(o.cs)) S.cmS = o.cs;
      if (CMAPS_UNSIGNED.includes(o.cu)) S.cmU = o.cu;
      if (num('pol') != null) S.pol = num('pol') < 0 ? -1 : 1;
      if (num('gain') != null) S.gain = clamp(num('gain'), 0.25, 8);
      const zr = (str, ka, kb) => {
        if (!str) return null;
        const v = str.split(',').map(Number);
        if (v.length !== 4 || v.some((x) => !Number.isFinite(x))) return null;
        const ga = grid(ka), gb = grid(kb);
        return { [ka]: snapRange(v[0], v[1], ga.first, ga.step, ga.n, 4), [kb]: snapRange(v[2], v[3], gb.first, gb.step, gb.n, 4) };
      };
      S.zoom.il = zr(o.zi, 'xl', 't'); S.zoom.xl = zr(o.zx, 'il', 't'); S.zoom.map = zr(o.zm, 'il', 'xl');
    } catch (e) { /* ignore a malformed hash */ }
  }

  /* ======================= Start-up ======================= */
  function fillHeader() {
    const M = META, gi = grid('il'), gx = grid('xl'), gt = grid('t');
    $('ds-name').textContent = M.name || 'Seismic cube';
    document.title = (M.name || 'Seismic cube') + ' – seismic viewer';
    $('ds-dims').textContent = M.n_il + ' inlines (' + gi.first + '–' + gridLast(gi) + ', step ' + gi.step + ') × ' + M.n_xl + ' crosslines (' + gx.first + '–' + gridLast(gx) +
      ', step ' + gx.step + ') × ' + M.n_t + ' samples (' + fmtNum(gt.first) + '–' + fmtNum(gridLast(gt)) + ' ms TWT, ' + fmtNum(M.dt_ms) + ' ms)';
    $('badge-synth').hidden = !M.synthetic;
    const a = $('ds-attr'); a.textContent = '';
    const bits = [];
    if (M.attribution) bits.push(String(M.attribution));
    if (M.licence) bits.push('Licence: ' + M.licence);
    a.appendChild(document.createTextNode(bits.join(' · ')));
    if (M.doi) {
      a.appendChild(document.createTextNode(bits.length ? ' · doi ' : 'doi '));
      const l = document.createElement('a'); l.href = 'https://doi.org/' + encodeURI(String(M.doi)); l.textContent = String(M.doi); l.rel = 'noopener noreferrer'; l.target = '_blank';
      a.appendChild(l);
    }
    const dl = $('survey-dl'); dl.textContent = '';
    const row = (k, v) => { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = k; dd.textContent = v; dl.appendChild(dt); dl.appendChild(dd); };
    row('CRS', M.crs || 'unknown');
    if (Array.isArray(M.origin_xy)) row('Origin X, Y', M.origin_xy.map((v) => Number(v).toFixed(2)).join(', '));
    row('Inline step', '[' + M.il_axis_m.join(', ') + '] m, towards ' + compassLetter(M.il_axis_m[0], M.il_axis_m[1]));
    row('Crossline step', '[' + M.xl_axis_m.join(', ') + '] m, towards ' + compassLetter(M.xl_axis_m[0], M.xl_axis_m[1]));
    row('Nyquist', fmtNum(M.nyquist_hz) + ' Hz');
    if (M.amp) row('Amplitude', 'min ' + fmtVal(M.amp.min) + ', max ' + fmtVal(M.amp.max) + ', rms ' + fmtVal(M.amp.rms) + ', p99.9 ' + fmtVal(M.amp.p999));
    if (M.server) row('Server', 'version ' + M.server.version + ', max ' + M.server.max_taps + ' taps');
    if (M.synthetic && M.truth) row('Synthetic truth', JSON.stringify(M.truth));
    $('text-header').textContent = Array.isArray(M.textual_header) ? M.textual_header.join('\n') : '';
    $('text-header').hidden = !(Array.isArray(M.textual_header) && M.textual_header.length);
  }

  async function start() {
    $('fatal').hidden = true;
    let meta;
    try {
      const res = await fetch(API + 'meta', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      meta = await res.json();
      for (const k of ['n_il', 'n_xl', 'n_t', 'il0', 'il_step', 'xl0', 'xl_step', 't0_ms', 'dt_ms']) if (!Number.isFinite(meta[k])) throw new Error('meta.json has no valid "' + k + '"');
    } catch (e) {
      $('fatal-msg').textContent = 'Could not load the survey description (/api/meta): ' + (e && e.message ? e.message : e) + '. The seismic viewer needs its back end on the Linux PC: start the app with ./start.sh (not a plain static server).';
      $('fatal').hidden = false;
      return;
    }
    if (!Number.isFinite(meta.nyquist_hz)) meta.nyquist_hz = 500 / meta.dt_ms;
    if (!Array.isArray(meta.il_axis_m)) meta.il_axis_m = [0, 1];
    if (!Array.isArray(meta.xl_axis_m)) meta.xl_axis_m = [1, 0];
    META = meta;
    ORIENT = mapOrientation(META.il_axis_m, META.xl_axis_m);
    const mid = (k) => { const g = grid(k); return g.first + Math.floor((g.n - 1) / 2) * g.step; };
    S.il = snap('il', mid('il')); S.xl = snap('xl', mid('xl')); S.t = snap('t', mid('t'));
    S.fhi = Math.min(60, META.nyquist_hz);
    loadHash();
    lastBand = JSON.stringify(band());
    fillHeader();
    for (const k of ['il', 'xl', 'map']) P[k] = new Panel(k);
    initControls();
    for (const k in P) { P[k].draw(); P[k].schedule(0); }
    scheduleSpectrum(50);
    if (window.ResizeObserver) new ResizeObserver(drawSpectrum).observe($('spec').parentElement);
    window.addEventListener('resize', () => { for (const k in P) P[k].resize(); drawSpectrum(); });
    window.addEventListener('hashchange', () => { loadHash(); syncControls(); syncPos(); lastBand = JSON.stringify(band()); for (const k in P) P[k].recolor(); refetchAll(0); });
    window.SV_DEBUG = { S, P, META, ORIENT, SPEC };            // for inspection from the console
    // what wells.js needs: state, panels, survey description, and a way to move the cross-hair and redraw
    window.SV = { S, P, META, ORIENT, setPos, redraw() { for (const k in P) P[k].invalidate(); } };
    window.dispatchEvent(new Event('sv-ready'));
  }
  $('fatal-retry').addEventListener('click', start);
  start();
})();
