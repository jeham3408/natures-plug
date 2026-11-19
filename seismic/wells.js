/* wells.js - wells, logs, well tie and followed events on top of the seismic viewer (app.js).
 *
 * app.js exposes window.SV (state, panels, survey description, setPos, redraw) and calls SVWells.draw() from
 * every panel. Everything here is drawn on top of the seismic; nothing changes the seismic images.
 *
 * What is measured and what is not:
 *  - time-depth "dataset": one-way times delivered with the dataset. "sonic" / "trend": NOT calibrated, see the
 *    note shown for the well. The bulk shift slider moves logs and tops in time and is never applied silently.
 *  - density marked "Gardner" is estimated from the sonic log, not logged.
 *  - followed events come from a simple autotracker and must be checked on the sections.
 */
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const TOP_COL = { no: '#c9d4d0', ho: '#ff9de1', gc: '#5dff8f', hd: '#5dff8f', l1: '#9fb0aa', l2: '#9fb0aa', ro: '#ffb000', sh: '#8fc7ff' };
  const GREEN = (k) => k === 'gc' || k === 'hd';              // the green clay: predicted top (gc) or the formation itself (hd)
  const HOR_COLS = ['#5dff8f', '#ffb000', '#ff9de1', '#8fc7ff', '#ffffff', '#ff6b6b'];
  const LOGS = { gr: ['Gamma ray', 'API'], vp: ['P velocity', 'm/s'], ai: ['Acoustic impedance', 'm/s·g/cm³'], rdep: ['Deep resistivity', 'Ω·m'],
    rho_used: ['Density', 'g/cm³'], vpvs: ['Vp/Vs', ''] };
  const NODATA = -32768;
  const W = { ds: null, datasets: [], wells: [], sites: [], cur: -1, log: 'gr', showTops: true, shift: {}, horizons: [], f: 25, pol: 1, phase: 0, wavelet: 'ricker', tied: {},
    tieRange: null, mapTop: -1, mapBase: -1, vInt: null, pred: null, predProp: 'none', predSet: null };
  let SV = null, API = 'api/', loadSeq = 0;

  /* ---------- small helpers ---------- */
  const fin = Number.isFinite;
  function pct(a, p) { const v = a.filter(fin).sort((x, y) => x - y); return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN; }
  function well() { return W.wells[W.cur] || null; }
  function shiftOf(w) { return W.shift[w.name] || 0; }
  function mPerLine(key) { const v = key === 'il' ? SV.META.il_axis_m : SV.META.xl_axis_m, st = key === 'il' ? SV.META.il_step : SV.META.xl_step; return Math.hypot(v[0], v[1]) / Math.abs(st); }
  function logRange(w, key) {
    w._rng = w._rng || {};
    if (!w._rng[key]) {
      let a = w.logs[key];
      if (key === 'rdep') a = a.map((v) => (fin(v) && v > 0 ? Math.log10(v) : NaN));
      w._rng[key] = [pct(a, 0.02), pct(a, 0.98)];
    }
    return w._rng[key];
  }
  function logVal(key, v) { return key === 'rdep' ? (fin(v) && v > 0 ? Math.log10(v) : NaN) : v; }
  /** Two-way time at a depth below the kelly bushing, from the time-depth relation of the well (straight lines between its points). */
  function twtOf(w, md) {
    const a = w.td.md, b = w.td.twt;
    if (!(md > a[0])) return b[0];
    for (let k = 1; k < a.length; k++) if (md <= a[k]) return b[k - 1] + (b[k] - b[k - 1]) * (md - a[k - 1]) / ((a[k] - a[k - 1]) || 1);
    return b[b.length - 1];
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  /* ---------- synthetic seismogram ---------- */
  function ricker(f, dtMs) {
    const half = Math.ceil(1500 / f / dtMs), w = [];
    for (let k = -half; k <= half; k++) { const a = Math.PI * f * k * dtMs / 1000, a2 = a * a; w.push((1 - 2 * a2) * Math.exp(-a2)); }
    return w;
  }
  /** Quadrature (Hilbert transform) of a short wavelet by a plain discrete Fourier transform. */
  function quadrature(w) {
    const n = w.length, re = new Float64Array(n), im = new Float64Array(n), out = new Float64Array(n);
    for (let k = 0; k < n; k++) { let a = 0, b = 0; for (let m = 0; m < n; m++) { const ph = -2 * Math.PI * k * m / n; a += w[m] * Math.cos(ph); b += w[m] * Math.sin(ph); } re[k] = a; im[k] = b; }
    for (let k = 0; k < n; k++) {                              // multiply by -i sgn(f)
      const sg = (k === 0 || (n % 2 === 0 && k === n / 2)) ? 0 : (k < n / 2 ? 1 : -1), a = re[k], b = im[k];
      re[k] = sg * b; im[k] = -sg * a;
    }
    for (let m = 0; m < n; m++) { let a = 0; for (let k = 0; k < n; k++) { const ph = 2 * Math.PI * k * m / n; a += re[k] * Math.cos(ph) - im[k] * Math.sin(ph); } out[m] = a / n; }
    return out;
  }
  /** The wavelet in use on the log time grid: Ricker, or the zero-phase wavelet with the spectrum of the seismic
   *  around the well (from prep_wells.py), rotated by the chosen constant phase. */
  function waveletFor(w) {
    const L = w.logs, key = W.wavelet + '|' + W.f + '|' + W.phase + '|' + w.name;
    if (W._wv && W._wv.key === key) return W._wv.w;
    let wv = (W.wavelet === 'seis' && w.wavelet && w.wavelet.dt === L.dt) ? w.wavelet.w.slice() : ricker(W.f, L.dt);
    if (W.phase) { const q = quadrature(wv), c = Math.cos(W.phase * Math.PI / 180), sn = Math.sin(W.phase * Math.PI / 180); wv = wv.map((v, k) => v * c - q[k] * sn); }
    W._wv = { key, w: wv };
    return wv;
  }
  /** Reflection coefficients from acoustic impedance on the log time grid, convolved with the wavelet. */
  function synthetic(w) {
    const L = w.logs, ai = L.ai, n = L.n, rc = new Float64Array(n);
    let k0 = 0, k1 = n - 1;
    while (k0 < n && !fin(ai[k0])) k0++;
    while (k1 > 0 && !fin(ai[k1])) k1--;
    let prev = NaN;                                             // short gaps in the impedance are bridged, not turned into reflectors
    for (let k = k0; k <= k1; k++) { const a = fin(ai[k]) ? ai[k] : prev; if (fin(prev) && fin(a) && a + prev > 0) rc[k - 1] = (a - prev) / (a + prev); if (fin(a)) prev = a; }
    const wv = waveletFor(w), h = (wv.length - 1) / 2, out = new Float64Array(n);
    for (let k = 0; k < n; k++) { let sm = 0; for (let m = -h; m <= h; m++) { const q = k - m; if (q >= 0 && q < n) sm += rc[q] * wv[m + h]; } out[k] = sm * W.pol; }
    return { syn: out, rc, k0, k1 };
  }
  /** Seismic trace value at time t (ms), linear interpolation. */
  function seisAt(w, t) {
    const M = SV.META, x = (t - M.t0_ms) / M.dt_ms, k = Math.floor(x), tr = w.seis.trace;
    if (k < 0 || k >= tr.length - 1) return NaN;
    return tr[k] + (tr[k + 1] - tr[k]) * (x - k);
  }
  /** Correlation between the synthetic (moved by `shift` ms) and the seismic trace, for log times between ta and tb
   *  (the tie window; times are the unshifted log times). Returns NaN with fewer than 20 samples. */
  function correlation(w, syn, shift, ta, tb) {
    const L = w.logs; let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0;
    const ka = Math.max(syn.k0, fin(ta) ? Math.ceil((ta - L.t0) / L.dt) : syn.k0), kb = Math.min(syn.k1, fin(tb) ? Math.floor((tb - L.t0) / L.dt) : syn.k1);
    for (let k = ka; k <= kb; k += 2) {                         // 4 ms steps: the seismic sampling
      const a = syn.syn[k], b = seisAt(w, L.t0 + k * L.dt + shift);
      if (!fin(a) || !fin(b)) continue;
      sx += a; sy += b; sxx += a * a; syy += b * b; sxy += a * b; n++;
    }
    if (n < 20) return NaN;
    const c = (sxy - sx * sy / n) / Math.sqrt((sxx - sx * sx / n) * (syy - sy * sy / n));
    return fin(c) ? c : NaN;
  }
  /** The window the tie is judged in, as unshifted log times: the clay interval by default. */
  function tieTimes(w) {
    const L = w.logs, a0 = L.t0, b0 = L.t0 + (L.n - 1) * L.dt;
    if (W.tieRange) return [Math.max(a0, W.tieRange[0]), Math.min(b0, W.tieRange[1])];
    let a = a0, b = b0;
    // the clay: Hordaland Group down to the Rogaland top where there is one, else the Rogaland Group
    const ho = w.tops.find((t) => t.key === 'ho'), ro = w.tops.find((t) => t.key === 'ro'), shT = w.tops.find((t) => t.key === 'sh');
    const up = ho || ro, lo = ho ? ro : shT;
    if (up) a = Math.max(a, up.twt - 60);
    if (up && lo) b = Math.min(b, lo.twt + 60);
    if (b - a < 250) { a = a0; b = Math.min(b0, a0 + 600); }    // little log over the clay: the first 600 ms that are logged
    return [a, b];
  }
  /** Best bulk shift between -40 and +40 ms inside the tie window. */
  function bestShift(w) {
    const syn = synthetic(w), [ta, tb] = tieTimes(w); let best = 0, bc = -2; const curve = [];
    for (let sh = -40; sh <= 40; sh += 2) { const c = correlation(w, syn, sh, ta, tb); curve.push([sh, c]); if (fin(c) && c > bc) { bc = c; best = sh; } }
    return { best, corr: bc, zero: correlation(w, syn, 0, ta, tb), curve, win: [ta, tb] };
  }

  /* ---------- logs predicted from seismic (predict_logs.py) ---------- */
  const PRED_NAME = { vp: 'P velocity', gr: 'Gamma ray', ai: 'Acoustic impedance' }, SET_NAME = { ncs: 'NCS foundation model', attr: 'classic attributes', time: 'time trend only' };
  function predSection(il) { const P = W.pred; if (!P || !P.sections) return null; return P.sections.find((q) => Math.abs(q.il - il) < 1e-6) || null; }
  function predUnit(key) { const p = W.pred && W.pred.props.find((q) => q.key === key); return p ? p.unit : ''; }
  /** The predicted section as a small image (one pixel per grid cell), cached per section, property and feature set. */
  function predImage(sec) {
    const key = W.predProp + ':' + W.predSet, g = sec.grids[key]; if (!g) return null;
    sec._img = sec._img || {};
    if (!sec._img[key]) {
      const vals = []; for (const row of g) for (const v of row) if (fin(v)) vals.push(v);
      const lo = pct(vals, 0.02), hi = pct(vals, 0.98), cv = document.createElement('canvas'); cv.width = sec.n_x; cv.height = sec.n_t;
      const c = cv.getContext('2d'), id = c.createImageData(sec.n_x, sec.n_t);
      for (let q = 0; q < sec.n_x; q++) for (let k = 0; k < sec.n_t; k++) {
        const v = g[q][k], o = (k * sec.n_x + q) * 4;
        if (!fin(v)) { id.data[o + 3] = 0; continue; }
        const col = viridis((v - lo) / (hi - lo || 1)); id.data[o] = col[0]; id.data[o + 1] = col[1]; id.data[o + 2] = col[2]; id.data[o + 3] = 255;
      }
      c.putImageData(id, 0, 0); sec._img[key] = { cv, lo, hi };
    }
    return sec._img[key];
  }
  function drawPrediction(panel, ctx, R, X, Y) {
    if (W.predProp === 'none' || panel.key !== 'il') return;
    const sec = predSection(SV.S.il); if (!sec) return;
    const im = predImage(sec); if (!im) return;
    const xa = X(sec.xl0 - 0.5 * sec.dxl), xb = X(sec.xl0 + (sec.n_x - 0.5) * sec.dxl), ya = Y(sec.t0 - 0.5 * sec.dt), yb = Y(sec.t0 + (sec.n_t - 0.5) * sec.dt);
    ctx.save(); ctx.globalAlpha = 0.62; ctx.imageSmoothingEnabled = true;
    if (xb >= xa) ctx.drawImage(im.cv, xa, ya, xb - xa, yb - ya);
    else { ctx.translate(xa, 0); ctx.scale(-1, 1); ctx.drawImage(im.cv, 0, ya, xa - xb, yb - ya); }   // crossline numbers run right to left
    ctx.restore();
    const txt = 'Predicted ' + PRED_NAME[W.predProp].toLowerCase() + ' from seismic (' + SET_NAME[W.predSet] + '): ' + Math.round(im.lo) + ' – ' + Math.round(im.hi) + ' ' + predUnit(W.predProp) + ', dark to light';
    ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    const tw = ctx.measureText(txt).width; ctx.fillStyle = 'rgba(8,16,14,.85)'; ctx.fillRect(R.x + 4, R.y + 4, tw + 10, 17); ctx.fillStyle = '#fde725'; ctx.fillText(txt, R.x + 9, R.y + 7);
  }
  function renderPred() {
    const box = $('wl-pred-msg'); if (!box) return;
    const P = W.pred, w = well();
    if (!(P && P.sections && P.sections.length)) { box.textContent = ''; return; }
    if (W.predProp === 'none') { box.textContent = ''; return; }
    const sec = w && P.sections.find((q) => q.well === w.name);
    const row = w && P.table.find((r) => r.well === w.name && r.prop === W.predProp);
    let h = sec ? 'Shown on inline ' + sec.il + ' (the inline through ' + esc(w.name) + '). ' : 'This well has no logs to learn from. ';
    if (row && row[W.predSet]) {
      const m = row[W.predSet], t = row.time;
      h += '<b>Blind test at ' + esc(w.name) + '</b> (the model never saw this well): correlation with the smoothed log ' + m.r.toFixed(2) + ', error ' + Math.round(m.rmse) + ' ' + esc(row.unit) +
        '. The time trend alone, without any seismic: ' + t.r.toFixed(2) + ' and ' + Math.round(t.rmse) + ' ' + esc(row.unit) + '. ' +
        (m.rmse < t.rmse ? 'Here the seismic lowers the error.' : 'Here the seismic does not beat the trend.') +
        (m.r_resid != null ? ' Of what the trend misses, the seismic part correlates ' + m.r_resid.toFixed(2) + '.' : '');
    }
    box.innerHTML = h + ' <span class="muted">' + esc(P.note || '') + '</span>';
  }

  /* ---------- drawing on the seismic panels ---------- */
  function draw(panel, ctx, R, X, Y, img) {
    if (!SV || !W.wells) return;
    const hk = img.hKey, vk = img.vKey, S = SV.S, M = SV.META;
    ctx.save();
    ctx.font = '600 11px system-ui, sans-serif';
    if (vk === 't') {
      const key = panel.key;                                   // 'il': an inline section, horizontal axis = crossline
      drawPrediction(panel, ctx, R, X, Y);
      // followed events
      for (const h of W.horizons) {
        if (h.hidden) continue;
        ctx.strokeStyle = h.color; ctx.lineWidth = 2.2; ctx.shadowColor = '#000'; ctx.shadowBlur = 3; ctx.beginPath();
        const nI = h.n_il, nX = h.n_xl; let pen = false, last = 0;
        if (key === 'il') {
          const i = Math.round((S.il - M.il0) / M.il_step); if (i < 0 || i >= nI) continue;
          for (let j = 0; j < nX; j++) {
            const v = h.grid[i * nX + j];
            if (v === NODATA) { pen = false; continue; }
            const x = X(M.xl0 + j * M.xl_step), y = Y(v * 0.25);
            if (pen && Math.abs(v - last) < 60) ctx.lineTo(x, y); else ctx.moveTo(x, y);
            pen = true; last = v;
          }
        } else {
          const j = Math.round((S.xl - M.xl0) / M.xl_step); if (j < 0 || j >= nX) continue;
          for (let i = 0; i < nI; i++) {
            const v = h.grid[i * nX + j];
            if (v === NODATA) { pen = false; continue; }
            const x = X(M.il0 + i * M.il_step), y = Y(v * 0.25);
            if (pen && Math.abs(v - last) < 60) ctx.lineTo(x, y); else ctx.moveTo(x, y);
            pen = true; last = v;
          }
        }
        ctx.stroke(); ctx.shadowBlur = 0;
      }
      // wells within reach of this section
      for (let n = 0; n < W.wells.length; n++) {
        const w = W.wells[n], dist = Math.abs(w[key] - S[key]) * mPerLine(key), cur = n === W.cur;
        if (dist > (cur ? 600 : 150)) continue;
        const x = X(w[hk]), sh = shiftOf(w), tdT = w.td.twt, y0 = Y(w.seabed_twt), y1 = Y(tdT[tdT.length - 1] + sh);
        if (x < R.x - 80 || x > R.x + R.w + 80) continue;
        ctx.lineWidth = cur ? 2 : 1.2; ctx.strokeStyle = '#000'; ctx.setLineDash(dist > 150 ? [5, 4] : []);
        ctx.beginPath(); ctx.moveTo(x + 1, y0); ctx.lineTo(x + 1, y1); ctx.stroke();
        ctx.strokeStyle = cur ? '#ffffff' : '#d7dfdc'; ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke(); ctx.setLineDash([]);
        const label = w.name + (dist > 12 ? '  (' + Math.round(dist) + ' m off this line)' : '');
        ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
        const tw = ctx.measureText(label).width; ctx.fillStyle = 'rgba(8,16,14,.82)'; ctx.fillRect(x + 4, Math.max(R.y, y0 - 17), tw + 8, 15);
        ctx.fillStyle = '#fff'; ctx.fillText(label, x + 8, Math.max(R.y + 14, y0 - 4));
        // log curve to the right of the well
        const L = w.logs, lk = W.log;
        if (L && lk !== 'none' && L[lk]) {
          const rg = logRange(w, lk), wd = 54, xa = x + 5, a = L[lk];
          ctx.fillStyle = 'rgba(8,16,14,.38)'; ctx.fillRect(xa, Y(L.t0 + sh), wd, Y(L.t0 + (L.n - 1) * L.dt + sh) - Y(L.t0 + sh));
          ctx.strokeStyle = '#ffe66b'; ctx.lineWidth = 1.2; ctx.beginPath(); let pen = false;
          const stepK = Math.max(1, Math.floor(L.n / 1500));
          for (let k = 0; k < L.n; k += stepK) {
            const v = logVal(lk, a[k]);
            if (!fin(v)) { pen = false; continue; }
            const px = xa + Math.min(1, Math.max(0, (v - rg[0]) / (rg[1] - rg[0] || 1))) * wd, py = Y(L.t0 + k * L.dt + sh);
            if (pen) ctx.lineTo(px, py); else ctx.moveTo(px, py); pen = true;
          }
          ctx.stroke();
          ctx.fillStyle = '#ffe66b'; ctx.textBaseline = 'top'; ctx.fillText(LOGS[lk][0], xa + 2, Math.min(R.y + R.h - 14, Y(L.t0 + (L.n - 1) * L.dt + sh) + 3));
        }
        // tops
        if (W.showTops) for (const t of w.tops) {
          const y = Y(t.twt + sh), c = TOP_COL[t.key] || '#fff';
          ctx.strokeStyle = c; ctx.lineWidth = GREEN(t.key) ? 2.4 : 1.6; ctx.beginPath(); ctx.moveTo(x - 16, y); ctx.lineTo(x + 16, y); ctx.stroke();
          if (cur || GREEN(t.key)) {
            ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
            const tw2 = ctx.measureText(t.name).width; ctx.fillStyle = 'rgba(8,16,14,.82)'; ctx.fillRect(x - 22 - tw2 - 4, y - 8, tw2 + 8, 15);
            ctx.fillStyle = c; ctx.fillText(t.name, x - 20, y);
          }
        }
      }
    } else {
      // map: well symbols
      for (let n = 0; n < W.wells.length; n++) {
        const w = W.wells[n], x = X(w[hk]), y = Y(w[vk]), cur = n === W.cur;
        ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(x, y, cur ? 7 : 5.5, 0, 6.3); ctx.fill();
        ctx.fillStyle = cur ? '#5dff8f' : '#fff'; ctx.beginPath(); ctx.arc(x, y, cur ? 5 : 3.5, 0, 6.3); ctx.fill();
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        const tw = ctx.measureText(w.name).width; ctx.fillStyle = 'rgba(8,16,14,.82)'; ctx.fillRect(x + 8, y - 8, tw + 8, 15);
        ctx.fillStyle = '#fff'; ctx.fillText(w.name, x + 12, y);
      }
    }
    ctx.restore();
  }

  /* ---------- tie panel ---------- */
  function drawTie() {
    const cv = $('wl-tie'), w = well(); if (!cv) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), cw = cv.clientWidth, ch = cv.clientHeight;
    if (!cw || !ch) return;
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cw, ch);
    ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = '#93a19b';
    if (!w || !w.logs || !w.logs.ai) { ctx.fillText(w ? 'This well has no sonic log, so no synthetic can be made. Tops are shown on the sections.' : 'Choose a well.', 10, 24); $('wl-corr').textContent = ''; return; }
    const L = w.logs, sh = shiftOf(w), syn = synthetic(w), [wa, wb] = tieTimes(w), ta = wa + sh - 60, tb = wb + sh + 60;
    const top = 34, bot = ch - 8, left = 44, Y = (t) => top + (t - ta) / (tb - ta) * (bot - top);
    const pts = (w.points || []).filter((p) => fin(p.smectite));
    const tracks = [['gr', 'Gamma ray'], ['vp', 'Vp']];
    if (L.vpvs) tracks.push(['vpvs', 'Vp/Vs']);                 // only where a shear sonic was logged
    if (pts.length) tracks.push(['smec', 'Smectite']);         // only where samples were measured
    tracks.push(['ai', 'Impedance'], ['syn', 'Synthetic'], ['seis', 'Seismic'], ['lc', 'Fit']);
    const pSec = W.pred && W.pred.sections && W.pred.sections.find((q) => q.well === w.name), pKey = W.predProp === 'none' ? 'vp' : W.predProp;
    const pCur = pSec && pSec.curves[pKey] && pSec.curves[pKey][W.predSet] ? pSec.curves[pKey] : null;
    if (pCur) tracks.push(['pred', 'Predicted ' + (pKey === 'gr' ? 'GR' : pKey === 'vp' ? 'Vp' : 'AI')]);
    const tw = (cw - left - 6) / tracks.length;
    if (tw < 66) for (const tr of tracks) tr[1] = { 'Gamma ray': 'GR', Impedance: 'AI', Synthetic: 'Synth.' }[tr[1]] || tr[1].replace('Predicted ', 'Pred. ');
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.strokeStyle = '#2b3a35';
    const stepT = (tb - ta) > 900 ? 200 : (tb - ta) > 400 ? 100 : 50;
    for (let t = Math.ceil(ta / stepT) * stepT; t <= tb; t += stepT) { const y = Y(t); ctx.fillStyle = '#93a19b'; ctx.fillText(String(t), left - 6, y); ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(cw - 6, y); ctx.stroke(); }
    ctx.save(); ctx.translate(10, (top + bot) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillStyle = '#c5d0cb'; ctx.fillText('Two-way time (ms)', 0, 0); ctx.restore();
    const kA = Math.max(0, Math.floor((ta - sh - L.t0) / L.dt)), kB = Math.min(L.n - 1, Math.ceil((tb - sh - L.t0) / L.dt));
    const synAbs = [], seisAbs = [];
    for (let k = kA; k <= kB; k++) { synAbs.push(Math.abs(syn.syn[k])); const b = seisAt(w, L.t0 + k * L.dt + sh); if (fin(b)) seisAbs.push(Math.abs(b)); }
    const sN = pct(synAbs, 0.98) || 1, eN = pct(seisAbs, 0.98) || 1;
    tracks.forEach(([key, title], ti) => {
      const x0 = left + ti * tw, x1 = x0 + tw - 6;
      ctx.fillStyle = '#0d1815'; ctx.fillRect(x0, top, x1 - x0, bot - top); ctx.strokeStyle = '#2b3a35'; ctx.strokeRect(x0 + 0.5, top + 0.5, x1 - x0 - 1, bot - top - 1);
      ctx.fillStyle = '#e8efec'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.font = '600 11px system-ui, sans-serif'; ctx.fillText(title, (x0 + x1) / 2, 13);
      ctx.save(); ctx.beginPath(); ctx.rect(x0, top, x1 - x0, bot - top); ctx.clip();
      // the tie window, shaded in every track
      ctx.fillStyle = 'rgba(47,203,147,.07)'; ctx.fillRect(x0, Y(wa + sh), x1 - x0, Y(wb + sh) - Y(wa + sh));
      if (key === 'syn' || key === 'seis') {
        const mid = (x0 + x1) / 2, amp = (x1 - x0) * 0.42;
        ctx.beginPath(); let pen = false; const pts = [];
        for (let k = kA; k <= kB; k++) {
          if (key === 'syn' && (k < syn.k0 || k > syn.k1)) { pen = false; continue; }
          const t = L.t0 + k * L.dt + sh, v = key === 'syn' ? syn.syn[k] / sN : seisAt(w, t) / eN;
          if (!fin(v)) { pen = false; continue; }
          const px = mid + Math.max(-1.2, Math.min(1.2, v)) * amp, py = Y(t); pts.push([px, py]);
          if (pen) ctx.lineTo(px, py); else ctx.moveTo(px, py); pen = true;
        }
        ctx.strokeStyle = key === 'syn' ? '#5dff8f' : '#e8efec'; ctx.lineWidth = 1.2; ctx.stroke();
        ctx.fillStyle = key === 'syn' ? 'rgba(93,255,143,.35)' : 'rgba(232,239,236,.3)';
        for (let p = 1; p < pts.length; p++) { const a = pts[p - 1], b = pts[p]; if (a[0] > mid || b[0] > mid) { ctx.beginPath(); ctx.moveTo(mid, a[1]); ctx.lineTo(Math.max(mid, a[0]), a[1]); ctx.lineTo(Math.max(mid, b[0]), b[1]); ctx.lineTo(mid, b[1]); ctx.fill(); } }
        ctx.strokeStyle = '#2b3a35'; ctx.beginPath(); ctx.moveTo(mid, top); ctx.lineTo(mid, bot); ctx.stroke();
      } else if (key === 'pred') {
        // the smoothed log (yellow) and what the model predicted for this well without having seen it (cyan)
        const all = pCur.log.concat(pCur[W.predSet]).filter(fin), lo = pct(all, 0.02), hi = pct(all, 0.98);
        for (const [arr, colr] of [[pCur.log, '#ffe66b'], [pCur[W.predSet], '#4fd8ff']]) {
          ctx.beginPath(); let pen = false;
          for (let k = 0; k < arr.length; k++) {
            const v = arr[k]; if (!fin(v)) { pen = false; continue; }
            const px = x0 + 3 + Math.min(1, Math.max(0, (v - lo) / (hi - lo || 1))) * (x1 - x0 - 6), py = Y(pSec.times[k]);
            if (pen) ctx.lineTo(px, py); else ctx.moveTo(px, py); pen = true;
          }
          ctx.strokeStyle = colr; ctx.lineWidth = 1.5; ctx.stroke();
        }
      } else if (key === 'smec') {
        // smectite measured on samples: a bar over the depth interval of a cuttings sample, a diamond at a core sample
        const px = (v) => x0 + 3 + Math.min(1, Math.max(0, v / 60)) * (x1 - x0 - 6);
        ctx.strokeStyle = '#2b3a35'; ctx.lineWidth = 1;
        for (const g of [20, 40]) { ctx.beginPath(); ctx.moveTo(px(g), top); ctx.lineTo(px(g), bot); ctx.stroke(); }
        ctx.strokeStyle = ctx.fillStyle = '#5dff8f';
        for (const p of pts) {
          const ya = Y(twtOf(w, p.md_top) + sh), yb = Y(twtOf(w, p.md_base) + sh), ym = (ya + yb) / 2, x = px(p.smectite);
          if (p.material === 'core') { ctx.beginPath(); ctx.moveTo(x, ym - 4.5); ctx.lineTo(x + 4.5, ym); ctx.lineTo(x, ym + 4.5); ctx.lineTo(x - 4.5, ym); ctx.closePath(); ctx.fill(); }
          else { ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, Math.min(ya, ym - 2)); ctx.lineTo(x, Math.max(yb, ym + 2)); ctx.stroke(); ctx.beginPath(); ctx.arc(x, ym, 2.6, 0, 6.3); ctx.fill(); }
        }
      } else if (key === 'lc') {
        // correlation in a sliding 200 ms window: where the tie holds and where it does not
        const mid = (x0 + x1) / 2, half = (x1 - x0) / 2 - 3;
        ctx.strokeStyle = '#2b3a35'; ctx.beginPath(); ctx.moveTo(mid, top); ctx.lineTo(mid, bot); ctx.stroke();
        for (let t = L.t0 + syn.k0 * L.dt + 100; t <= L.t0 + syn.k1 * L.dt - 100; t += 20) {
          const c = correlation(w, syn, sh, t - 100, t + 100); if (!fin(c)) continue;
          const y = Y(t + sh); if (y < top || y > bot) continue;
          ctx.fillStyle = c >= 0.5 ? '#2fcb93' : c >= 0 ? '#8aa39a' : '#f0703a';
          ctx.fillRect(Math.min(mid, mid + c * half), y - (bot - top) * 10 / (tb - ta), Math.abs(c * half), Math.max(2, (bot - top) * 20 / (tb - ta)));
        }
      } else {
        const a = L[key]; if (a) {
          const rg = logRange(w, key);
          ctx.beginPath(); let pen = false;
          for (let k = kA; k <= kB; k++) {
            const v = a[k]; if (!fin(v)) { pen = false; continue; }
            const px = x0 + 3 + Math.min(1, Math.max(0, (v - rg[0]) / (rg[1] - rg[0] || 1))) * (x1 - x0 - 6), py = Y(L.t0 + k * L.dt + sh);
            if (pen) ctx.lineTo(px, py); else ctx.moveTo(px, py); pen = true;
          }
          ctx.strokeStyle = '#ffe66b'; ctx.lineWidth = 1.2; ctx.stroke();
          if (key === 'ai' && L.rho_gardner) {                 // mark where the density is estimated, not logged
            ctx.fillStyle = 'rgba(240,112,58,.8)';
            for (let k = kA; k <= kB; k++) if (L.rho_gardner[k]) ctx.fillRect(x1 - 4, Y(L.t0 + k * L.dt + sh), 3, Math.max(1, (bot - top) / (kB - kA + 1)));
          }
        }
      }
      ctx.restore();
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#93a19b'; ctx.font = '10px system-ui, sans-serif';
      if (L[key]) { const rg = logRange(w, key), nf = (v) => (key === 'vpvs' ? v.toFixed(1) : String(Math.round(v))); ctx.fillText(nf(rg[0]) + ' – ' + nf(rg[1]) + ' ' + LOGS[key][1], (x0 + x1) / 2, 27); }
      else ctx.fillText(key === 'smec' ? '0 – 60 %, XRD' : key === 'syn' ? (W.wavelet === 'seis' && w.wavelet ? 'seismic wavelet, ' + w.wavelet.peak_hz + ' Hz' : 'Ricker ' + W.f + ' Hz') + (W.phase ? ', ' + W.phase + '°' : '')
        : key === 'seis' ? 'at the well' : key === 'pred' ? 'blind, cyan' : '−1 … +1', (x0 + x1) / 2, 27);
    });
    ctx.font = '600 10px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    for (const t of w.tops) {
      const y = Y(t.twt + sh); if (y < top || y > bot) continue;
      ctx.strokeStyle = TOP_COL[t.key] || '#fff'; ctx.lineWidth = GREEN(t.key) ? 2 : 1.2; ctx.setLineDash(t.key === 'gc' ? [6, 3] : []);
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(cw - 6, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = TOP_COL[t.key] || '#fff'; ctx.fillText(t.name, left + 4, y - 2);
    }
    const c = correlation(w, syn, sh, wa, wb), c0 = correlation(w, syn, 0, wa, wb), cAll = correlation(w, syn, sh);
    const f2 = (v) => (fin(v) ? v.toFixed(2) : 'n/a');
    $('wl-corr').innerHTML = 'Correlation in the tie window (' + Math.round(wa + sh) + '–' + Math.round(wb + sh) + ' ms, shaded): <b>' + f2(c) + '</b> at a shift of ' + (sh > 0 ? '+' : '') + sh + ' ms' +
      (sh ? ' (' + f2(c0) + ' without the shift)' : '') + '. Over the whole log: ' + f2(cAll) + '. ' +
      (W.tied[w.name] ? 'The shift was chosen by correlation between −40 and +40 ms; a neighbouring cycle can score almost as well, so check that the tops land on sensible events. ' : '') +
      (L.rho_gardner && L.rho_gardner.some(Boolean) ? 'Orange strip in the impedance track: density estimated from sonic (Gardner), not logged.' : '');
    const a = $('wl-win-a'), b = $('wl-win-b'); if (a && document.activeElement !== a) a.value = Math.round(wa + sh); if (b && document.activeElement !== b) b.value = Math.round(wb + sh);
  }

  /* ---------- followed events, blind check and clay thickness map ---------- */
  function horizonAt(h, w) {
    const M = SV.META, i = Math.round((w.il - M.il0) / M.il_step), j = Math.round((w.xl - M.xl0) / M.xl_step);
    if (i < 0 || j < 0 || i >= h.n_il || j >= h.n_xl) return NaN;
    const v = h.grid[i * h.n_xl + j]; return v === NODATA ? NaN : v * 0.25;
  }
  async function follow(seed, name, key) {
    const st = $('wl-track-msg'); st.textContent = 'Following the event through the cube… (a second or two; longer when the server is busy)';
    try {
      const res = await fetch(API + 'track?il=' + seed.il + '&xl=' + seed.xl + '&t=' + seed.t.toFixed(1), { cache: 'no-store' });
      if (!res.ok) { let m = 'HTTP ' + res.status; try { m = (await res.json()).error || m; } catch (e) { /* keep */ } throw new Error(m); }
      const info = JSON.parse(res.headers.get('X-SV-Info') || '{}'), grid = new Int16Array(await res.arrayBuffer());
      const h = { name, key, grid, n_il: info.n_il, n_xl: info.n_xl, info, color: HOR_COLS[W.horizons.length % HOR_COLS.length], from: seed.well || null };
      W.horizons.push(h);
      st.textContent = name + ': ' + info.polarity + ' at ' + info.seed_twt + ' ms followed over ' + Math.round(100 * info.picked / info.total) + ' % of the traces (' + info.ms + ' ms).';
      if (W.horizons.length >= 2 && W.mapTop < 0) { W.mapTop = W.horizons.length - 2; W.mapBase = W.horizons.length - 1; }
      renderHorizons(); SV.redraw(); drawClayMap();
    } catch (e) { st.textContent = 'Could not follow the event: ' + (e && e.message ? e.message : e); }
  }
  function renderHorizons() {
    const box = $('wl-hor'); let html = '';
    W.horizons.forEach((h, n) => {
      html += '<div class="wl-h"><span class="sw" style="background:' + h.color + '"></span><span class="nm">' + esc(h.name) + '</span>' +
        '<button type="button" data-hide="' + n + '">' + (h.hidden ? 'Show' : 'Hide') + '</button><button type="button" data-del="' + n + '">Remove</button></div>';
      // blind check: the same top in the other wells
      const rows = [];
      for (const w of W.wells) {
        if (h.from === w.name) continue;
        const t = w.tops.find((q) => q.key === h.key), v = horizonAt(h, w);
        if (!t) continue;
        rows.push('<tr><td>' + esc(w.name) + '</td><td>' + (fin(v) ? v.toFixed(0) + ' ms' : 'no pick') + '</td><td>' + (t.twt + shiftOf(w)).toFixed(0) + ' ms</td><td>' +
          (fin(v) ? ((v - t.twt - shiftOf(w)) > 0 ? '+' : '') + (v - t.twt - shiftOf(w)).toFixed(0) + ' ms' : '') + '</td></tr>');
      }
      if (rows.length) html += '<table class="wl-t"><tr><th>Other well</th><th>Followed event</th><th>Well top (' + esc(h.key === 'gc' ? 'predicted' : 'FactPages') + ')</th><th>Difference</th></tr>' + rows.join('') + '</table>';
    });
    box.innerHTML = html || '<p class="muted">Nothing followed yet.</p>';
    const opt = (sel) => W.horizons.map((h, n) => '<option value="' + n + '"' + (n === sel ? ' selected' : '') + '>' + esc(h.name) + '</option>').join('');
    $('wl-map-top').innerHTML = opt(W.mapTop); $('wl-map-base').innerHTML = opt(W.mapBase);
  }
  function viridis(t) {
    const s = [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]], x = Math.max(0, Math.min(1, t)) * 4, i = Math.min(3, Math.floor(x)), f = x - i;
    return [0, 1, 2].map((c) => Math.round(s[i][c] + (s[i + 1][c] - s[i][c]) * f));
  }
  /** Mean P velocity of the chosen well between two times (m/s), from its sonic log. */
  function intervalVelocity(w, t0, t1) {
    if (!w || !w.logs || !w.logs.vp) return NaN;
    const L = w.logs, sh = shiftOf(w); let s = 0, n = 0;
    for (let k = 0; k < L.n; k++) { const t = L.t0 + k * L.dt + sh; if (t >= t0 && t <= t1 && fin(L.vp[k])) { s += 1 / L.vp[k]; n++; } }
    return n > 10 ? n / s : NaN;
  }
  function drawClayMap() {
    const cv = $('wl-map'), msg = $('wl-map-msg'); if (!cv) return;
    const a = W.horizons[W.mapTop], b = W.horizons[W.mapBase], ctx = cv.getContext('2d');
    if (!a || !b || a === b) { cv.width = cv.clientWidth; cv.height = 40; ctx.clearRect(0, 0, cv.width, cv.height); msg.textContent = 'Follow two events (a top and a base) to get a thickness map between them.'; return; }
    const M = SV.META, nI = a.n_il, nX = a.n_xl, f = Math.max(1, Math.ceil(nX / 700)), mw = Math.floor(nX / f), mh = Math.floor(nI / f);
    // interval velocity from the chosen well, else 2000 m/s
    const w = well(), ta = w ? horizonAt(a, w) : NaN, tb = w ? horizonAt(b, w) : NaN;
    let v = fin(ta) && fin(tb) ? intervalVelocity(w, Math.min(ta, tb), Math.max(ta, tb)) : NaN, vsrc = 'mean sonic velocity of ' + (w ? w.name : '') + ' between the two events';
    if (!fin(v)) { v = 2000; vsrc = 'an assumed 2000 m/s (no sonic between the two events in the chosen well)'; }
    W.vInt = v;
    const th = new Float32Array(mw * mh); let vals = [];
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
      const k = (y * f) * nX + x * f, p = a.grid[k], q = b.grid[k];
      const d = (p === NODATA || q === NODATA) ? NaN : (q - p) * 0.25 / 2000 * v;
      th[y * mw + x] = d; if (fin(d) && d >= 0) vals.push(d);
    }
    const hi = pct(vals, 0.98) || 1;
    // canvas in metric proportions: crossline along x, inline along y
    const aspect = (nX * Math.abs(M.xl_step) * mPerLine('xl')) / (nI * Math.abs(M.il_step) * mPerLine('il'));
    const cw = cv.clientWidth, chh = Math.round(cw / aspect) + 34, dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.style.height = chh + 'px'; cv.width = Math.round(cw * dpr); cv.height = Math.round(chh * dpr);
    const off = document.createElement('canvas'); off.width = mw; off.height = mh;
    const id = off.getContext('2d').createImageData(mw, mh);
    for (let n = 0; n < mw * mh; n++) {
      const d = th[n], o = n * 4;
      if (!fin(d)) { id.data[o + 3] = 0; continue; }
      if (d < 0) { id.data[o] = 240; id.data[o + 1] = 112; id.data[o + 2] = 58; id.data[o + 3] = 255; continue; }   // the two events cross: not a thickness
      const c = viridis(d / hi); id.data[o] = c[0]; id.data[o + 1] = c[1]; id.data[o + 2] = c[2]; id.data[o + 3] = 255;
    }
    off.getContext('2d').putImageData(id, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cw, chh); ctx.fillStyle = '#0d1815'; ctx.fillRect(0, 0, cw, chh - 34);
    ctx.imageSmoothingEnabled = true; ctx.drawImage(off, 0, 0, cw, chh - 34);
    ctx.font = '600 11px system-ui, sans-serif';
    const rows = [];
    for (const ww of W.wells) {
      const x = (ww.xl - M.xl0) / M.xl_step / nX * cw, y = (ww.il - M.il0) / M.il_step / nI * (chh - 34);
      ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(x, y, 5.5, 0, 6.3); ctx.fill(); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(x, y, 3.5, 0, 6.3); ctx.fill();
      ctx.fillStyle = 'rgba(8,16,14,.82)'; const tw = ctx.measureText(ww.name).width; ctx.fillRect(x + 8, y - 8, tw + 8, 15); ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(ww.name, x + 12, y);
      const p = horizonAt(a, ww), q = horizonAt(b, ww), ta2 = ww.tops.find((t) => t.key === a.key), tb2 = ww.tops.find((t) => t.key === b.key);
      rows.push('<tr><td>' + esc(ww.name) + '</td><td>' + (fin(p) && fin(q) ? Math.round((q - p) / 2000 * v) + ' m' : 'no pick') + '</td><td>' + (ta2 && tb2 ? Math.round(tb2.md - ta2.md) + ' m' : 'not in the well tops') + '</td></tr>');
    }
    // colour bar
    const by = chh - 26; for (let x = 0; x < 180; x++) { const c = viridis(x / 179); ctx.fillStyle = 'rgb(' + c + ')'; ctx.fillRect(8 + x, by, 1, 10); }
    ctx.fillStyle = '#c5d0cb'; ctx.font = '11px system-ui, sans-serif'; ctx.textBaseline = 'top'; ctx.textAlign = 'left'; ctx.fillText('0 m', 8, by + 12); ctx.textAlign = 'right'; ctx.fillText(Math.round(hi) + ' m', 188, by + 12);
    ctx.textAlign = 'left'; ctx.fillStyle = '#f0703a'; ctx.fillRect(204, by, 10, 10); ctx.fillStyle = '#c5d0cb'; ctx.fillText('events cross (not a thickness)', 220, by - 1);
    msg.innerHTML = 'Thickness between <b>' + esc(a.name) + '</b> and <b>' + esc(b.name) + '</b>, time difference converted with ' + esc(vsrc) + ' (' + Math.round(v) + ' m/s, the same everywhere). ' +
      'Crossline runs left to right, inline top to bottom.' +
      '<table class="wl-t"><tr><th>Well</th><th>From the seismic</th><th>From the well tops</th></tr>' + rows.join('') + '</table>';
  }

  /* ---------- controls ---------- */
  function renderWell() {
    const w = well(), box = $('wl-info');
    if (!w) { box.innerHTML = '<p class="muted">No well of the atlas is chosen in this cube.</p>'; drawTie(); return; }
    const kind = w.td_label || { checkshot: 'Checkshot-corrected sonic log (measured)', calibrated: 'Sonic log tied to the dataset\'s depth–time picks', sonic: 'Sonic log, not calibrated', trend: 'Regional trend only' }[w.td_kind];

    let h = '<p><b>' + esc(w.name) + '</b>' + (w.field ? ' · ' + esc(w.field) : '') + ' · inline ' + w.il.toFixed(0) + ', crossline ' + w.xl.toFixed(0) + '</p>' +
      '<p class="wl-td wl-' + w.td_kind + '"><b>Time–depth: ' + kind + '.</b> ' + esc(w.td_note) + '</p>' +
      polarityNote() + '<p class="muted">Logs: ' + esc(w.log_source || 'none open') + '</p><div class="wl-tops">';
    for (const t of w.tops) h += '<div class="wl-top"><span class="sw" style="background:' + (TOP_COL[t.key] || '#fff') + '"></span><span class="nm">' + esc(t.name) + '</span><span class="num">' + Math.round(t.md) + ' m · ' + Math.round(t.twt + shiftOf(w)) + ' ms</span>' +
      '<button type="button" data-follow="' + t.key + '">Follow</button></div>';
    h += '</div>' + (w.tops_about ? '<p class="small muted">' + esc(w.tops_about) + '</p>' : '') + smectiteTable(w);
    box.innerHTML = h;
    $('wl-shift').value = shiftOf(w); $('wl-shift-out').textContent = (shiftOf(w) > 0 ? '+' : '') + shiftOf(w) + ' ms';
    $('wl-shift').disabled = false;
    drawTie();
  }
  /** What the documents of the survey say about polarity, what the sea bed shows, and what the synthetic uses. */
  function polarityNote() {
    const p = W.polInfo; if (!p) return '';
    const clash = p.documented != null && p.documented !== p.used, sb = p.seabed;
    let h = '<p class="wl-td' + (clash ? '' : ' wl-checkshot') + '"><b>Polarity' + (clash ? ': the data contradict the documents' : '') + '.</b> ';
    if (p.documented != null) h += 'The survey is documented as: a ' + (p.documented === -1 ? 'negative' : 'positive') + ' number is an increase in acoustic impedance' + (p.documented_note ? ' (' + esc(p.documented_note) + ')' : '') + '. ';
    if (sb) h += 'The sea bed, which is certain to be an increase, is a ' + (sb.positive_share >= 0.5 ? 'positive' : 'negative') + ' number in ' + Math.round(100 * Math.max(sb.positive_share, 1 - sb.positive_share)) + ' % of ' + sb.traces.toLocaleString('en') +
      ' traces. It arrives at ' + Math.round(sb.median_time) + ' ms and the water depth puts it at ' + Math.round(sb.t_expected) + ' ms. ';
    h += p.used === -1 ? 'The synthetic is therefore reversed.' : clash ? 'The synthetic is therefore not reversed. Tick Reverse polarity to see the documented convention.' : 'The synthetic is not reversed.';
    return h + '</p>';
  }
  /** Smectite measured on samples of the well, summed up per formation. */
  function smectiteTable(w) {
    const pts = (w.points || []).filter((p) => fin(p.smectite)); if (!pts.length) return '';
    const groups = [];
    for (const p of pts) { let g = groups.find((q) => q.name === p.formation); if (!g) { g = { name: p.formation, v: [], a: Infinity, b: -Infinity, core: 0 }; groups.push(g); } g.v.push(p.smectite); g.a = Math.min(g.a, p.md_top); g.b = Math.max(g.b, p.md_base); if (p.material === 'core') g.core++; }
    let h = '<h3>Smectite measured on samples</h3><table class="wl-t"><tr><th>Formation</th><th>Samples</th><th>Depth</th><th>Smectite</th></tr>';
    for (const g of groups) {
      const lo = Math.min.apply(null, g.v), hi = Math.max.apply(null, g.v);
      h += '<tr><td>' + esc(g.name) + '</td><td>' + g.v.length + (g.core ? ' (' + g.core + ' core)' : '') + '</td><td>' + Math.round(g.a) + '–' + Math.round(g.b) + ' m</td><td>' + (Math.round(lo) !== Math.round(hi) ? Math.round(lo) + '–' + Math.round(hi) : Math.round(lo)) + ' %</td></tr>';
    }
    return h + '</table><p class="small muted">' + esc(w.points_about || '') + ' Green marks in the tie panel: a bar spans a cuttings interval, a diamond is a core sample.</p>';
  }
  function setShift(v, auto) { const w = well(); if (!w) return; W.shift[w.name] = v; W.tied[w.name] = !!auto; renderWell(); renderHorizons(); SV.redraw(); }
  function gotoWell() { const w = well(); if (!w) return; const g = w.tops.find((t) => t.key === 'gc') || w.tops.find((t) => t.key === 'hd') || w.tops.find((t) => t.key === 'ro') || w.tops[0]; SV.setPos({ il: w.il, xl: w.xl, t: g ? g.twt + shiftOf(w) : SV.S.t }, 0, false); }

  /** Zoom both sections to the overburden of the chosen well (sea bed to a little below the Shetland top). */
  function zoomOverburden() {
    const w = well(), M = SV.META; if (!w) return;
    const sh = w.tops.find((t) => t.key === 'sh'), last = M.t0_ms + (M.n_t - 1) * M.dt_ms;
    const snapT = (v) => M.t0_ms + Math.round((Math.min(last, Math.max(M.t0_ms, v)) - M.t0_ms) / M.dt_ms) * M.dt_ms;
    const lastTop = w.tops.length ? Math.max.apply(null, w.tops.map((t) => t.twt)) : w.seabed_twt + 1100;
    const logEnd = w.logs ? w.logs.t0 + (w.logs.n - 1) * w.logs.dt : 0;                 // no Shetland top: show the logged interval
    const ta = snapT(w.seabed_twt - 80), tb = snapT((sh ? sh.twt : Math.max(lastTop, Math.min(logEnd, w.seabed_twt + 1500))) + shiftOf(w) + 220);
    SV.S.zoom.il = { xl: [M.xl0, M.xl0 + (M.n_xl - 1) * M.xl_step], t: [ta, tb] };
    SV.S.zoom.xl = { il: [M.il0, M.il0 + (M.n_il - 1) * M.il_step], t: [ta, tb] };
    SV.P.il.afterZoom(); SV.P.xl.afterZoom();
  }

  /** Listeners, bound once: the controls stay when the cube changes. */
  function setup() {
    SV = window.SV;
    const pp = $('wl-pred'), ps = $('wl-pred-set');
    const predChanged = () => {
      W.predProp = pp.value; W.predSet = ps.value || W.predSet;
      const w = well(), sec = w && W.pred && W.pred.sections && W.pred.sections.find((q) => q.well === w.name);
      if (W.predProp !== 'none' && sec && SV.S.il !== sec.il) SV.setPos({ il: sec.il }, 0, false);     // the prediction lives on the inline through the well
      renderPred(); drawTie(); SV.redraw();
    };
    pp.addEventListener('change', predChanged); ps.addEventListener('change', predChanged);
    $('wl-goto').addEventListener('click', gotoWell);
    $('wl-zoom').addEventListener('click', zoomOverburden);
    $('wl-log').addEventListener('change', (e) => { W.log = e.target.value; SV.redraw(); });
    $('wl-tops').addEventListener('change', (e) => { W.showTops = e.target.checked; SV.redraw(); });
    $('wl-shift').addEventListener('input', (e) => setShift(Number(e.target.value), false));
    $('wl-shift-0').addEventListener('click', () => setShift(0, false));
    $('wl-shift-best').addEventListener('click', () => { const w = well(); if (!w || !w.logs || !w.logs.ai) return; setShift(bestShift(w).best, true); });
    $('wl-f').addEventListener('input', (e) => { W.f = Number(e.target.value); $('wl-f-out').textContent = W.f + ' Hz'; drawTie(); });
    $('wl-wav').addEventListener('change', (e) => { W.wavelet = e.target.value; $('wl-f').disabled = W.wavelet !== 'ricker'; drawTie(); });
    $('wl-ph').addEventListener('input', (e) => { W.phase = Number(e.target.value); $('wl-ph-out').textContent = (W.phase > 0 ? '+' : '') + W.phase + '°'; drawTie(); });
    $('wl-pol').addEventListener('change', (e) => { W.pol = e.target.checked ? -1 : 1; drawTie(); });
    const winSet = () => { const w = well(); if (!w) return; const sh = shiftOf(w), a = Number($('wl-win-a').value) - sh, b = Number($('wl-win-b').value) - sh; if (fin(a) && fin(b) && b - a >= 100) { W.tieRange = [a, b]; drawTie(); } };
    $('wl-win-a').addEventListener('change', winSet); $('wl-win-b').addEventListener('change', winSet);
    $('wl-win-clay').addEventListener('click', () => { W.tieRange = null; drawTie(); });
    $('wl-win-all').addEventListener('click', () => { const w = well(); if (!w || !w.logs) return; W.tieRange = [w.logs.t0, w.logs.t0 + (w.logs.n - 1) * w.logs.dt]; drawTie(); });
    $('wl-f').disabled = W.wavelet !== 'ricker';
    $('wl-info').addEventListener('click', (e) => {
      const k = e.target && e.target.getAttribute && e.target.getAttribute('data-follow'); if (!k) return;
      const w = well(), t = w.tops.find((q) => q.key === k);
      follow({ il: w.il, xl: w.xl, t: t.twt + shiftOf(w), well: w.name }, t.name + ' from ' + w.name, k);
    });
    $('wl-follow-here').addEventListener('click', () => follow({ il: SV.S.il, xl: SV.S.xl, t: SV.S.t }, 'Event at IL ' + SV.S.il + ' XL ' + SV.S.xl + ' ' + SV.S.t + ' ms', 'free'));
    $('wl-hor').addEventListener('click', (e) => {
      const g = (a) => e.target && e.target.getAttribute && e.target.getAttribute(a);
      if (g('data-del') != null) { W.horizons.splice(Number(g('data-del')), 1); W.mapTop = Math.min(W.mapTop, W.horizons.length - 2); W.mapBase = Math.min(W.mapBase, W.horizons.length - 1); }
      else if (g('data-hide') != null) { const h = W.horizons[Number(g('data-hide'))]; h.hidden = !h.hidden; }
      else return;
      renderHorizons(); SV.redraw(); drawClayMap();
    });
    $('wl-map-top').addEventListener('change', (e) => { W.mapTop = Number(e.target.value); drawClayMap(); });
    $('wl-map-base').addEventListener('change', (e) => { W.mapBase = Number(e.target.value); drawClayMap(); });
    window.addEventListener('resize', () => { drawTie(); drawClayMap(); });
    window.addEventListener('sv-cube', loadCube);
  }

  /** Wells, bulk shifts and predictions of the cube that was just loaded. */
  async function loadCube() {
    API = window.SV_API || 'api/';
    const seq = ++loadSeq;
    W.wells = []; W.sites = []; W.cur = -1; W.horizons = []; W.shift = {}; W.tied = {}; W.tieRange = null; W.mapTop = W.mapBase = -1; W.pred = null; W._wv = null; W.polInfo = null;
    W.predProp = 'none'; $('wl-pred').value = 'none';
    renderWell(); renderHorizons(); drawClayMap(); renderPred();
    let j = null, pred = null;
    try { j = await (await fetch(API + 'wells', { cache: 'no-store' })).json(); } catch (e) { j = null; }
    try { pred = await (await fetch(API + 'pred', { cache: 'no-store' })).json(); } catch (e) { pred = null; }
    if (seq !== loadSeq) return;                                // another cube was asked for meanwhile
    W.wells = (j && j.wells) || []; W.sites = (j && j.gc_sites) || []; W.sources = (j && j.sources) || [];
    // polarity and wavelet start from what the cube itself shows: the sign of the sea bed where that was checked, and
    // the wavelet from the seismic where its spectrum peaks far above the 25 Hz Ricker (whitened data)
    W.polInfo = (j && j.polarity) || null;
    W.pol = W.polInfo && W.polInfo.used === -1 ? -1 : 1; $('wl-pol').checked = W.pol < 0;
    W.wavelet = W.wells.some((w) => w.wavelet && w.wavelet.peak_hz > 45) ? 'seis' : 'ricker'; $('wl-wav').value = W.wavelet; $('wl-f').disabled = W.wavelet !== 'ricker';
    W.pred = pred && pred.sections ? pred : null;
    W.predSet = W.pred && W.pred.sets && W.pred.sets.length ? (W.pred.sets.indexOf('ncs') >= 0 ? 'ncs' : W.pred.sets[0]) : null;
    const ps = $('wl-pred-set'), pp = $('wl-pred');
    ps.innerHTML = ((W.pred && W.pred.sets) || []).map((k) => '<option value="' + k + '"' + (k === W.predSet ? ' selected' : '') + '>' + esc(SET_NAME[k] || k) + '</option>').join('');
    pp.disabled = ps.disabled = !(W.pred && W.pred.sections.length);
    // every well with a sonic log gets the same rule: the bulk shift between -40 and +40 ms that correlates best in
    // its tie window, if that beats no shift by more than 0.05. The panel says so, and Zero removes it.
    for (const w of W.wells) {
      if (!(w.logs && w.logs.ai)) continue;
      if (w.td_kind === 'checkshot') { W.shift[w.name] = 0; continue; }   // a measured time-depth relation is not moved to fit
      W.cur = W.wells.indexOf(w); W._wv = null;
      const bs = bestShift(w);
      if (fin(bs.corr) && bs.corr > (fin(bs.zero) ? bs.zero : -1) + 0.05) { W.shift[w.name] = bs.best; W.tied[w.name] = true; } else W.shift[w.name] = 0;
    }
    const wi = W.wells.findIndex((w) => w.name === W.want);
    W.cur = W.wells.length ? Math.max(0, wi) : -1; W._wv = null;
    $('wl-src').textContent = (W.sources || []).join(' · ');
    renderWell(); renderHorizons(); drawClayMap(); renderPred();
    if (W.wells.length) { gotoWell(); zoomOverburden(); }
    SV.redraw();
    window.dispatchEvent(new CustomEvent('sv-wells', { detail: { ds: window.SV_DS, wells: W.wells.map((w) => w.name), well: well() ? well().name : null } }));
  }

  /** Make `name` the current well. Returns false when it is not in the cube shown (it is then chosen as soon as its
   *  cube has loaded). */
  function pick(name) {
    W.want = name;
    const n = W.wells.findIndex((w) => w.name === name);
    if (n < 0) return false;
    if (n !== W.cur) { W.cur = n; W.tieRange = null; W._wv = null; }
    renderWell(); renderPred(); drawClayMap(); gotoWell(); SV.redraw();
    return true;
  }

  window.SVWells = { draw, state: W, synthetic, correlation, bestShift, tieTimes, pick, current: () => well(),
    /** Redraw the tie and the clay map, for instance after their pane became visible. */
    refresh() { drawTie(); drawClayMap(); } };
  if (window.SV) setup(); else window.addEventListener('sv-ready', setup, { once: true });
})();
