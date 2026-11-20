/* whatif.js - "What if at this well": a small scenario calculation under the well tie (wells.js).
 *
 * The rock in one interval of the well is changed, a new synthetic is made, and the change is compared with what
 * the tie itself leaves unexplained (the misfit band). It is a calculation from the logs of one well. It does not
 * detect ductile clay, and it never changes the tie (shift, wavelet, window).
 *
 * Part 1 holds the calculation: no page access, also loaded by the tests under node (tests/whatif.test.mjs).
 * Part 2 is the panel in the page.
 *
 * What is done and why:
 *  - "Like the layer above" mirrors the logged samples above the top into the interval. The interval is NOT
 *    multiplied by a number: that keeps the interval's own layering and can leave a false step at its top.
 *  - A change in P velocity moves everything below it in time: dt = 2 dz (1/v_new - 1/v_old). The changed log is
 *    put back on the regular time grid before the synthetic is made. Density does not move time.
 *  - The misfit band: the logged synthetic is scaled to the seismic trace by least squares inside the tie window,
 *    and the RMS of what is left is divided by that scale, so it is in the units of the synthetic. It follows from
 *    the correlation alone, so it is given with a range (correlation one standard error down and up), and a change
 *    is read as larger or smaller only when the whole range agrees.
 *  - The chance level: a shift chosen by correlation finds some correlation on any trace. The synthetic is laid on
 *    the same trace at wrong times and searched the same way; a tie that does not beat that is said to be no better
 *    than chance, and then nothing is read as larger.
 */
