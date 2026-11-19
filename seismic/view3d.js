/* view3d.js - the three seismic sections, the wells and the followed events in one 3D scene.
 *
 * Plain WebGL, no library. The scene reuses what the 2D panels already hold: their coloured images become
 * textures on an inline plane, a crossline plane and a time slice; wells and tops come from wells.js, and
 * followed events become surfaces. Axes: crossline to the right, inline into the screen, two-way time down.
 * Time is stretched by the "vertical" slider (1 ms is drawn as that many metres), so slopes are exaggerated.
 *
 * Mouse: drag to turn, wheel to zoom, shift-drag (or right-drag) to move, double-click to reset.
 * Click a section plane to move the cross-hair there.
 */
'use strict';
(function () {
  const $ = (id) => document.getElementById(id);
  const TOP_COL = { no: [0.79, 0.83, 0.82], ho: [1, 0.62, 0.88], gc: [0.36, 1, 0.56], ro: [1, 0.69, 0], sh: [0.56, 0.78, 1] };
  const V = { az: -1.05, el: 0.42, dist: 2.25, pan: [0, 0, 0], ve: 10, show: { il: true, xl: true, map: true, hor: true, wells: true }, dirty: true };
  let SV = null, gl = null, cv = null, ov = null, progT = null, progC = null, raf = 0, on = false;
  const tex = {}, touched = { il: true, xl: true, map: true };
  let horKey = '', horMesh = [], frame = null;

  /* ---------- small matrix kit (column-major 4x4) ---------- */
  function mul(a, b) { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; }
  function persp(fovy, asp, n, f) { const t = 1 / Math.tan(fovy / 2), o = new Float32Array(16); o[0] = t / asp; o[5] = t; o[10] = (f + n) / (n - f); o[11] = -1; o[14] = 2 * f * n / (n - f); return o; }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function lookAt(e, c, up) {
    const f = norm(sub(c, e)), s = norm(cross(f, up)), u = cross(s, f), o = new Float32Array(16);
    o[0] = s[0]; o[4] = s[1]; o[8] = s[2]; o[1] = u[0]; o[5] = u[1]; o[9] = u[2]; o[2] = -f[0]; o[6] = -f[1]; o[10] = -f[2];
    o[12] = -dot(s, e); o[13] = -dot(u, e); o[14] = dot(f, e); o[15] = 1; return o;
  }
  function project(m, p) { const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15]; return [x / w, y / w, w]; }

  /* ---------- scene frame: line numbers and time -> scene units ---------- */
  function makeFrame() {
    const M = SV.META, P = SV.P;
    const dx = Math.hypot(M.xl_axis_m[0], M.xl_axis_m[1]), dy = Math.hypot(M.il_axis_m[0], M.il_axis_m[1]);
    const X = (M.n_xl - 1) * dx, Y = (M.n_il - 1) * dy;
    // time range: what the inline section shows (its zoom), else the whole trace
    let t0 = M.t0_ms, t1 = M.t0_ms + (M.n_t - 1) * M.dt_ms;
    const im = P.il && P.il.img;
    if (im) { t0 = axisFracToValue(im.vAxis, 0); t1 = axisFracToValue(im.vAxis, 1); }
    if (!V.veUser) {                                             // until the slider is touched: the time axis about a third as long as the survey
      const auto = Math.max(1, Math.min(20, Math.round(0.35 * Math.max(X, Y) / Math.max(1, t1 - t0))));
      if (auto !== V.ve) { V.ve = auto; const r = $('v3-ve'), o = $('v3-ve-out'); if (r) r.value = auto; if (o) o.textContent = auto + '×'; }
    }
    const Z = (t1 - t0) * V.ve, sc = 2 / Math.max(X, Y, Z);
    return { M, dx, dy, X, Y, Z, t0, t1, sc,
      p(xl, il, t) { return [((xl - M.xl0) / M.xl_step * dx - X / 2) * sc, ((il - M.il0) / M.il_step * dy - Y / 2) * sc, (-(t - t0) * V.ve + Z / 2) * sc]; } };
  }
  function camera() {
    const asp = cv.width / cv.height, c = V.pan, e = [c[0] + V.dist * Math.cos(V.el) * Math.cos(V.az), c[1] + V.dist * Math.cos(V.el) * Math.sin(V.az), c[2] + V.dist * Math.sin(V.el)];
    return { eye: e, mvp: mul(persp(0.62, asp, 0.05, 60), lookAt(e, c, [0, 0, 1])) };
  }

  /* ---------- GL helpers ---------- */
  function shader(type, src) { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
  function program(vs, fs) { const p = gl.createProgram(); gl.attachShader(p, shader(gl.VERTEX_SHADER, vs)); gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p; }
  function initGL() {
    gl = cv.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: true });
    if (!gl) return false;
    progT = program('attribute vec3 p; attribute vec2 uv; uniform mat4 m; varying vec2 v; void main(){ v = uv; gl_Position = m * vec4(p, 1.0); }',
      'precision mediump float; varying vec2 v; uniform sampler2D s; uniform float a; void main(){ vec4 c = texture2D(s, v); gl_FragColor = vec4(c.rgb, a); }');
    progC = program('attribute vec3 p; attribute vec4 c; uniform mat4 m; varying vec4 v; void main(){ v = c; gl_Position = m * vec4(p, 1.0); gl_PointSize = 7.0; }',
      'precision mediump float; varying vec4 v; void main(){ gl_FragColor = v; }');
    gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
    return true;
  }
  function uploadTexture(key) {
    const im = SV.P[key] && SV.P[key].img;
    if (!im || !im.colored) return;
    if (!tex[key]) tex[key] = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex[key]);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, im.colored);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    tex[key].ok = true;
  }
  /** The four corners of a panel's image in the scene, in the order (u,v) = (0,0) (1,0) (1,1) (0,1). */
  function planeCorners(key, F) {
    const im = SV.P[key].img, S = SV.S, out = [];
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const h = axisFracToValue(im.hAxis, u), w = axisFracToValue(im.vAxis, v);
      if (key === 'il') out.push(F.p(h, Number.isFinite(im.info.line) ? im.info.line : S.il, w));
      else if (key === 'xl') out.push(F.p(Number.isFinite(im.info.line) ? im.info.line : S.xl, h, w));
      else { const xl = im.hKey === 'xl' ? h : w, il = im.hKey === 'il' ? h : w; out.push(F.p(xl, il, Number.isFinite(im.info.t) ? im.info.t : S.t)); }
    }
    return out;
  }
  function drawTextured(mvp, corners, t, alpha) {
    const a = new Float32Array([...corners[0], 0, 0, ...corners[1], 1, 0, ...corners[2], 1, 1, ...corners[0], 0, 0, ...corners[2], 1, 1, ...corners[3], 0, 1]);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, a, gl.STREAM_DRAW);
    gl.useProgram(progT);
    const lp = gl.getAttribLocation(progT, 'p'), lu = gl.getAttribLocation(progT, 'uv');
    gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(lu); gl.vertexAttribPointer(lu, 2, gl.FLOAT, false, 20, 12);
    gl.uniformMatrix4fv(gl.getUniformLocation(progT, 'm'), false, mvp); gl.uniform1f(gl.getUniformLocation(progT, 'a'), alpha);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(gl.getUniformLocation(progT, 's'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6); gl.deleteBuffer(b);
  }
  function drawColoured(mvp, data, mode, keep) {
    const b = keep || gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
    if (!keep) gl.bufferData(gl.ARRAY_BUFFER, data, gl.STREAM_DRAW);
    gl.useProgram(progC);
    const lp = gl.getAttribLocation(progC, 'p'), lc = gl.getAttribLocation(progC, 'c');
    gl.enableVertexAttribArray(lp); gl.vertexAttribPointer(lp, 3, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(lc); gl.vertexAttribPointer(lc, 4, gl.FLOAT, false, 28, 12);
    gl.uniformMatrix4fv(gl.getUniformLocation(progC, 'm'), false, mvp);
    gl.drawArrays(mode, 0, (keep ? keep.count : data.length / 7));
    if (!keep) gl.deleteBuffer(b);
  }

  /* ---------- followed events as surfaces ---------- */
  function hexRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; }
  function buildHorizons(F) {
    const hs = (window.SVWells && window.SVWells.state.horizons) || [];
    const key = hs.map((h) => h.name + (h.hidden ? '-' : '+') + h.color).join('|') + '|' + V.ve + '|' + F.t0 + '|' + F.t1;
    if (key === horKey) return;
    horKey = key;
    for (const m of horMesh) gl.deleteBuffer(m);
    horMesh = [];
    const M = F.M;
    for (const h of hs) {
      if (h.hidden) continue;
      const st = Math.max(1, Math.ceil(Math.max(h.n_il, h.n_xl) / 260)), ni = Math.floor((h.n_il - 1) / st) + 1, nx = Math.floor((h.n_xl - 1) / st) + 1;
      const base = hexRgb(h.color), val = (i, j) => { const v = h.grid[(i * st) * h.n_xl + j * st]; return v === -32768 ? NaN : v * 0.25; };
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < ni; i++) for (let j = 0; j < nx; j++) { const v = val(i, j); if (v === v) { if (v < lo) lo = v; if (v > hi) hi = v; } }
      const out = [];
      const vert = (i, j, v) => { const p = F.p(M.xl0 + j * st * M.xl_step, M.il0 + i * st * M.il_step, v), sh = 0.45 + 0.75 * (1 - (v - lo) / (hi - lo || 1)); out.push(p[0], p[1], p[2], Math.min(1, base[0] * sh), Math.min(1, base[1] * sh), Math.min(1, base[2] * sh), 0.9); };
      for (let i = 0; i < ni - 1; i++) for (let j = 0; j < nx - 1; j++) {
        const a = val(i, j), b = val(i, j + 1), c = val(i + 1, j + 1), d = val(i + 1, j);
        if (!(a === a && b === b && c === c && d === d)) continue;
        if (Math.max(a, b, c, d) - Math.min(a, b, c, d) > 60) continue;           // a jump: not one surface
        if (Math.max(a, b, c, d) < F.t0 || Math.min(a, b, c, d) > F.t1) continue;
        vert(i, j, a); vert(i, j + 1, b); vert(i + 1, j + 1, c); vert(i, j, a); vert(i + 1, j + 1, c); vert(i + 1, j, d);
      }
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(out), gl.STATIC_DRAW); buf.count = out.length / 7;
      horMesh.push(buf);
    }
  }

  /* ---------- one frame ---------- */
  function render() {
    raf = 0;
    if (!on || !gl || !SV || !SV.META) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2), w = Math.max(2, Math.round(cv.clientWidth * dpr)), h = Math.max(2, Math.round(cv.clientHeight * dpr));
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; ov.width = w; ov.height = h; }
    for (const k of ['il', 'xl', 'map']) if (touched[k]) { uploadTexture(k); touched[k] = false; }
    const F = frame = makeFrame(), cam = camera(), mvp = cam.mvp, S = SV.S, M = F.M;
    gl.viewport(0, 0, w, h); gl.clearColor(0.039, 0.078, 0.07, 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.BLEND);
    // box and plane outlines
    const xa = M.xl0, xb = M.xl0 + (M.n_xl - 1) * M.xl_step, ia = M.il0, ib = M.il0 + (M.n_il - 1) * M.il_step, L = [];
    const seg = (a, b, c) => L.push(a[0], a[1], a[2], c[0], c[1], c[2], c[3], b[0], b[1], b[2], c[0], c[1], c[2], c[3]);
    const g = [0.36, 0.45, 0.42, 1], C = (x, i, t) => F.p(x, i, t);
    for (const t of [F.t0, F.t1]) { seg(C(xa, ia, t), C(xb, ia, t), g); seg(C(xb, ia, t), C(xb, ib, t), g); seg(C(xb, ib, t), C(xa, ib, t), g); seg(C(xa, ib, t), C(xa, ia, t), g); }
    for (const [x, i] of [[xa, ia], [xb, ia], [xb, ib], [xa, ib]]) seg(C(x, i, F.t0), C(x, i, F.t1), g);
    const planes = [];
    for (const k of ['map', 'xl', 'il']) if (V.show[k] && tex[k] && tex[k].ok && SV.P[k].img) { const c = planeCorners(k, F); planes.push([k, c]); const col = k === 'il' ? [0.94, 0.44, 0.23, 1] : k === 'xl' ? [0.18, 0.8, 0.58, 1] : [1, 0.85, 0.3, 1]; for (let q = 0; q < 4; q++) seg(c[q], c[(q + 1) % 4], col); }
    for (const [k, c] of planes) drawTextured(mvp, c, tex[k], 1);
    // wells
    const st = window.SVWells && window.SVWells.state, labels = [];
    if (st && V.show.wells) for (let n = 0; n < st.wells.length; n++) {
      const wl = st.wells[n], sh = st.shift[wl.name] || 0, tdT = wl.td.twt, cur = n === st.cur, white = cur ? [1, 1, 1, 1] : [0.8, 0.86, 0.84, 1];
      const ta = Math.max(F.t0, Math.min(F.t1, wl.seabed_twt)), tb = Math.max(F.t0, Math.min(F.t1, tdT[tdT.length - 1] + sh));
      seg(C(wl.xl, wl.il, F.t0), C(wl.xl, wl.il, ta), [0.5, 0.56, 0.54, 1]); seg(C(wl.xl, wl.il, ta), C(wl.xl, wl.il, tb), white);
      labels.push([C(wl.xl, wl.il, F.t0), wl.name, '#ffffff', true]);
      const r = (xb - xa) * 0.012 * Math.sign(M.xl_step || 1), ri = r * F.dx / F.dy * (M.il_step / M.xl_step);
      for (const t of wl.tops) {
        const tt = t.twt + sh; if (tt < F.t0 || tt > F.t1) continue;
        const c = (TOP_COL[t.key] || [1, 1, 1]).concat(1);
        seg(C(wl.xl - r, wl.il, tt), C(wl.xl + r, wl.il, tt), c); seg(C(wl.xl, wl.il - ri, tt), C(wl.xl, wl.il + ri, tt), c);
        if (cur) labels.push([C(wl.xl, wl.il, tt), t.name.replace(' (predicted)', ''), 'rgb(' + c.slice(0, 3).map((v) => Math.round(v * 255)) + ')', false]);
      }
    }
    gl.lineWidth(1); drawColoured(mvp, new Float32Array(L), gl.LINES);
    // followed events on top, see-through
    if (V.show.hor) {
      buildHorizons(F);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      for (const m of horMesh) drawColoured(mvp, null, gl.TRIANGLES, m);
      gl.disable(gl.BLEND);
    }
    // labels on the overlay canvas
    const c2 = ov.getContext('2d'); c2.setTransform(1, 0, 0, 1, 0, 0); c2.clearRect(0, 0, w, h); c2.font = (11 * dpr) + 'px system-ui, sans-serif'; c2.textBaseline = 'middle';
    const put = (p, text, colour, bold, dxp) => {
      const q = project(mvp, p); if (q[2] <= 0) return;
      const x = (q[0] * 0.5 + 0.5) * w + (dxp || 8) * dpr, y = (1 - (q[1] * 0.5 + 0.5)) * h;
      c2.font = (bold ? '600 ' : '') + (11 * dpr) + 'px system-ui, sans-serif';
      const tw = c2.measureText(text).width; c2.fillStyle = 'rgba(8,16,14,.78)'; c2.fillRect(x - 3 * dpr, y - 8 * dpr, tw + 6 * dpr, 16 * dpr); c2.fillStyle = colour; c2.fillText(text, x, y);
    };
    for (const l of labels) put(l[0], l[1], l[2], l[3]);
    put(C((xa + xb) / 2, ia, F.t1), 'crossline ' + xa + ' – ' + xb, '#c5d0cb', false, -40);
    put(C(xa, (ia + ib) / 2, F.t1), 'inline ' + ia + ' – ' + ib, '#c5d0cb', false, -40);
    put(C(xa, ia, F.t0), Math.round(F.t0) + ' ms', '#c5d0cb', false, -52); put(C(xa, ia, F.t1), Math.round(F.t1) + ' ms', '#c5d0cb', false, -56);
    if (planes.length) { put(C(xb, S.il, F.t0), 'IL ' + S.il, '#f0703a', true); put(C(S.xl, ib, F.t0), 'XL ' + S.xl, '#2fcb93', true); put(C(xb, ib, S.t), S.t + ' ms', '#ffd84d', true); }
    $('v3-note').textContent = 'Time ' + Math.round(F.t0) + '–' + Math.round(F.t1) + ' ms, drawn ' + V.ve + ' m per ms. With rock near 2000 m/s that is about ' + V.ve + '× vertical exaggeration.';
  }
  function touch(key) { if (key) touched[key] = true; if (on && !raf) raf = requestAnimationFrame(render); }

  /* ---------- picking: click a plane to move the cross-hair ---------- */
  function pick(ex, ey) {
    if (!frame) return;
    const F = frame, r = cv.getBoundingClientRect(), cam = camera(), M = F.M, S = SV.S;
    const nx = (ex - r.left) / r.width * 2 - 1, ny = 1 - (ey - r.top) / r.height * 2;
    // ray through the pixel: unproject two depths with a brute inverse by sampling along the view direction
    const f = norm(sub(V.pan, cam.eye)), sdir = norm(cross(f, [0, 0, 1])), u = cross(sdir, f), th = Math.tan(0.31), asp = cv.width / cv.height;
    const d = norm([f[0] + sdir[0] * nx * th * asp + u[0] * ny * th, f[1] + sdir[1] * nx * th * asp + u[1] * ny * th, f[2] + sdir[2] * nx * th * asp + u[2] * ny * th]);
    // scene -> line numbers / time
    const inv = (p) => ({ xl: M.xl0 + ((p[0] / F.sc + F.X / 2) / F.dx) * M.xl_step, il: M.il0 + ((p[1] / F.sc + F.Y / 2) / F.dy) * M.il_step, t: F.t0 + (F.Z / 2 - p[2] / F.sc) / V.ve });
    const within = (q) => q.xl >= Math.min(M.xl0, M.xl0 + (M.n_xl - 1) * M.xl_step) && q.xl <= Math.max(M.xl0, M.xl0 + (M.n_xl - 1) * M.xl_step) &&
      q.il >= Math.min(M.il0, M.il0 + (M.n_il - 1) * M.il_step) && q.il <= Math.max(M.il0, M.il0 + (M.n_il - 1) * M.il_step) && q.t >= F.t0 && q.t <= F.t1;
    let best = null;
    const tryPlane = (axis, value, key) => {              // axis 0: x (crossline plane), 1: y (inline plane), 2: z (time slice)
      if (!V.show[key] || Math.abs(d[axis]) < 1e-9) return;
      const s = (value - cam.eye[axis]) / d[axis]; if (s <= 0) return;
      const p = [cam.eye[0] + d[0] * s, cam.eye[1] + d[1] * s, cam.eye[2] + d[2] * s], q = inv(p);
      if (within(q) && (!best || s < best.s)) best = { s, q, key };
    };
    tryPlane(1, F.p(S.xl, S.il, S.t)[1], 'il'); tryPlane(0, F.p(S.xl, S.il, S.t)[0], 'xl'); tryPlane(2, F.p(S.xl, S.il, S.t)[2], 'map');
    if (!best) return;
    const q = best.q;
    if (best.key === 'il') SV.setPos({ xl: q.xl, t: q.t }, 0, false); else if (best.key === 'xl') SV.setPos({ il: q.il, t: q.t }, 0, false); else SV.setPos({ il: q.il, xl: q.xl }, 0, false);
  }

  /* ---------- setup ---------- */
  function setOn(v, remember) {
    on = v; document.body.classList.toggle('with3d', on); $('p-3d').hidden = !on; $('v3-toggle').setAttribute('aria-pressed', String(on)); $('v3-toggle').textContent = on ? '3D view: on' : '3D view: off';
    if (remember) { try { localStorage.setItem('np-3d', on ? '1' : '0'); } catch (e) { /* private window */ } }   // only the user's own choice is kept
    for (const k in SV.P) SV.P[k].resize();
    if (on) { touched.il = touched.xl = touched.map = true; touch(); }
  }
  function init() {
    SV = window.SV; cv = $('v3-gl'); ov = $('v3-ov');
    if (!cv) return;
    let ok = false; try { ok = initGL(); } catch (e) { console.error(e); }
    if (!ok) { $('v3-note').textContent = 'This browser has no WebGL, so the 3D view is off.'; $('v3-toggle').disabled = true; return; }
    let drag = null, moved = false;
    cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, pan: e.shiftKey || e.button === 2 }; moved = false; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
      drag.x = e.clientX; drag.y = e.clientY;
      if (drag.pan) { const cam = camera(), f = norm(sub(V.pan, cam.eye)), s = norm(cross(f, [0, 0, 1])), u = cross(s, f), k = V.dist * 0.0016; V.pan = [V.pan[0] - (s[0] * dx - u[0] * dy) * k, V.pan[1] - (s[1] * dx - u[1] * dy) * k, V.pan[2] - (s[2] * dx - u[2] * dy) * k]; }
      else { V.az -= dx * 0.008; V.el = Math.max(-0.2, Math.min(1.5, V.el + dy * 0.008)); }
      touch();
    });
    cv.addEventListener('pointerup', (e) => { if (drag && !moved) pick(e.clientX, e.clientY); drag = null; });
    cv.addEventListener('pointercancel', () => { drag = null; });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('wheel', (e) => { e.preventDefault(); V.dist = Math.max(0.6, Math.min(12, V.dist * Math.exp(e.deltaY * 0.0012))); touch(); }, { passive: false });
    cv.addEventListener('dblclick', () => { V.az = -1.05; V.el = 0.42; V.dist = 2.25; V.pan = [0, 0, 0]; touch(); });
    $('v3-ve').addEventListener('input', (e) => { V.veUser = true; V.ve = Number(e.target.value); $('v3-ve-out').textContent = V.ve + '×'; touch(); });
    for (const k of ['il', 'xl', 'map', 'hor', 'wells']) $('v3-' + k).addEventListener('change', (e) => { V.show[k] = e.target.checked; touch(); });
    $('v3-reset').addEventListener('click', () => { V.az = -1.05; V.el = 0.42; V.dist = 2.25; V.pan = [0, 0, 0]; touch(); });
    $('v3-toggle').addEventListener('click', () => setOn(!on, true));
    if (window.ResizeObserver) new ResizeObserver(() => touch()).observe(cv);
    let want = true; try { want = localStorage.getItem('np-3d') !== '0'; } catch (e) { /* keep */ }
    setOn(want && window.innerWidth >= 900, false);
    window.SV3D.view = V;
  }
  window.SV3D = { touch, view: V };
  if (window.SV) init(); else window.addEventListener('sv-ready', init, { once: true });
})();
