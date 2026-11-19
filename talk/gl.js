// Nature's Plug talk: a small WebGL2 renderer. No dependencies and no build step, like the app.
// It draws lit meshes, instanced columns, lines, a textured ground plane and soft billboards.
(function () {
  "use strict";
  const PI = Math.PI;

  // ---------- 4x4 matrices, column-major ----------
  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      o[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
      o[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
      o[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      o[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    return o;
  }
  /** Perspective with a lens shift: sx, sy move the picture by that share of half the viewport. */
  function persp(fovy, aspect, near, far, sx, sy) {
    const f = 1 / Math.tan(fovy / 2), m = new Float32Array(16);
    m[0] = f / aspect; m[5] = f; m[10] = (far + near) / (near - far); m[11] = -1; m[14] = (2 * far * near) / (near - far);
    m[8] = -(sx || 0); m[9] = -(sy || 0);
    return m;
  }
  function lookAt(e, t) {
    let fx = t[0] - e[0], fy = t[1] - e[1], fz = t[2] - e[2];
    const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    let sx = -fz, sz = fx; const sl = Math.hypot(sx, sz) || 1; sx /= sl; sz /= sl;
    const ux = -sz * fy, uy = sz * fx - sx * fz, uz = sx * fy;
    const m = new Float32Array(16);
    m[0] = sx; m[1] = ux; m[2] = -fx; m[4] = 0; m[5] = uy; m[6] = -fy; m[8] = sz; m[9] = uz; m[10] = -fz;
    m[12] = -(sx * e[0] + sz * e[2]); m[13] = -(ux * e[0] + uy * e[1] + uz * e[2]); m[14] = fx * e[0] + fy * e[1] + fz * e[2]; m[15] = 1;
    return m;
  }
  const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  // ---------- geometry builder ----------
  class Geo {
    constructor() { this.p = []; this.n = []; this.c = []; this.i = []; }
    v(p, nrm, col) {
      const k = this.p.length / 3;
      this.p.push(p[0], p[1], p[2]); this.n.push(nrm[0], nrm[1], nrm[2]); this.c.push(col[0], col[1], col[2], col.length > 3 ? col[3] : 1);
      return k;
    }
    /** Four corners in order around the face. col2 colours the last two corners, for gradients. */
    quad(a, b, c, d, nrm, col, col2) {
      const k = this.v(a, nrm, col); this.v(b, nrm, col); this.v(c, nrm, col2 || col); this.v(d, nrm, col2 || col);
      this.i.push(k, k + 1, k + 2, k, k + 2, k + 3);
      return this;
    }
    box(x0, y0, z0, x1, y1, z1, col, colTop) {
      this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], col);
      this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], col);
      this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], col);
      this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], col);
      this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], colTop || col);
      this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], col);
      return this;
    }
    /**
     * A sector of a hollow cylinder around the y axis: radii r0..r1, heights y0..y1, angles a0..a1.
     * Angle 0 points along +x and a quarter turn along +z. colB colours the upper edge of the walls.
     */
    tube(o) {
      const r0 = o.r0 || 0, r1 = o.r1, y0 = o.y0, y1 = o.y1, a0 = o.a0 || 0, a1 = o.a1 == null ? 2 * PI : o.a1, seg = o.seg || 48;
      const cx = o.cx || 0, cz = o.cz || 0, col = o.col, colB = o.colB || col, colIn = o.colIn || col, colTop = o.colTop || colB, colCut = o.colCut || col;
      const full = Math.abs(a1 - a0) >= 2 * PI - 1e-6;
      const P = (r, c, s, y) => [cx + r * c, y, cz + r * s];
      for (let k = 0; k < seg; k++) {
        const ta = a0 + ((a1 - a0) * k) / seg, tb = a0 + ((a1 - a0) * (k + 1)) / seg;
        const ca = Math.cos(ta), sa = Math.sin(ta), cb = Math.cos(tb), sb = Math.sin(tb);
        if (o.outer !== false) {
          const q = this.v(P(r1, ca, sa, y0), [ca, 0, sa], col); this.v(P(r1, cb, sb, y0), [cb, 0, sb], col);
          this.v(P(r1, cb, sb, y1), [cb, 0, sb], colB); this.v(P(r1, ca, sa, y1), [ca, 0, sa], colB);
          this.i.push(q, q + 1, q + 2, q, q + 2, q + 3);
        }
        if (o.inner !== false && r0 > 0) {
          const q = this.v(P(r0, ca, sa, y0), [-ca, 0, -sa], colIn); this.v(P(r0, cb, sb, y0), [-cb, 0, -sb], colIn);
          this.v(P(r0, cb, sb, y1), [-cb, 0, -sb], colIn); this.v(P(r0, ca, sa, y1), [-ca, 0, -sa], colIn);
          this.i.push(q, q + 1, q + 2, q, q + 2, q + 3);
        }
        if (o.top !== false) this.quad(P(r0, ca, sa, y1), P(r1, ca, sa, y1), P(r1, cb, sb, y1), P(r0, cb, sb, y1), [0, 1, 0], colTop);
        if (o.bottom !== false) this.quad(P(r0, ca, sa, y0), P(r1, ca, sa, y0), P(r1, cb, sb, y0), P(r0, cb, sb, y0), [0, -1, 0], col);
      }
      if (o.cuts !== false && !full) {
        const ca = Math.cos(a0), sa = Math.sin(a0), cb = Math.cos(a1), sb = Math.sin(a1);
        this.quad(P(r0, ca, sa, y0), P(r1, ca, sa, y0), P(r1, ca, sa, y1), P(r0, ca, sa, y1), [sa, 0, -ca], colCut);
        this.quad(P(r0, cb, sb, y0), P(r1, cb, sb, y0), P(r1, cb, sb, y1), P(r0, cb, sb, y1), [-sb, 0, cb], colCut);
      }
      return this;
    }
  }

  /** Unit hexagonal prism: radius 1, height 0..1, a corner pointing along +z and -z. */
  function hexPrism() {
    const g = new Geo(), w = [1, 1, 1, 1], pts = [];
    for (let k = 0; k < 6; k++) { const a = (PI / 180) * (60 * k + 30); pts.push([Math.cos(a), Math.sin(a)]); }
    for (let k = 0; k < 6; k++) {
      const a = pts[k], b = pts[(k + 1) % 6], nx = (a[0] + b[0]) / 2, nz = (a[1] + b[1]) / 2, nl = Math.hypot(nx, nz);
      g.quad([a[0], 0, a[1]], [b[0], 0, b[1]], [b[0], 1, b[1]], [a[0], 1, a[1]], [nx / nl, 0, nz / nl], w);
    }
    const c = g.v([0, 1, 0], [0, 1, 0], w);
    for (let k = 0; k < 6; k++) g.v([pts[k][0], 1, pts[k][1]], [0, 1, 0], w);
    for (let k = 0; k < 6; k++) g.i.push(c, c + 1 + k, c + 1 + ((k + 1) % 6));
    return g;
  }
  /** Unit disc in the ground plane, facing up. */
  function disc(seg) {
    const g = new Geo(), w = [1, 1, 1, 1], c = g.v([0, 0, 0], [0, 1, 0], w);
    for (let k = 0; k <= seg; k++) { const a = (2 * PI * k) / seg; g.v([Math.cos(a), 0, Math.sin(a)], [0, 1, 0], w); }
    for (let k = 0; k < seg; k++) g.i.push(c, c + 1 + k, c + 2 + k);
    return g;
  }

  // ---------- shaders ----------
  const FOG = "vec3 fogged(vec3 c, vec3 w){ float d = length(uEye - w); return mix(c, uFog.rgb, 1.0 - exp(-uFog.a * d)); }\n";
  const LIT =
    "vec3 lit(vec3 base, vec3 nIn, vec3 w, float emis){ vec3 v = normalize(uEye - w); vec3 n = normalize(nIn); if (dot(n, v) < 0.0) n = -n;\n" +
    "  float dif = max(dot(n, uLight), 0.0); float hemi = 0.5 + 0.5 * n.y; float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);\n" +
    "  return base * (0.36 + 0.50 * dif + 0.20 * hemi) + base * rim * 0.35 + base * emis; }\n";
  const SRC = {
    mesh: [
      "#version 300 es\nlayout(location=0) in vec3 aPos; layout(location=1) in vec3 aNor; layout(location=2) in vec4 aCol;\n" +
      "uniform mat4 uVP; uniform mat4 uModel; out vec3 vW; out vec3 vN; out vec4 vC;\n" +
      "void main(){ vec4 w = uModel * vec4(aPos, 1.0); vW = w.xyz; vN = mat3(uModel) * aNor; vC = aCol; gl_Position = uVP * w; }",
      "#version 300 es\nprecision highp float; in vec3 vW; in vec3 vN; in vec4 vC;\n" +
      "uniform vec3 uEye; uniform vec3 uLight; uniform vec4 uFog; uniform float uAlpha; uniform float uEmis; uniform float uFlat; out vec4 o;\n" + FOG + LIT +
      "void main(){ vec3 c = mix(lit(vC.rgb, vN, vW, uEmis), vC.rgb, uFlat); o = vec4(fogged(c, vW), vC.a * uAlpha); }",
    ],
    inst: [
      "#version 300 es\nlayout(location=0) in vec3 aPos; layout(location=1) in vec3 aNor;\n" +
      "layout(location=3) in vec4 iA; layout(location=4) in vec4 iCol; layout(location=5) in float iDelay;\n" +
      "uniform mat4 uVP; uniform float uR; uniform float uT; uniform float uYS; uniform float uGap; out vec3 vW; out vec3 vN; out vec4 vC;\n" +
      "void main(){ float g = clamp((uT - iDelay) / 0.9, 0.0, 1.0); g = 1.0 - pow(1.0 - g, 3.0);\n" +
      "  vec3 w = vec3(iA.x + aPos.x * uR, (iA.z + aPos.y * iA.w * uGap) * uYS * g, iA.y + aPos.z * uR);\n" +
      "  vW = w; vN = aNor; vC = iCol; gl_Position = uVP * vec4(w, 1.0); }",
      "#version 300 es\nprecision highp float; in vec3 vW; in vec3 vN; in vec4 vC;\n" +
      "uniform vec3 uEye; uniform vec3 uLight; uniform vec4 uFog; uniform float uAlpha; uniform float uEmis; uniform float uFlat; uniform float uDim; out vec4 o;\n" + FOG + LIT +
      "void main(){ float k = mix(uDim, 1.0, vC.a); vec3 c = mix(lit(vC.rgb, vN, vW, uEmis), vC.rgb, uFlat) * k; o = vec4(fogged(c, vW), uAlpha); }",
    ],
    tex: [
      "#version 300 es\nlayout(location=0) in vec3 aPos; layout(location=1) in vec2 aUv; uniform mat4 uVP; out vec2 vUv; out vec3 vW;\n" +
      "void main(){ vUv = aUv; vW = aPos; gl_Position = uVP * vec4(aPos, 1.0); }",
      "#version 300 es\nprecision highp float; in vec2 vUv; in vec3 vW;\n" +
      "uniform sampler2D uTex; uniform vec3 uSea; uniform vec3 uEye; uniform vec4 uFog; uniform vec4 uSpot; uniform float uAlpha; out vec4 o;\n" + FOG +
      "void main(){ vec3 c = uSea;\n" +
      "  if (vUv.x > 0.0 && vUv.x < 1.0 && vUv.y > 0.0 && vUv.y < 1.0) { vec2 e = smoothstep(vec2(0.0), vec2(0.06), vUv) * smoothstep(vec2(1.0), vec2(0.94), vUv); c = mix(uSea, texture(uTex, vUv).rgb, e.x * e.y); }\n" +
      "  float s = 1.0 - smoothstep(0.0, uSpot.z, length(vW.xz - uSpot.xy)); c += c * s * s * uSpot.w;\n" +
      "  o = vec4(fogged(c, vW), uAlpha); }",
    ],
    line: [
      "#version 300 es\nlayout(location=0) in vec3 aPos; layout(location=2) in vec4 aCol; uniform mat4 uVP; out vec4 vC; out vec3 vW;\n" +
      "void main(){ vC = aCol; vW = aPos; gl_Position = uVP * vec4(aPos, 1.0); }",
      "#version 300 es\nprecision highp float; in vec4 vC; in vec3 vW; uniform vec3 uEye; uniform vec4 uFog; uniform float uAlpha; out vec4 o;\n" + FOG +
      "void main(){ float d = length(uEye - vW); o = vec4(vC.rgb, vC.a * uAlpha * exp(-uFog.a * d)); }",
    ],
    bill: [
      "#version 300 es\nlayout(location=0) in vec2 aCorner; layout(location=3) in vec4 iPos; layout(location=4) in vec4 iCol;\n" +
      "uniform mat4 uVP; uniform vec2 uF; out vec2 vP; out vec4 vC;\n" +
      "void main(){ vec4 c = uVP * vec4(iPos.xyz, 1.0); c.xy += aCorner * uF * iPos.w; vP = aCorner; vC = iCol; gl_Position = c; }",
      "#version 300 es\nprecision highp float; in vec2 vP; in vec4 vC; uniform float uAlpha; uniform float uSoft; out vec4 o;\n" +
      "void main(){ float d = dot(vP, vP); if (d > 1.0) discard; o = vec4(vC.rgb, vC.a * uAlpha * pow(1.0 - d, uSoft)); }",
    ],
  };

  function create(canvas) {
    let gl = null;
    try { gl = canvas.getContext("webgl2", { antialias: true, alpha: false, depth: true, powerPreference: "high-performance" }); } catch (e) { gl = null; }
    if (!gl) return null;

    const prog = {};
    for (const name of Object.keys(SRC)) {
      const p = gl.createProgram();
      for (const [type, src] of [[gl.VERTEX_SHADER, SRC[name][0]], [gl.FRAGMENT_SHADER, SRC[name][1]]]) {
        const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("shader " + name + ": " + gl.getShaderInfoLog(s));
        gl.attachShader(p, s);
      }
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("program " + name + ": " + gl.getProgramInfoLog(p));
      const u = {}, nU = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let k = 0; k < nU; k++) { const info = gl.getActiveUniform(p, k); u[info.name] = gl.getUniformLocation(p, info.name); }
      prog[name] = { p, u };
    }

    const buf = (data, usage) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, usage || gl.STATIC_DRAW); return b; };
    const attr = (loc, size, divisor) => { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0); if (divisor) gl.vertexAttribDivisor(loc, divisor); };

    class Mesh {
      constructor(geo, dynamic) {
        this.vao = gl.createVertexArray(); this.usage = dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW;
        gl.bindVertexArray(this.vao);
        this.bp = buf(new Float32Array(0)); attr(0, 3); this.bn = buf(new Float32Array(0)); attr(1, 3); this.bc = buf(new Float32Array(0)); attr(2, 4);
        this.bi = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bi);
        gl.bindVertexArray(null);
        this.set(geo);
      }
      set(geo) {
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bp); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(geo.p), this.usage);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bn); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(geo.n), this.usage);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bc); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(geo.c), this.usage);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bi); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(geo.i), this.usage);
        gl.bindVertexArray(null);
        this.count = geo.i.length;
      }
      draw() { gl.bindVertexArray(this.vao); gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0); }
    }

    /** One base shape drawn many times. Per instance: a = [x, z, y0, height], c = [r, g, b, highlight], d = delay. */
    class Inst {
      constructor(geo, n, loop) {
        this.n = n; this.loop = !!loop;
        this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
        buf(new Float32Array(geo.p)); attr(0, 3); buf(new Float32Array(geo.n)); attr(1, 3);
        this.ba = buf(new Float32Array(n * 4), gl.DYNAMIC_DRAW); attr(3, 4, 1);
        this.bc = buf(new Float32Array(n * 4), gl.DYNAMIC_DRAW); attr(4, 4, 1);
        this.bd = buf(new Float32Array(n), gl.DYNAMIC_DRAW); attr(5, 1, 1);
        if (!loop) { const bi = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bi); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(geo.i), gl.STATIC_DRAW); }
        gl.bindVertexArray(null);
        this.count = loop ? geo.p.length / 3 : geo.i.length;
      }
      setA(a) { gl.bindBuffer(gl.ARRAY_BUFFER, this.ba); gl.bufferSubData(gl.ARRAY_BUFFER, 0, a); }
      setC(c) { gl.bindBuffer(gl.ARRAY_BUFFER, this.bc); gl.bufferSubData(gl.ARRAY_BUFFER, 0, c); }
      setD(d) { gl.bindBuffer(gl.ARRAY_BUFFER, this.bd); gl.bufferSubData(gl.ARRAY_BUFFER, 0, d); }
      draw(n) {
        gl.bindVertexArray(this.vao);
        if (this.loop) gl.drawArraysInstanced(gl.LINE_LOOP, 0, this.count, n == null ? this.n : n);
        else gl.drawElementsInstanced(gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0, n == null ? this.n : n);
      }
    }

    class Lines {
      constructor(pos, col) {
        this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
        this.bp = buf(new Float32Array(pos), gl.DYNAMIC_DRAW); attr(0, 3); this.bc = buf(new Float32Array(col), gl.DYNAMIC_DRAW); attr(2, 4);
        gl.bindVertexArray(null); this.count = pos.length / 3;
      }
      set(pos, col) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bp); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.bc); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(col), gl.DYNAMIC_DRAW);
        this.count = pos.length / 3;
      }
      draw() { gl.bindVertexArray(this.vao); gl.drawArrays(gl.LINES, 0, this.count); }
    }

    /** Camera-facing soft discs. Per instance: pos = [x, y, z, radius], col = [r, g, b, a]. */
    class Bills {
      constructor(n) {
        this.n = n; this.pos = new Float32Array(n * 4); this.col = new Float32Array(n * 4);
        this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
        buf(new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1])); attr(0, 2);
        this.bp = buf(this.pos, gl.DYNAMIC_DRAW); attr(3, 4, 1); this.bc = buf(this.col, gl.DYNAMIC_DRAW); attr(4, 4, 1);
        gl.bindVertexArray(null);
      }
      upload() { gl.bindBuffer(gl.ARRAY_BUFFER, this.bp); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.pos); gl.bindBuffer(gl.ARRAY_BUFFER, this.bc); gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.col); }
      draw(n) { gl.bindVertexArray(this.vao); gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n == null ? this.n : n); }
    }

    /** A horizontal plane at y = 0 with a texture laid over part of it. */
    class Ground {
      constructor(half, uvOf, source) {
        const p = [], uv = [];
        for (const [x, z] of [[-half, -half], [half, -half], [half, half], [-half, -half], [half, half], [-half, half]]) { p.push(x, 0, z); const t = uvOf(x, z); uv.push(t[0], t[1]); }
        this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
        buf(new Float32Array(p)); attr(0, 3); buf(new Float32Array(uv)); attr(1, 2);
        gl.bindVertexArray(null);
        this.tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        const an = gl.getExtension("EXT_texture_filter_anisotropic");
        if (an) gl.texParameterf(gl.TEXTURE_2D, an.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(16, gl.getParameter(an.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
      }
      draw() { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex); gl.bindVertexArray(this.vao); gl.drawArrays(gl.TRIANGLES, 0, 6); }
    }

    const view = { w: 1, h: 1, dpr: 1, vp: IDENT, eye: [0, 0, 1], f: 1, aspect: 1 };
    function resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1), w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
      const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
      if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
      view.w = w; view.h = h; view.dpr = dpr; view.aspect = w / h;
    }

    /** Start a frame: set the camera and clear. cam = { t, az, el, dist, fov, sx, sy, near, far }, bg = [r, g, b]. */
    function begin(cam, bg) {
      resize();
      const ce = Math.cos(cam.el), eye = [cam.t[0] + cam.dist * ce * Math.sin(cam.az), cam.t[1] + cam.dist * Math.sin(cam.el), cam.t[2] + cam.dist * ce * Math.cos(cam.az)];
      view.eye = eye; view.f = 1 / Math.tan(cam.fov / 2);
      view.vp = mul(persp(cam.fov, view.aspect, cam.near, cam.far, cam.sx, cam.sy), lookAt(eye, cam.t));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(bg[0], bg[1], bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(true);
    }
    /** Select a program and set the uniforms it has. */
    function use(name, un) {
      const P = prog[name]; gl.useProgram(P.p);
      if (P.u.uVP) gl.uniformMatrix4fv(P.u.uVP, false, view.vp);
      if (P.u.uEye) gl.uniform3fv(P.u.uEye, view.eye);
      if (P.u.uF) gl.uniform2f(P.u.uF, view.f / view.aspect, view.f);
      if (P.u.uModel) gl.uniformMatrix4fv(P.u.uModel, false, IDENT);
      if (P.u.uTex) gl.uniform1i(P.u.uTex, 0);
      for (const k in un) {
        const loc = P.u[k], v = un[k]; if (!loc) continue;
        if (typeof v === "number") gl.uniform1f(loc, v);
        else if (v.length === 2) gl.uniform2fv(loc, v); else if (v.length === 3) gl.uniform3fv(loc, v); else if (v.length === 4) gl.uniform4fv(loc, v);
      }
    }
    const blend = (mode) => { if (mode === "add") gl.blendFunc(gl.SRC_ALPHA, gl.ONE); else gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); };
    const depthWrite = (on) => gl.depthMask(!!on);

    /** World point -> CSS pixels in the canvas, or null when it is behind the camera. */
    function project(x, y, z) {
      const m = view.vp, w = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (w <= 1e-6) return null;
      const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w, cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
      return [(cx * 0.5 + 0.5) * view.w, (0.5 - cy * 0.5) * view.h, w];
    }

    return { gl, view, Geo, Mesh, Inst, Lines, Bills, Ground, begin, use, blend, depthWrite, project, resize };
  }

  window.NPGL = { create, Geo, hexPrism, disc };
})();