'use strict';
(function () {
  /* ======================================================================================
   * 1. Calculation (no page access)
   * ==================================================================================== */
  const fin = Number.isFinite;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const MIN_ABOVE_M = 20, MIN_ABOVE_N = 10;                     // least log above the top for "like the layer above"

  /** Ricker wavelet, the same as in wells.js. */
  function ricker(f, dtMs) {
    const half = Math.ceil(1500 / f / dtMs), w = [];
    for (let k = -half; k <= half; k++) { const a = Math.PI * f * k * dtMs / 1000, a2 = a * a; w.push((1 - 2 * a2) * Math.exp(-a2)); }
    return w;
  }
  /** Quadrature (Hilbert transform) of a short wavelet by a plain discrete Fourier transform, as in wells.js. */
  function quadrature(w) {
    const n = w.length, re = new Float64Array(n), im = new Float64Array(n), out = new Float64Array(n);
    for (let k = 0; k < n; k++) { let a = 0, b = 0; for (let m = 0; m < n; m++) { const ph = -2 * Math.PI * k * m / n; a += w[m] * Math.cos(ph); b += w[m] * Math.sin(ph); } re[k] = a; im[k] = b; }
    for (let k = 0; k < n; k++) {
      const sg = (k === 0 || (n % 2 === 0 && k === n / 2)) ? 0 : (k < n / 2 ? 1 : -1), a = re[k], b = im[k];
      re[k] = sg * b; im[k] = -sg * a;
    }
    for (let m = 0; m < n; m++) { let a = 0; for (let k = 0; k < n; k++) { const ph = 2 * Math.PI * k * m / n; a += re[k] * Math.cos(ph) - im[k] * Math.sin(ph); } out[m] = a / n; }
    return out;
  }
  /** The wavelet turned by a constant phase (degrees), with the sign convention of wells.js. */
  function rotate(w, deg) {
    if (!deg) return Array.from(w);
    const q = quadrature(w), c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180);
    return Array.from(w, (v, k) => v * c - q[k] * s);
  }
  /** Synthetic from impedance on the regular time grid: the same rule as synthetic() in wells.js (short gaps are
   *  bridged), but samples outside the logged range are not a number, so they never count as a zero. */
  function trace(ai, wv, pol) {
    const n = ai.length, rc = new Float64Array(n), syn = new Float64Array(n).fill(NaN);
    let k0 = 0, k1 = n - 1;
    while (k0 < n && !fin(ai[k0])) k0++;
    while (k1 > 0 && !fin(ai[k1])) k1--;
    if (k0 > k1) return { syn, rc, k0, k1 };
    let prev = NaN;
    for (let k = k0; k <= k1; k++) { const a = fin(ai[k]) ? ai[k] : prev; if (fin(prev) && fin(a) && a + prev > 0) rc[k - 1] = (a - prev) / (a + prev); if (fin(a)) prev = a; }
    const h = (wv.length - 1) / 2, sg = pol < 0 ? -1 : 1;
    for (let k = k0; k <= k1; k++) { let sm = 0; for (let m = -h; m <= h; m++) { const q = k - m; if (q >= 0 && q < n) sm += rc[q] * wv[m + h]; } syn[k] = sm * sg; }
    return { syn, rc, k0, k1 };
  }

  /** First and last sample with an impedance, and their depths. Null when there is none. */
  function logSpan(L) {
    if (!L || !L.ai || !L.md) return null;
    let k0 = 0, k1 = L.n - 1;
    while (k0 < L.n && !fin(L.ai[k0])) k0++;
    while (k1 > 0 && !fin(L.ai[k1])) k1--;
    return k0 < k1 ? { k0, k1, md0: L.md[k0], md1: L.md[k1] } : null;
  }
  /** Sample position (with a fraction) of a depth; depth grows with the sample number. */
  function indexAtDepth(md, z) {
    const n = md.length;
    if (!(z > md[0])) return 0;
    for (let k = 1; k < n; k++) if (z <= md[k]) return k - 1 + (z - md[k - 1]) / ((md[k] - md[k - 1]) || 1);
    return n - 1;
  }
  /** What the interval can start and end at: the tops of the well inside the logged range, and the two ends of the log. */
  function intervalChoices(L, tops) {
    const sp = logSpan(L); if (!sp) return [];
    const out = [{ key: '@start', name: 'First logged sample', md: sp.md0 }];
    for (const t of (tops || [])) if (fin(t.md) && t.md > sp.md0 && t.md < sp.md1) out.push({ key: t.key, name: t.name, md: t.md });
    out.push({ key: '@end', name: 'End of the log', md: sp.md1 });
    return out.sort((a, b) => a.md - b.md);
  }
  /** The interval the panel starts with: the Green Clay top (predicted, or the Horda Formation) down to the Rogaland
   *  top. Where a top is missing or lies outside the log: from the Hordaland top, else from the first logged sample;
   *  down to the Rogaland top, else the next top below, else the end of the log. */
  function defaultInterval(L, tops) {
    const ch = intervalChoices(L, tops); if (ch.length < 2) return null;
    const by = (k) => ch.find((c) => c.key === k);
    const ro = by('ro'), top = by('gc') || by('hd') || by('ho') || ch[0];
    let base = ro && ro.md > top.md + 5 ? ro : null;
    if (!base) base = ch.find((c) => c.md > top.md + 5 && c.key !== '@start') || ch[ch.length - 1];
    return { top: top.md, base: base.md, topKey: top.key, baseKey: base.key, topName: top.name, baseName: base.name };
  }

  /** The log directly above a depth: samples with velocity and density, going up until the log stops (more than five
   *  samples in a row without a value). `ok` says whether there is enough of it to stand in for the interval. */
  function usableAbove(L, topMd) {
    const md = L.md, vp = L.vp, rho = L.rho_used, pts = [];
    if (!md || !vp || !rho) return { ok: false, thick: 0, pts, why: 'This well has no velocity and density log.' };
    let gap = 0, k = Math.min(L.n - 1, Math.ceil(indexAtDepth(md, topMd)) - 1);
    for (; k >= 0; k--) {
      if (!(md[k] < topMd)) continue;
      if (fin(vp[k]) && fin(rho[k])) { pts.push([md[k], vp[k], rho[k]]); gap = 0; } else if (++gap > 5) break;
    }
    let more = false; for (; k >= 0; k--) if (fin(vp[k]) && fin(rho[k])) { more = true; break; }   // log above a gap is not used
    pts.reverse();
    const thick = pts.length ? topMd - pts[0][0] : 0, ok = thick >= MIN_ABOVE_M && pts.length >= MIN_ABOVE_N;
    const why = ok ? '' : (pts.length ? 'Only ' + Math.round(thick) + ' m of unbroken log above the top of the interval (' + pts.length + ' samples' + (more ? ', then a gap' : '') + '): at least ' + MIN_ABOVE_M + ' m and ' + MIN_ABOVE_N + ' samples are needed to stand in for it.'
      : more ? 'The log has a gap directly above the top of the interval, so there is no layer above to copy.'
        : 'There is no log above the top of the interval, so there is no layer above to copy.');
    return { ok, thick, pts, why };
  }
  /** Velocity and density of the rock above, mirrored about the top: the value for depth z (below the top) is the
   *  log at the same distance above the top. Where the interval is thicker than the log above, the log is folded
   *  back and forth (a triangle wave), so there is never a jump. */
  function mirrorAt(above, topMd, z) {
    const A = above.thick, pts = above.pts;
    let u = Math.max(0, z - topMd) % (2 * A); if (u > A) u = 2 * A - u;
    const zm = topMd - u;
    if (zm <= pts[0][0]) return { vp: pts[0][1], rho: pts[0][2] };
    let lo = 0, hi = pts.length - 1;
    if (zm >= pts[hi][0]) return { vp: pts[hi][1], rho: pts[hi][2] };
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] <= zm) lo = m; else hi = m; }
    const f = (zm - pts[lo][0]) / ((pts[hi][0] - pts[lo][0]) || 1);
    return { vp: pts[lo][1] + (pts[hi][1] - pts[lo][1]) * f, rho: pts[lo][2] + (pts[hi][2] - pts[lo][2]) * f };
  }

  /** Put values known at the times k + extra[k] / dt (in samples) back on the regular grid, straight lines between. */
  function resample(a, extra, dt) {
    const n = a.length, out = new Float64Array(n).fill(NaN), pos = (k) => k + extra[k] / dt;
    let k = 0;
    for (let m = 0; m < n; m++) {
      while (k < n - 2 && pos(k + 1) <= m) k++;
      const p0 = pos(k), p1 = pos(k + 1);
      if (m < p0 || m > p1) continue;
      const f = p1 > p0 ? (m - p0) / (p1 - p0) : 0, x = a[k], y = a[k + 1];
      out[m] = f === 0 ? x : f === 1 ? y : (fin(x) && fin(y)) ? x + (y - x) * f : (f < 0.5 ? x : y);
    }
    return out;
  }

  /** The scenario: the logs with one interval changed.
   *  o = { top, base (m), mode: 'scale' | 'above', vpPct, rhoPct, h (m from the top that are changed; null = all),
   *        ramp (m over which the change comes in from the top), streak: { on, thick (m), pct, depth (m below the top) } }
   *  Returns the changed logs on the samples of the well (vp, rho, ai), the extra two-way time of every sample
   *  (extra, ms), the delay of everything below (delay, ms) and the impedance back on the regular time grid (aiT). */
  function scenario(L, o) {
    const n = L.n, md = L.md, vp0 = L.vp, rho0 = L.rho_used, ai0 = L.ai;
    if (!md || !vp0 || !rho0 || !ai0) {                          // no velocity or density log: nothing can be changed
      const none = new Float64Array(n || 0).fill(NaN), a = ai0 ? Float64Array.from(ai0, (v) => (fin(v) ? v : NaN)) : none;
      return { vp: none, rho: none, ai: a, weight: new Float64Array(n || 0), extra: new Float64Array(n || 0), delay: 0, aiT: a, changed: 0, above: usableAbove(L, o.top), top: o.top, base: o.base, h: 0, mode: 'scale', vOld: NaN, vNew: NaN };
    }
    const top = o.top, base = Math.max(o.top, o.base), H = base - top;
    const h = o.h == null ? H : clamp(o.h, 0, H), ramp = Math.max(0, o.ramp || 0);
    const mode = o.mode === 'above' ? 'above' : 'scale', vpPct = o.vpPct || 0, rhoPct = o.rhoPct || 0;
    const above = usableAbove(L, top);
    const s = o.streak && o.streak.on && o.streak.pct && o.streak.thick > 0 ? o.streak : null;
    const sz0 = s ? top + clamp(s.depth || 0, 0, Math.max(0, H - s.thick)) : 0, sz1 = s ? Math.min(base, sz0 + s.thick) : 0;
    const vp = new Float64Array(n), rho = new Float64Array(n), ai = new Float64Array(n), weight = new Float64Array(n), ds = new Float64Array(n);
    // the gradual top: the share of the change that has come in at depth z, added up from the top (so a sample gets the mean over its cell)
    const F = (z) => { const x = Math.max(0, z - top); return ramp > 0 ? (x <= ramp ? x * x / (2 * ramp) : x - ramp / 2) : x; };
    let changed = 0, lastV = NaN, zSum = 0, tOld = 0, tNew = 0;
    for (let k = 0; k < n; k++) {
      const zlo = k > 0 ? (md[k - 1] + md[k]) / 2 : md[k] - (md[1] - md[0]) / 2, zhi = k < n - 1 ? (md[k] + md[k + 1]) / 2 : md[k] + (md[k] - md[k - 1]) / 2, cell = zhi - zlo;
      if (fin(vp0[k])) lastV = vp0[k];
      const vref = fin(vp0[k]) ? vp0[k] : lastV;                // a short gap in the sonic still takes time to cross
      // how much of this sample lies in the changed part, and how far the gradual top has come in
      const a = Math.max(zlo, top), b = Math.min(zhi, top + h);
      let w = 0;
      if (cell > 0 && b > a) w = (F(b) - F(a)) / cell;
      weight[k] = w;
      let fv = 1, fr = 1;
      if (w > 0) {
        if (mode === 'scale') { fv = 1 + w * vpPct / 100; fr = 1 + w * rhoPct / 100; }
        else if (above.ok) {
          const m = mirrorAt(above, top, md[k]);
          if (fin(vref)) fv = 1 + w * (m.vp / vref - 1);
          if (fin(rho0[k])) fr = 1 + w * (m.rho / rho0[k] - 1);
        }
      }
      if (s && cell > 0) {                                       // the hard streak: velocity and density up by the same factor
        const a2 = Math.max(zlo, sz0), b2 = Math.min(zhi, sz1);
        if (b2 > a2) { const g = Math.sqrt(1 + (b2 - a2) / cell * s.pct / 100); fv *= g; fr *= g; }
      }
      // a missing value arrives from the server as null: it stays missing (never a zero, which would be a reflector)
      vp[k] = fin(vp0[k]) ? vp0[k] * fv : NaN; rho[k] = fin(rho0[k]) ? rho0[k] * fr : NaN; ai[k] = fin(ai0[k]) ? ai0[k] * fv * fr : NaN;
      ds[k] = fin(vref) && fv !== 1 ? (1 / fv - 1) / vref : 0;   // change in slowness, s/m
      if (fv !== 1 || fr !== 1) changed++;
      const zi = Math.min(zhi, base) - Math.max(zlo, top);       // the part of this sample inside the interval
      if (zi > 0 && fin(vref)) { zSum += zi; tOld += zi / vref; tNew += zi / (vref * fv); }
    }
    const extra = new Float64Array(n);                           // two-way, ms: 2 * dz * mean change in slowness
    for (let k = 1; k < n; k++) extra[k] = extra[k - 1] + 1000 * (md[k] - md[k - 1]) * (ds[k - 1] + ds[k]);
    // vOld, vNew: the velocity of the whole interval as thickness over travel time, as logged and in the scenario
    return { vp, rho, ai, weight, extra, delay: extra[n - 1], aiT: changed ? resample(ai, extra, L.dt) : ai, changed, above, top, base, h, mode,
      vOld: tOld > 0 ? zSum / tOld : NaN, vNew: tNew > 0 ? zSum / tNew : NaN, streakMd: s ? (sz0 + sz1) / 2 : NaN };
  }

  /** Scale `syn` to `seis` by least squares (means removed) over samples ka..kb, every `step` samples, and measure what
   *  is left. `band` is the RMS of the remainder in the units of the synthetic: the misfit band. Infinite when the
   *  synthetic does not follow the seismic at all (scale not positive); not a number with fewer than 20 samples. */
  function misfitBand(syn, seis, ka, kb, step) {
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let k = Math.max(0, ka); k <= Math.min(syn.length - 1, kb); k += (step || 1)) {
      const a = syn[k], b = seis[k]; if (!fin(a) || !fin(b)) continue;
      sx += a; sy += b; sxx += a * a; syy += b * b; sxy += a * b; n++;
    }
    if (n < 20) return { n, scale: NaN, r: NaN, resid: NaN, band: NaN, synRms: NaN, seisRms: NaN };
    const cxx = sxx - sx * sx / n, cyy = syy - sy * sy / n, cxy = sxy - sx * sy / n;
    const scale = cxx > 0 ? cxy / cxx : NaN, r = cxy / Math.sqrt(cxx * cyy);
    const resid = Math.sqrt(Math.max(0, cyy - (fin(scale) ? scale * cxy : 0)) / n);
    let peak = 0;                                                // the largest single value of what is left
    if (scale > 0) for (let k = Math.max(0, ka); k <= Math.min(syn.length - 1, kb); k += (step || 1)) { const a = syn[k], b = seis[k]; if (fin(a) && fin(b)) peak = Math.max(peak, Math.abs(b - sy / n - scale * (a - sx / n))); }
    return { n, scale, r: fin(r) ? r : NaN, resid, band: scale > 0 ? resid / scale : Infinity, synRms: Math.sqrt(cxx / n), seisRms: Math.sqrt(cyy / n), peakOverRms: scale > 0 && resid > 0 ? peak / resid : NaN };
  }
  /** RMS of a series over samples ka..kb (values that are not numbers are skipped). */
  function rmsOver(a, ka, kb) {
    let s = 0, n = 0;
    for (let k = Math.max(0, Math.ceil(ka)); k <= Math.min(a.length - 1, Math.floor(kb)); k++) if (fin(a[k])) { s += a[k] * a[k]; n++; }
    return { rms: n ? Math.sqrt(s / n) : NaN, n };
  }
  /** Width of the wavelet's spectrum in Hz, as (sum of power)^2 / (sum of power^2): the bandwidth that sets how many
   *  independent values a stretch of trace holds. */
  function effectiveBandwidth(wv, dtMs) {
    const N = 512, df = 1000 / (N * dtMs); let s1 = 0, s2 = 0;
    for (let j = 1; j < N / 2; j++) {
      let re = 0, im = 0; for (let m = 0; m < wv.length; m++) { const ph = 2 * Math.PI * j * m / N; re += wv[m] * Math.cos(ph); im -= wv[m] * Math.sin(ph); }
      const p = re * re + im * im; s1 += p; s2 += p * p;
    }
    return s2 > 0 ? s1 * s1 / s2 * df : NaN;
  }
  /** Rough standard error of a correlation r over a window (ms) of a signal with this bandwidth (Hz): the window
   *  holds about 2 x bandwidth x length independent values, and the error is (1 - r^2) / sqrt(that number - 1). */
  function corrStdErr(r, windowMs, bandwidthHz) {
    const n = 2 * bandwidthHz * windowMs / 1000;
    return { n, se: n > 2 && fin(r) ? (1 - r * r) / Math.sqrt(n - 1) : NaN };
  }
  /** The window of `len` samples with the largest RMS among the windows that lie inside samples kLo..kHi. A window
   *  counts when at least 90 % of it has values. Used for the base of the interval: when the scenario moves the base
   *  in time, the change is spread over a longer stretch, and one long window would thin it out. */
  function maxRmsSliding(a, kLo, kHi, len) {
    kLo = Math.max(0, Math.round(kLo)); kHi = Math.min(a.length - 1, Math.round(kHi)); len = Math.max(1, Math.round(len));
    let best = { rms: NaN, n: 0, ka: kLo, kb: Math.min(kHi, kLo + len - 1) };
    const m = kHi - kLo + 1; if (m < 1) return best;
    const s2 = new Float64Array(m + 1), cn = new Float64Array(m + 1);
    for (let k = 0; k < m; k++) { const v = a[kLo + k], ok = fin(v); s2[k + 1] = s2[k] + (ok ? v * v : 0); cn[k + 1] = cn[k] + (ok ? 1 : 0); }
    for (let k = 0; k + len <= m; k++) {
      const n = cn[k + len] - cn[k]; if (n < 0.9 * len) continue;
      const rms = Math.sqrt((s2[k + len] - s2[k]) / n);
      if (!(rms <= best.rms)) best = { rms, n, ka: kLo + k, kb: kLo + k + len - 1 };
    }
    return best;
  }
  /** How high the correlation gets by chance at this well. The same synthetic is laid on the same seismic trace at
   *  wrong times: every 100 ms, 200 ms or more away from where the tie puts it. Where the shift of the tie was chosen
   *  as the best between -40 and +40 ms (o.searched), the best of the same shifts is taken at every wrong place too.
   *  seisAt(t) gives the trace at a time (ms); syn is on the log grid (t0, dt); the tie window is samples ka..kb.
   *  o = { shift (ms), searched, r (the correlation of the tie), tMin, tMax (ms: the part of the trace that can be used) }
   *  atChance: more than one wrong place in twenty scores as high as the tie. Null with fewer than 8 places to try. */
  function chanceLevel(syn, seisAt, t0, dt, ka, kb, o) {
    const S = o.searched ? 40 : 0, best = [];
    const corrAt = (move) => {
      let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, all = 0;
      for (let k = ka; k <= kb; k += 2) { const x = syn[k]; if (!fin(x)) continue; all++; const y = seisAt(t0 + k * dt + move); if (!fin(y)) continue; n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; }
      if (n < 20 || n < 0.9 * all) return NaN;
      const r = (sxy - sx * sy / n) / Math.sqrt((sxx - sx * sx / n) * (syy - sy * sy / n));
      return fin(r) ? r : NaN;
    };
    const tA = t0 + ka * dt + o.shift, tB = t0 + kb * dt + o.shift;
    for (let lag = -3000; lag <= 3000; lag += 100) {
      if (Math.abs(lag) < 200) continue;
      if ((fin(o.tMin) && tA + lag - S < o.tMin) || (fin(o.tMax) && tB + lag + S > o.tMax)) continue;
      let b = -2;
      for (let sh = -S; sh <= S; sh += 2) { const r = corrAt(o.shift + lag + sh); if (fin(r) && r > b) b = r; }
      if (b > -2) best.push(b);
    }
    best.sort((x, y) => x - y);
    const n = best.length, reach = fin(o.r) ? best.filter((v) => v >= o.r).length : NaN;
    return { n, searched: !!o.searched, median: n ? best[Math.floor((n - 1) / 2)] : NaN, max: n ? best[n - 1] : NaN, reach, r: o.r, atChance: n >= 8 && fin(reach) ? reach / n > 0.05 : null };
  }
  /** The misfit band for a correlation r, as a multiple of the RMS of the synthetic: sqrt(1 - r^2) / r. */
  function bandOverSyn(r) { return r > 0 ? Math.sqrt(Math.max(0, 1 - r * r)) / r : Infinity; }
  /** The reading of one number. q = { ratio, lo, hi }: the change divided by the misfit band, and the same with the band
   *  at the wide and the narrow end of its uncertainty (correlation one standard error down and up). A plain number
   *  is read as a ratio without uncertainty. chance: the tie is no better than chance, so the band is a lower bound,
   *  the ratio an upper bound, and nothing is read as larger. */
  function verdict(q, chance) {
    if (typeof q === 'number') q = { ratio: q, lo: q, hi: q };
    if (!q || !fin(q.ratio)) return { cls: 'na', text: (q && q.why) || 'cannot be judged here: too little log around it' };
    const smaller = { cls: 'smaller', text: 'smaller: this trace cannot tell the two apart' };
    if (chance) return q.ratio > 1 ? { cls: 'open', text: 'not judged: the tie is no better than chance here, so the band is only a lower bound' } : smaller;
    if (q.lo > 1) return { cls: 'larger', text: 'larger than what the tie leaves unexplained here' };
    if (!(q.hi > 1)) return smaller;
    return { cls: 'open', text: 'undecided: ' + (q.lo < 0.05 ? 'under 0.1' : q.lo.toFixed(1)) + ' to ' + (q.hi >= 10 ? q.hi.toFixed(0) : q.hi.toFixed(1)) + ' within the uncertainty of the band' };
  }

  /** Everything the panel shows, for the wavelet phase in use and for 30 degrees to either side.
   *  inp = { L (logs), seis (the seismic trace at the log times, shift already applied), win [ta, tb] (tie window, log
   *          times without the shift), wavelet(phaseDeg) -> array, phase, pol, periodMs (one cycle of the wavelet), opts,
   *          and for the chance level of the tie: seisAt(t ms), shift (ms), searched, tMin, tMax (or chance, worked out before) }
   *  The windows: one wavelet cycle to either side of the top; the same length, placed where the change is largest
   *  between the base as logged and the base in the scenario; one cycle to either side of the hard streak; and the
   *  300 ms below the base window. */
  function evaluate(inp) {
    const L = inp.L, dt = L.dt, n = L.n, o = inp.opts, sc = scenario(L, o);
    const P = clamp(inp.periodMs || 40, 16, 80) / dt, D = sc.delay / dt;
    const kTop = indexAtDepth(L.md, o.top), kBase = indexAtDepth(L.md, o.base);
    const ka = Math.ceil((inp.win[0] - L.t0) / dt), kb = Math.floor((inp.win[1] - L.t0) / dt);
    const len = 2 * Math.round(P) + 1;
    const wTop = [Math.round(kTop - P), Math.round(kTop + P)], wBase0 = [Math.round(kBase - P), Math.round(kBase + P)];
    const baseSpan = [Math.round(Math.min(kBase, kBase + D) - P), Math.round(Math.max(kBase, kBase + D) + P)];
    const wBelow = [baseSpan[1] + 1, baseSpan[1] + 1 + Math.round(300 / dt)];
    let kStreak = NaN;
    if (fin(sc.streakMd)) { const x = indexAtDepth(L.md, sc.streakMd), k = Math.min(n - 1, Math.max(0, Math.round(x))); kStreak = x + sc.extra[k] / dt; }
    const wStreak = fin(kStreak) ? [Math.round(kStreak - P), Math.round(kStreak + P)] : null;
    const phases = [];
    for (const ph of [inp.phase - 30, inp.phase, inp.phase + 30]) {
      const wv = inp.wavelet(ph), a = trace(L.ai, wv, inp.pol), b = trace(sc.aiT, wv, inp.pol);
      const diff = new Float64Array(n); for (let k = 0; k < n; k++) diff[k] = b.syn[k] - a.syn[k];
      const qa = Math.max(a.k0, ka), qb = Math.min(a.k1, kb);
      const band = misfitBand(a.syn, inp.seis, qa, qb, 2), scen = misfitBand(b.syn, inp.seis, qa, qb, 2);
      // the band with the correlation one standard error down (wide) and up (narrow)
      const se = corrStdErr(band.r, Math.max(0, (qb - qa) * dt), effectiveBandwidth(wv, dt)).se;
      const bandWide = fin(se) && fin(band.band) ? band.synRms * bandOverSyn(band.r - se) : band.band, bandNarrow = fin(se) && fin(band.band) ? band.synRms * bandOverSyn(Math.min(0.999, band.r + se)) : band.band;
      const out = (q, ok, w, why) => {
        const good = ok && fin(q.rms) && fin(band.band) && band.band > 0, r = good ? q.rms / band.band : NaN;
        let inTie = 0, cnt = 0; for (let k = Math.max(0, w[0]); k <= Math.min(n - 1, w[1]); k++) if (fin(diff[k])) { cnt++; if (k >= qa && k <= qb) inTie++; }
        return { rms: ok ? q.rms : NaN, n: q.n, ratio: r, lo: good ? (bandWide === Infinity ? 0 : q.rms / bandWide) : NaN, hi: good ? (bandNarrow > 0 ? q.rms / bandNarrow : Infinity) : NaN, win: w, ms: cnt * dt, inTie: cnt ? inTie / cnt : 0, why: ok ? '' : why };
      };
      // top, base and streak need log on both sides (an end of the log is not a boundary in the rock)
      const whole = (w) => { const q = rmsOver(diff, w[0], w[1]); return [q, q.n >= 0.9 * (w[1] - w[0] + 1)]; };
      const [qT, okT] = whole(wTop), [qB0, okB0] = whole(wBase0);
      const qB = okB0 ? maxRmsSliding(diff, baseSpan[0], baseSpan[1], len) : qB0;
      const qL = rmsOver(diff, wBelow[0], wBelow[1]), okL = qL.n * dt >= 150;      // below: at least half of the 300 ms must have log
      const p = { phase: ph, wavelet: wv, logged: a.syn, scen: b.syn, diff, band, bandWide, bandNarrow, se, rLogged: band.r, rScen: scen.r, qa, qb,
        top: out(qT, okT, wTop), base: out(qB, okB0 && fin(qB.rms), okB0 && fin(qB.rms) ? [qB.ka, qB.kb] : wBase0),
        below: out(qL, okL, wBelow, qL.n ? 'cannot be judged here: only ' + Math.round(qL.n * dt) + ' ms of log below the interval' : 'cannot be judged here: no log below the interval') };
      if (wStreak) { const [qS, okS] = whole(wStreak); p.streak = out(qS, okS, wStreak); }
      phases.push(p);
    }
    const cur = phases[1], bw = effectiveBandwidth(cur.wavelet, dt), se = corrStdErr(cur.rLogged, Math.max(0, (cur.qb - cur.qa) * dt), bw);
    let chance = inp.chance || null;
    if (!chance && typeof inp.seisAt === 'function' && fin(cur.rLogged))
      chance = chanceLevel(cur.logged, inp.seisAt, L.t0, dt, cur.qa, cur.qb, { shift: inp.shift || 0, searched: !!inp.searched, r: cur.rLogged, tMin: inp.tMin, tMax: inp.tMax });
    return { sc, phases, cur, bw, se, chance, atChance: !!(chance && chance.atChance), kTop, kBase, kStreak, tTop: L.t0 + kTop * dt, tBase: L.t0 + kBase * dt, tBaseScen: L.t0 + (kBase + D) * dt, tStreak: L.t0 + kStreak * dt,
      windows: { top: wTop, base: cur.base.win, baseSpan, below: wBelow, streak: wStreak }, periodMs: P * dt, cycleMs: fin(inp.periodMs) ? inp.periodMs : P * dt, thin: wTop[1] >= wBase0[0] };
  }

  const api = { ricker, quadrature, rotate, trace, logSpan, indexAtDepth, intervalChoices, defaultInterval, usableAbove, mirrorAt, resample, scenario,
    misfitBand, rmsOver, maxRmsSliding, chanceLevel, bandOverSyn, effectiveBandwidth, corrStdErr, verdict, evaluate, MIN_ABOVE_M };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  /* ======================================================================================
   * 2. The panel in the page
   * ==================================================================================== */
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fresh = () => ({ key: null, top: NaN, base: NaN, topKey: '', baseKey: '', mode: 'scale', vpPct: 0, rhoPct: 0, h: null, ramp: 0, streak: { on: false, thick: 5, pct: 30, depth: null } });
  let ST = fresh(), bound = false, last = null;
  const pctile = (a, p) => { const v = a.filter(fin).sort((x, y) => x - y); return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN; };
  const signed = (v, d) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d == null ? 0 : d);
  const ratioTxt = (x) => (!fin(x) ? 'n/a' : x < 0.05 ? 'under 0.1' : x >= 10 ? x.toFixed(0) : x.toFixed(1));

  function opts() { return { top: ST.top, base: ST.base, mode: ST.mode, vpPct: ST.vpPct, rhoPct: ST.rhoPct, h: ST.h, ramp: ST.ramp, streak: { on: ST.streak.on, thick: ST.streak.thick, pct: ST.streak.pct, depth: ST.streak.depth == null ? Math.max(0, (ST.base - ST.top - ST.streak.thick) / 2) : ST.streak.depth } }; }

  /** Start again for another well: nothing is kept from the last one. */
  function resetFor(w, key) {
    ST = fresh(); ST.key = key;
    const d = w && w.logs && w.logs.ai ? defaultInterval(w.logs, w.tops) : null;
    if (d) { ST.top = d.top; ST.base = d.base; ST.topKey = d.topKey; ST.baseKey = d.baseKey; }
    fillSelects(w); syncControls(w);
  }
  function fillSelects(w) {
    const ch = w && w.logs && w.logs.ai ? intervalChoices(w.logs, w.tops) : [];
    const o = (sel) => ch.map((c) => '<option value="' + esc(c.key) + '"' + (c.key === sel ? ' selected' : '') + '>' + esc(c.name) + '</option>').join('') + '<option value=""' + (sel ? '' : ' selected') + '>Own depth</option>';
    $('wi-top').innerHTML = o(ST.topKey); $('wi-base').innerHTML = o(ST.baseKey);
  }
  /** Write the state into the controls (after a reset or a change of interval). */
  function syncControls(w) {
    const H = ST.base > ST.top ? ST.base - ST.top : 0, Hr = Math.max(1, Math.round(H));   // no well yet: no interval
    $('wi-top').value = ST.topKey; $('wi-base').value = ST.baseKey;
    if (document.activeElement !== $('wi-top-md')) $('wi-top-md').value = fin(ST.top) ? Math.round(ST.top) : '';
    if (document.activeElement !== $('wi-base-md')) $('wi-base-md').value = fin(ST.base) ? Math.round(ST.base) : '';
    $('wi-mode-scale').checked = ST.mode === 'scale'; $('wi-mode-above').checked = ST.mode === 'above';
    $('wi-vp').value = ST.vpPct; $('wi-vp-out').textContent = signed(ST.vpPct) + ' %';
    $('wi-rho').value = ST.rhoPct; $('wi-rho-out').textContent = signed(ST.rhoPct) + ' %';
    $('wi-vp').disabled = $('wi-rho').disabled = ST.mode !== 'scale';
    $('wi-h').max = Hr; $('wi-h').value = ST.h == null ? Hr : Math.min(Hr, ST.h);
    $('wi-h-out').textContent = ST.h == null ? 'all ' + Math.round(H) + ' m' : 'top ' + Math.round(ST.h) + ' m of ' + Math.round(H);
    $('wi-ramp').value = ST.ramp; $('wi-ramp-out').textContent = ST.ramp ? 'over ' + ST.ramp + ' m' : 'sharp';
    $('wi-st').checked = ST.streak.on; $('wi-st-th').value = ST.streak.thick; $('wi-st-pct').value = ST.streak.pct;
    const zMax = Math.max(0, Math.floor(H - ST.streak.thick));
    $('wi-st-z').max = zMax; if (document.activeElement !== $('wi-st-z')) $('wi-st-z').value = Math.round(ST.streak.depth == null ? zMax / 2 : Math.min(zMax, ST.streak.depth));
    $('wi-st-th').disabled = $('wi-st-pct').disabled = $('wi-st-z').disabled = !ST.streak.on;
  }
  function bind() {
    if (bound || !$('wi-plot')) return; bound = true;
    const well = () => window.SVWells.current(), again = () => { syncControls(well()); render(); };
    const pickTop = (which, key) => {
      if (key === '') {                                          // "Own depth": keep the depth, and go to the field to type one
        if (which === 'top') ST.topKey = ''; else ST.baseKey = '';
        const f = $(which === 'top' ? 'wi-top-md' : 'wi-base-md'); again(); f.focus(); f.select(); return;
      }
      const w = well(), c = w && w.logs ? intervalChoices(w.logs, w.tops).find((q) => q.key === key) : null; if (!c) return;
      if (which === 'top') { ST.top = c.md; ST.topKey = key; } else { ST.base = c.md; ST.baseKey = key; }
      ST.h = null; ST.streak.depth = null; again();
    };
    $('wi-top').addEventListener('change', (e) => pickTop('top', e.target.value));
    $('wi-base').addEventListener('change', (e) => pickTop('base', e.target.value));
    const ownDepth = (which, el) => {
      const w = well(), sp = w && w.logs ? logSpan(w.logs) : null, v = Number(el.value); if (!sp || el.value === '' || !fin(v)) return;
      const z = clamp(v, sp.md0, sp.md1);
      if (which === 'top') { ST.top = z; ST.topKey = ''; } else { ST.base = z; ST.baseKey = ''; }
      if (z !== v) el.value = Math.round(z);                     // a depth outside the log: show the depth that is used
      ST.h = null; ST.streak.depth = null; again();
    };
    $('wi-top-md').addEventListener('change', (e) => ownDepth('top', e.target));
    $('wi-base-md').addEventListener('change', (e) => ownDepth('base', e.target));
    for (const id of ['wi-mode-scale', 'wi-mode-above']) $(id).addEventListener('change', (e) => { if (e.target.checked) { ST.mode = e.target.value; again(); } });
    $('wi-vp').addEventListener('input', (e) => { ST.vpPct = Number(e.target.value); again(); });
    $('wi-rho').addEventListener('input', (e) => { ST.rhoPct = Number(e.target.value); again(); });
    $('wi-h').addEventListener('input', (e) => { const v = Number(e.target.value); ST.h = v >= Number(e.target.max) ? null : v; again(); });
    $('wi-ramp').addEventListener('input', (e) => { ST.ramp = Number(e.target.value); again(); });
    $('wi-st').addEventListener('change', (e) => { ST.streak.on = e.target.checked; again(); });
    $('wi-st-th').addEventListener('change', (e) => { ST.streak.thick = clamp(Number(e.target.value) || 5, 2, 10); again(); });
    $('wi-st-pct').addEventListener('change', (e) => { ST.streak.pct = clamp(Number(e.target.value) || 0, 0, 100); again(); });
    $('wi-st-z').addEventListener('change', (e) => { ST.streak.depth = Math.max(0, Number(e.target.value) || 0); again(); });
    $('wi-reset').addEventListener('click', () => { const w = well(), key = ST.key; resetFor(w, key); render(); });
  }

  /** Work out the scenario for the current well and tie, and show it. Called by wells.js after every drawing of the tie. */
  let chanceMemo = { key: '', val: null };                       // the chance level depends on the tie, not on the scenario
  function render() {
    const SW = window.SVWells, cv = $('wi-plot'); if (!SW || !cv) return;
    bind();
    const w = SW.current(), key = (window.SV_DS || '') + '|' + (w ? w.name : '');
    if (key !== ST.key) resetFor(w, key);
    const out = $('wi-out'), note = $('wi-note'), ctl = $('wi-ctl');
    const usable = !!(w && w.logs && w.logs.ai && w.logs.vp && w.logs.rho_used && w.seis && logSpan(w.logs));
    ctl.hidden = cv.hidden = $('wi-reset').hidden = !usable;
    if (!usable) { last = null; note.textContent = ''; out.innerHTML = '<p class="muted">' + (w ? 'This well has no sonic and density log on the seismic, so there is nothing to change.' : 'Choose a well.') + '</p>'; return; }
    const L = w.logs, W = SW.state, sh = SW.shiftOf(w), win = SW.tieTimes(w);
    if (!(ST.base > ST.top)) { last = null; note.textContent = ''; out.innerHTML = '<p class="wl-td">The base of the interval must lie below its top.</p>'; drawPlot(null, w, sh, win); return; }
    const seis = new Float64Array(L.n); for (let k = 0; k < L.n; k++) seis[k] = SW.seisAt(w, L.t0 + k * L.dt + sh);
    const fPeak = W.wavelet === 'seis' && w.wavelet && w.wavelet.dt === L.dt ? w.wavelet.peak_hz : W.f;
    const searched = !!(W.tied && W.tied[w.name]), span = SW.traceTimes ? SW.traceTimes(w) : [NaN, NaN];
    const tMin = Math.max(fin(span[0]) ? span[0] : -Infinity, fin(w.seabed_twt) ? w.seabed_twt + 50 : -Infinity);   // not the water column
    const cKey = [key, sh, win[0], win[1], W.wavelet, W.f, W.phase, W.pol, searched].join('|');
    const res = evaluate({ L, seis, win, wavelet: (ph) => SW.wavelet(w, ph), phase: W.phase, pol: W.pol, periodMs: 1000 / fPeak, opts: opts(),
      chance: chanceMemo.key === cKey ? chanceMemo.val : null, seisAt: (t) => SW.seisAt(w, t), shift: sh, searched, tMin, tMax: span[1] });
    chanceMemo = { key: cKey, val: res.chance };
    last = { res, well: w.name, shift: sh, win, phase: W.phase, pol: W.pol, opts: opts() };
    // "like the layer above": say what it is, or why it cannot be chosen
    const ab = res.sc.above, H = ST.base - ST.top;
    $('wi-mode-above').disabled = !ab.ok;
    if (!ab.ok && ST.mode === 'above') { ST.mode = 'scale'; syncControls(w); return render(); }
    const where = ST.topKey === '@start' && ST.baseKey === '@end' ? 'No top of this well lies inside the log, so the interval starts as the whole log: choose your own depths. '
      : ST.topKey === '@start' ? 'The interval starts at the first logged sample: the log does not reach higher. ' : ST.baseKey === '@end' ? 'The interval ends where the log ends, so nothing below it can be compared. ' : '';
    note.textContent = where + (!ab.ok ? '"Like the layer above" is off. ' + ab.why
      : ST.mode === 'above' ? 'Like the layer above: the ' + Math.round(Math.min(ab.thick, H)) + ' m of log above the top is mirrored about the top into the interval' + (ab.thick < H ? ' and folded back and forth, because the interval is ' + Math.round(H) + ' m thick and the log above it only ' + Math.round(ab.thick) + ' m' : '') +
        '. The interval is not multiplied by a number: that would keep its own layering and can leave a false step at its top. Put the top on the step in the log itself: a step just above the top is mirrored into the interval.'
        : '"Like the layer above" mirrors the log above the top into the interval (' + Math.round(ab.thick) + ' m of log above).') +
      (ST.streak.on ? ' Hard streak: velocity and density are raised by the same factor (the square root of the rise in impedance), so what lies below it also arrives a little earlier.' : '');
    drawPlot(res, w, sh, win);
    out.innerHTML = report(res, w, sh, win);
  }

  /** The words under the plot. */
  function report(res, w, sh, win) {
    const c = res.cur, b = c.band, f2 = (v) => (fin(v) ? v.toFixed(2) : 'n/a'), L = w.logs;
    const winTxt = Math.round(win[0] + sh) + '–' + Math.round(win[1] + sh) + ' ms';
    const d = res.sc.delay, dTxt = Math.abs(d) < 0.05 ? 'no delay' : Math.abs(d).toFixed(1) + ' ms ' + (d > 0 ? 'later' : 'earlier');
    // the delay is plain log arithmetic: it is shown also where there is no misfit band
    const vTxt = fin(res.sc.vOld) && fin(res.sc.vNew) ? ': the velocity of the interval (thickness over travel time) goes from ' + Math.round(res.sc.vOld) + ' to ' + Math.round(res.sc.vNew) + ' m/s' +
      (res.sc.mode === 'above' ? (d > 0 ? ', because the rock above is slower here' : ', because the rock above is faster here') : '') : '';
    const delayP = !res.sc.changed ? '' : '<p>' + (Math.abs(d) < 0.05 ? 'This change does not move anything in time.'
      : 'Everything below the interval arrives <b>' + dTxt + '</b> (two-way time)' + vTxt + '. A bulk shift of the tie would absorb that unless events above the interval hold the tie in place.') + '</p>';
    if (!fin(b.band) && b.band !== Infinity) return '<p class="wl-td">The tie window (' + winTxt + ') holds too little synthetic and seismic to work out a misfit band, so nothing can be compared here.</p>' + delayP;
    if (b.band === Infinity) return '<p class="wl-td"><b>No misfit band.</b> In the tie window (' + winTxt + ') the synthetic does not follow the seismic (correlation ' + f2(b.r) + '), so no change to the logs can be judged against this trace.</p>' + delayP;
    const x = b.band / b.synRms, xLo = c.bandNarrow / b.synRms, xHi = c.bandWide / b.synRms;
    let h = '<p class="wi-band"><b>Misfit band: ' + ratioTxt(x) + ' × the synthetic</b>' + (fin(xLo) ? ' (' + ratioTxt(xLo) + ' to ' + (xHi === Infinity ? 'no upper limit' : ratioTxt(xHi)) + ' with the uncertainty of the tie)' : '') +
      '. The synthetic as logged is scaled to the seismic trace in the tie window (' + winTxt + '). What the seismic has left after that is typically ' + ratioTxt(x) +
      ' times as large as the synthetic itself (typical size = RMS, the root of the mean square). A change smaller than this band is below what this tie can show.</p>';
    const ch = res.chance;
    if (ch) {
      const how = 'Laid on the same trace at ' + ch.n + ' wrong times (200 ms or more away' + (ch.searched ? ', each with the same search for the best shift' : '') + '), the synthetic scores ' + f2(ch.median) + ' in the middle and ';
      if (ch.atChance) h += '<p class="wl-td"><b>This tie is no better than chance.</b> Its correlation is ' + f2(ch.r) + (ch.searched ? ', after the shift was chosen as the best between −40 and +40 ms' : '') + '. ' + how +
        'reaches ' + f2(ch.r) + ' or more at ' + ch.reach + ' of them. So the band is only a lower bound: a change can be read as smaller here, never as larger.</p>';
      else if (ch.atChance === false) h += '<p class="muted">Chance check: ' + how.charAt(0).toLowerCase() + how.slice(1) + 'reaches the ' + f2(ch.r) + ' of the tie at ' + (ch.reach ? ch.reach + ' of them' : 'none of them') + '.</p>';
      else h += '<p class="muted">Chance check: the trace has room for only ' + ch.n + ' wrong times to lay the synthetic at, too few to say whether this tie beats chance.</p>';
    }
    if (!res.sc.changed) return h + '<p class="muted">Nothing is changed yet. Move a control above: the plot shows the synthetic as logged, the scenario, their difference and the misfit band (amber).</p>';
    const ph = (p) => signed(p.phase) + '°';
    const cell = (q) => { const v = verdict(q, res.atChance); return '<td class="r"><span class="wi-tag ' + v.cls + '">' + ratioTxt(q.ratio) + '</span></td>'; };
    const outside = (q) => (fin(q.ratio) && q.inTie < 0.5 ? '. Mostly outside the tie window, where the tie is not checked' : '');
    const row = (name, k) => '<tr><td>' + name + '</td>' + cell(res.phases[0][k]) + cell(c[k]) + cell(res.phases[2][k]) + '<td>' + esc(verdict(c[k], res.atChance).text + outside(c[k])) + '</td></tr>';
    const tOf = (k) => Math.round(L.t0 + k * L.dt + sh);
    h += '<div class="table-wrap"><table class="wl-t wi-t"><tr><th>Where</th><th class="r">Phase ' + ph(res.phases[0]) + '</th><th class="r">' + ph(c) + ' (now)</th><th class="r">' + ph(res.phases[2]) + '</th><th>Reading now</th></tr>' +
      row('Top of the interval, ' + Math.round(res.tTop + sh) + ' ms', 'top') +
      (c.streak ? row('At the hard streak, ' + Math.round(res.tStreak + sh) + ' ms', 'streak') : '') +
      row('Base, ' + Math.round(res.tBase + sh) + (Math.abs(d) >= 0.5 ? ' → ' + Math.round(res.tBaseScen + sh) : '') + ' ms', 'base') +
      row('Below the interval, ' + tOf(res.windows.below[0]) + '–' + tOf(res.windows.below[1]) + ' ms: ' + dTxt, 'below') + '</table></div>';
    const P = res.periodMs, C = res.cycleMs, cyc = Math.abs(d) / C, near = Math.round(cyc) >= 1 && Math.abs(cyc - Math.round(cyc)) < 0.25;
    h += '<p>Each number is the typical size (RMS) of scenario minus logged, divided by the misfit band: within ' + Math.round(P) + ' ms (about one wavelet cycle) of the top' + (c.streak ? ' and of the hard streak' : '') +
      ', in the stretch of the same length where the change is largest between the base as logged and the base in the scenario, and in the 300 ms below. ' +
      'The reading takes the uncertainty of the band along: larger only if the change beats the wide end of the band, smaller only if it stays under the narrow end, undecided in between. ' +
      'The two outer columns turn the wavelet phase by 30° either way: a reading that flips there is not a firm one.' +
      (res.thin ? ' The interval is thinner than the wavelet, so top and base are not separate here.' : '') + '</p>';
    h += '<p>In the plot, the boxes in the difference track are these typical sizes, to hold against the amber band. Single peaks stand higher than the typical size' +
      (fin(b.peakOverRms) ? ': the largest peak of what the tie leaves unexplained is ' + b.peakOverRms.toFixed(1) + ' times the band' : '') + ', so a peak outside the amber band is not by itself a larger reading.</p>';
    if (near) h += '<p class="wl-td">The delay (' + Math.abs(d).toFixed(1) + ' ms) is close to ' + (Math.round(cyc) === 1 ? 'one whole wavelet cycle' : Math.round(cyc) + ' whole wavelet cycles') + ' (' + Math.round(C) +
      ' ms each). A trace moved by a whole cycle looks much like itself, so the numbers for the base and below can be low here although the change is larger. A larger change does not always give a larger number.</p>';
    h += delayP;
    h += '<p class="muted">Correlation with the seismic in the tie window: ' + f2(c.rLogged) + ' as logged, ' + f2(c.rScen) + ' for the scenario. Rough standard error ±' + f2(res.se.se) + ' (about ' + Math.round(res.se.n) +
      ' independent values: window length × ' + Math.round(res.bw) + ' Hz bandwidth × 2). A difference in correlation smaller than that says nothing.</p>';
    return h;
  }

  /** The plot: impedance, synthetic as logged, synthetic of the scenario, their difference with the misfit band.
   *  Same colours and type as the tie plot above it. The time axis is the stretch that is judged (from above the top
   *  of the interval to the end of the 300 ms below it), not the whole tie window, so a thin interval can be read. */
  function drawPlot(res, w, sh, win) {
    const cv = $('wi-plot'); if (!cv) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), cw = cv.clientWidth, ch = cv.clientHeight;
    if (!cw || !ch) return;
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, cw, ch);
    if (!res) return;
    const L = w.logs, c = res.cur, wa = win[0], wb = win[1], tK = (k) => L.t0 + k * L.dt + sh;
    let f0 = 0, f1 = L.n - 1;                                    // where there is a synthetic, as logged or in the scenario
    while (f0 < L.n - 1 && !fin(c.logged[f0]) && !fin(c.scen[f0])) f0++;
    while (f1 > 0 && !fin(c.logged[f1]) && !fin(c.scen[f1])) f1--;
    const ta = Math.max(tK(f0) - 20, tK(Math.min(res.windows.top[0], res.windows.baseSpan[0])) - 40), tb = Math.max(ta + 100, Math.min(tK(f1), tK(res.windows.below[1])) + 20);
    const top = 34, bot = ch - 8, left = 50, Y = (t) => top + (t - ta) / (tb - ta) * (bot - top);
    const tracks = [['ai', 'Impedance'], ['logged', 'As logged'], ['scen', 'Scenario'], ['diff', 'Difference']];
    const tw = (cw - left - 6) / tracks.length;
    if (tw < 66) { tracks[0][1] = 'AI'; tracks[1][1] = 'Logged'; tracks[3][1] = 'Diff.'; }
    ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.strokeStyle = '#2b3a35';
    const stepT = (tb - ta) > 900 ? 200 : (tb - ta) > 400 ? 100 : (tb - ta) > 180 ? 50 : 20;
    for (let t = Math.ceil(ta / stepT) * stepT; t <= tb; t += stepT) { const y = Y(t); ctx.fillStyle = '#93a19b'; ctx.fillText(String(t), left - 6, y); ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(cw - 6, y); ctx.stroke(); }
    ctx.save(); ctx.translate(10, (top + bot) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillStyle = '#c5d0cb'; ctx.fillText('Two-way time (ms)', 0, 0); ctx.restore();
    const kA = Math.max(0, Math.floor((ta - sh - L.t0) / L.dt)), kB = Math.min(L.n - 1, Math.ceil((tb - sh - L.t0) / L.dt));
    const abs = []; for (let k = kA; k <= kB; k++) if (fin(c.logged[k])) abs.push(Math.abs(c.logged[k]));
    const sN = pctile(abs, 0.98) || 1, bandN = c.band.band / sN;
    const aiAll = []; for (let k = kA; k <= kB; k++) { aiAll.push(L.ai[k]); aiAll.push(res.sc.aiT[k]); }
    const aLo = pctile(aiAll, 0.02), aHi = pctile(aiAll, 0.98);
    tracks.forEach(([key, title], ti) => {
      const x0 = left + ti * tw, x1 = x0 + tw - 6, mid = (x0 + x1) / 2, amp = (x1 - x0) * 0.42;
      ctx.fillStyle = '#0d1815'; ctx.fillRect(x0, top, x1 - x0, bot - top); ctx.strokeStyle = '#2b3a35'; ctx.lineWidth = 1; ctx.strokeRect(x0 + 0.5, top + 0.5, x1 - x0 - 1, bot - top - 1);
      ctx.fillStyle = '#e8efec'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.font = '600 11px system-ui, sans-serif'; ctx.fillText(title, mid, 13);
      ctx.save(); ctx.beginPath(); ctx.rect(x0, top, x1 - x0, bot - top); ctx.clip();
      ctx.fillStyle = 'rgba(47,203,147,.07)'; ctx.fillRect(x0, Y(wa + sh), x1 - x0, Y(wb + sh) - Y(wa + sh));   // the tie window
      const line = (arr, col, xOf, fill) => {
        ctx.beginPath(); let pen = false; const pts = [];
        for (let k = kA; k <= kB; k++) { const v = arr[k]; if (!fin(v)) { pen = false; continue; } const px = xOf(v), py = Y(L.t0 + k * L.dt + sh); pts.push([px, py]); if (pen) ctx.lineTo(px, py); else ctx.moveTo(px, py); pen = true; }
        ctx.strokeStyle = col; ctx.lineWidth = 1.2; ctx.stroke();
        if (fill) { ctx.fillStyle = fill; for (let p = 1; p < pts.length; p++) { const a = pts[p - 1], b = pts[p]; if (a[0] > mid || b[0] > mid) { ctx.beginPath(); ctx.moveTo(mid, a[1]); ctx.lineTo(Math.max(mid, a[0]), a[1]); ctx.lineTo(Math.max(mid, b[0]), b[1]); ctx.lineTo(mid, b[1]); ctx.fill(); } } }
      };
      const wig = (v) => mid + clamp(v / sN, -1.2, 1.2) * amp;
      if (key === 'ai') {
        const xOf = (v) => x0 + 3 + clamp((v - aLo) / ((aHi - aLo) || 1), 0, 1) * (x1 - x0 - 6);
        line(res.sc.aiT, '#4fd8ff', xOf); line(L.ai, '#ffe66b', xOf);     // the log on top: cyan shows only where the scenario differs
      } else {
        if (key === 'diff' && fin(bandN)) {                      // the misfit band, in the same scale as the three wiggles
          const hw = Math.min(1.2, bandN) * amp; ctx.fillStyle = 'rgba(255,176,0,.16)'; ctx.fillRect(mid - hw, top, 2 * hw, bot - top);
          if (bandN <= 1.2) { ctx.strokeStyle = '#ffb000'; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(mid - hw, top); ctx.lineTo(mid - hw, bot); ctx.moveTo(mid + hw, top); ctx.lineTo(mid + hw, bot); ctx.stroke(); ctx.setLineDash([]); }
        }
        ctx.strokeStyle = '#2b3a35'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(mid, top); ctx.lineTo(mid, bot); ctx.stroke();
        if (key === 'logged') line(c.logged, '#5dff8f', wig, 'rgba(93,255,143,.35)');
        else if (key === 'scen') line(c.scen, '#4fd8ff', wig, 'rgba(79,216,255,.3)');
        else {
          // the typical size (RMS) of the difference in each window that is read: the like-for-like partner of the band
          for (const k of ['top', 'streak', 'base', 'below']) {
            const q = c[k]; if (!q || !fin(q.rms)) continue;
            const hw = Math.max(1, Math.min(1.2, q.rms / sN) * amp), ya = Y(tK(q.win[0])), yb = Y(tK(q.win[1]));
            ctx.fillStyle = 'rgba(232,239,236,.16)'; ctx.fillRect(mid - hw, ya, 2 * hw, yb - ya);
            ctx.strokeStyle = '#e8efec'; ctx.lineWidth = 1; ctx.strokeRect(mid - hw + 0.5, ya + 0.5, 2 * hw - 1, yb - ya - 1);
          }
          line(c.diff, '#e8efec', wig);
        }
      }
      ctx.restore();
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#93a19b'; ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(key === 'ai' ? (tw < 96 ? 'log, scenario' : 'logged yellow, scenario cyan') : key === 'diff' ? (!fin(bandN) ? 'no misfit band' : tw < 130 ? 'boxes, amber band' : 'boxes: typical size, amber: band') : 'synthetic', mid, 27);
    });
    // the interval: its top, and its base as logged and in the scenario (names on a dark plate, so the curves do not hide them)
    ctx.font = '600 10px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    const mark = (t, col, dash, label) => {
      const y = Y(t + sh); if (!(y >= top && y <= bot)) return;
      ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(cw - 6, y); ctx.stroke(); ctx.setLineDash([]);
      if (label) { const lw = ctx.measureText(label).width, ly = Math.max(top + 14, y - 2); ctx.fillStyle = 'rgba(13,24,21,.88)'; ctx.fillRect(left + 2, ly - 12, lw + 6, 13); ctx.fillStyle = col; ctx.fillText(label, left + 5, ly); }
    };
    mark(res.tTop, '#5dff8f', [], tw < 66 ? 'Top' : 'Top of the interval');
    if (fin(res.tStreak)) mark(res.tStreak, '#e8efec', [2, 3], tw < 66 ? 'Streak' : 'Hard streak');
    if (Math.abs(res.sc.delay) >= 0.5) mark(res.tBaseScen, '#4fd8ff', [6, 3], '');
    mark(res.tBase, '#ffb000', [], 'Base');
  }

  window.SVWhatIf = { ...api, render, get state() { return ST; }, /** What was last worked out and shown, for inspection. */ get last() { return last; } };
})();
