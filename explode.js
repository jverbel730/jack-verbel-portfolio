/* Jack Verbel — interactive exploded view.

   A purpose-built WebGL2 glTF viewer. Scroll drives a camera path that pulls
   the assembly apart and pushes in on each part in turn; drag orbits it freely
   at any point.

   Why not three.js: this build environment has no network access to any CDN or
   package registry, so three.js could not be fetched, vendored or tested. Code
   that loads a library at runtime but was never once executed against it is not
   something to put on a portfolio. Everything here runs against the raw WebGL2
   API and is exercised locally before it ships, at a fraction of the size.

   Rendering, in order of how much each one mattered:

     1. A real shadow pass. Parts casting onto each other is most of what
        separates "a render" from "some shaded triangles". 2048² depth map from
        the key light, 3×3 PCF, ortho frustum refitted as the assembly spreads.
     2. An analytic studio environment. There is no HDR to sample, so the
        surroundings are a function: a bright overhead softbox, a white sweep
        in front, a darker floor. Metals reflect it, dielectrics take diffuse
        irradiance from it. Without something to reflect, chrome reads as grey
        paint.
     3. ACES filmic tonemapping instead of Reinhard, which is what stops the
        highlights going chalky and the blacks going muddy.

   Scroll contract: a tall container with a sticky canvas. Page scroll is read,
   never intercepted -- no preventDefault on wheel, no scroll-jacking.

   Requires an UNCOMPRESSED .glb (no Draco, no meshopt). */
(function () {
  'use strict';

  var host = document.getElementById('exploded');
  if (!host) return;

  var SRC = host.dataset.model;
  var canvas = host.querySelector('canvas');
  var label = host.querySelector('.xv-label');
  var nameEl = host.querySelector('.xv-name');
  var noteEl = host.querySelector('.xv-note');
  var bar = host.querySelector('.xv-bar span');
  var track = host.closest('.xv-track') || host.parentElement;

  var gl = canvas.getContext('webgl2', {
    antialias: true, alpha: true, premultipliedAlpha: false
  });
  if (!gl) { host.classList.add('xv-fallback'); return; }

  var reduce = window.matchMedia &&
               window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ~5 MB of geometry: on a metered connection the rendered animation already
  // in the markup is the better answer, so bail before fetching anything
  var conn = navigator.connection || navigator.webkitConnection;
  if (conn && (conn.saveData || /^(slow-)?2g$/.test(conn.effectiveType || ''))) {
    host.classList.add('xv-fallback');
    return;
  }

  /* ------------------------------------------------------------ math */
  function mul(a, b) {
    var o = new Float32Array(16);
    for (var c = 0; c < 4; c++)
      for (var r = 0; r < 4; r++) {
        var s = 0;
        for (var k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        o[c * 4 + r] = s;
      }
    return o;
  }
  function perspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0,
      0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  }
  function ortho(r, t, n, f) {
    return new Float32Array([1 / r, 0, 0, 0, 0, 1 / t, 0, 0,
      0, 0, -2 / (f - n), 0, 0, 0, -(f + n) / (f - n), 1]);
  }
  function lookAt(eye, at, up) {
    var z = norm(sub(eye, at)), x = norm(cross(up, z)), y = cross(z, x);
    return new Float32Array([
      x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
      -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
  }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]];
  }
  function norm(v) {
    var l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* ------------------------------------------------------------ shaders */
  var VS = `#version 300 es
  in vec3 aPos; in vec3 aNrm; in vec2 aUV;
  uniform mat4 uProj, uView, uModel, uLightVP; uniform mat3 uNrm;
  out vec3 vN; out vec3 vP; out vec2 vUV; out vec4 vLP;
  void main(){
    vec4 wp = uModel * vec4(aPos,1.0);
    vP = wp.xyz; vN = normalize(uNrm * aNrm); vUV = aUV;
    vLP = uLightVP * wp;
    gl_Position = uProj * uView * wp;
  }`;

  var FS = `#version 300 es
  precision highp float;
  precision highp sampler2DShadow;
  in vec3 vN; in vec3 vP; in vec2 vUV; in vec4 vLP;
  uniform vec3 uEye, uColor, uLightDir;
  uniform float uMetal, uRough, uAlpha, uFade, uHasTex, uShadowOn, uTexel;
  uniform sampler2D uTex;
  uniform sampler2DShadow uShadow;
  out vec4 frag;

  /* The studio, as a function. A big softbox overhead, a white sweep in front,
     a darker floor -- roughly the set the KeyShot renders were lit in. Metals
     reflect this; dielectrics take their fill from it. */
  vec3 env(vec3 d, float rough){
    /* A polished part is a mirror, and a mirror of a flat grey is just flat
       grey -- which is why the movement and caseback first came out looking
       like white plastic. So the environment has actual features to reflect:
       a hard horizon, an overhead softbox, and two strip lights. The horizon
       edge in particular is what reads as chrome. */
    float y = d.y;
    vec3 ground = mix(vec3(0.06,0.06,0.07), vec3(0.34,0.34,0.36),
                      smoothstep(-1.0, -0.04, y));
    vec3 sky = mix(vec3(0.52,0.54,0.58), vec3(0.86,0.88,0.92),
                   smoothstep(0.0, 0.85, y));

    // overhead softbox, wider across x than z, like a real strip box
    float box = smoothstep(0.58, 0.96, y) * (1.0 - 0.45 * abs(d.z));
    sky += vec3(3.1,3.1,3.2) * box;

    // two rim strips, left-behind and right-front
    sky += vec3(1.5,1.52,1.6) *
           smoothstep(0.86, 1.0, dot(normalize(vec3(-0.78,0.34,-0.52)), d));
    sky += vec3(1.0,1.0,1.05) *
           smoothstep(0.90, 1.0, dot(normalize(vec3(0.72,0.18,0.66)), d));

    // the sharp horizon: a mirror needs a hard edge somewhere to read as one
    vec3 col = mix(ground, sky, smoothstep(-0.035, 0.02, y));

    /* White sweep in front. It carries a top-to-bottom gradient on purpose: a
       flat disc facing the camera reflects almost this term alone, and a
       constant one renders it as a dead grey circle -- which is how the
       movement first came out. The gradient gives flat faces a falloff. */
    col += vec3(0.34,0.35,0.37) * smoothstep(0.25, 1.0, d.z * 0.5 + 0.5)
           * (0.35 + 1.05 * smoothstep(-0.65, 0.75, y));

    // roughness blurs the whole thing toward a flat average
    return mix(col, vec3(0.60,0.61,0.64), rough * rough * 0.8);
  }

  float ggx(vec3 N, vec3 V, vec3 L, float r){
    vec3 H = normalize(V+L);
    float a = max(r*r, 0.0015);
    float nh = max(dot(N,H),0.0), nv = max(dot(N,V),1e-4), nl = max(dot(N,L),0.0);
    float d = (nh*nh)*(a*a-1.0)+1.0;
    float D = (a*a)/(3.14159*d*d);
    float k = (r+1.0)*(r+1.0)/8.0;
    float G = (nl/(nl*(1.0-k)+k))*(nv/(nv*(1.0-k)+k));
    return D*G/(4.0*nv*nl+1e-4);
  }
  vec3 fres(vec3 F0, float c){ return F0 + (1.0-F0)*pow(1.0-c, 5.0); }

  // 3x3 PCF. Hardware comparison does the bilinear part, this softens the rest.
  float shadow(){
    if(uShadowOn < 0.5) return 1.0;
    vec3 p = vLP.xyz / vLP.w * 0.5 + 0.5;
    if(p.z > 1.0 || p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return 1.0;
    float s = 0.0;
    for(int y=-1; y<=1; y++)
      for(int x=-1; x<=1; x++)
        s += texture(uShadow, vec3(p.xy + vec2(float(x),float(y))*uTexel, p.z - 0.0022));
    return s / 9.0;
  }

  vec3 aces(vec3 x){
    return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0);
  }

  void main(){
    vec3 N = normalize(vN), V = normalize(uEye - vP);
    if(!gl_FrontFacing) N = -N;
    vec3 base = uColor;
    if(uHasTex > 0.5) base *= texture(uTex, vUV).rgb;

    float rough = clamp(uRough, 0.035, 1.0);
    vec3 albedo = base * (1.0 - uMetal);
    vec3 F0 = mix(vec3(0.04), base, uMetal);
    vec3 R = reflect(-V, N);
    float nv = max(dot(N,V), 1e-4);

    // key light, shadowed
    vec3 L = normalize(uLightDir);
    float nl = max(dot(N,L), 0.0);
    float sh = shadow();
    vec3 c = (albedo/3.14159 + vec3(ggx(N,V,L,rough))*F0) * nl * 3.0 * sh;

    // two unshadowed fills, so the dark side never goes to pure black
    vec3 L2 = normalize(vec3(-0.72, 0.28, 0.52));
    vec3 L3 = normalize(vec3(0.15, -0.55, -0.80));
    c += (albedo/3.14159 + vec3(ggx(N,V,L2,rough))*F0) * max(dot(N,L2),0.0) * 0.85;
    c += (albedo/3.14159 + vec3(ggx(N,V,L3,rough))*F0) * max(dot(N,L3),0.0) * 0.40;

    // image-based terms off the analytic environment
    vec3 irr = env(N, 1.0);
    vec3 spec = env(R, rough);
    // ambient occlusion is approximated by the shadow term, which keeps
    // crevices from picking up full sky
    float ao = mix(0.55, 1.0, sh);
    c += albedo * irr * 0.55 * ao;
    c += spec * fres(F0, nv) * mix(1.0, 0.25, rough) * ao;

    c = aces(c * 0.62);
    c = pow(c, vec3(1.0/2.2));
    c = mix(vec3(1.0), c, uFade);
    frag = vec4(c, uAlpha);
  }`;

  var DVS = `#version 300 es
  in vec3 aPos; uniform mat4 uLightVP, uModel;
  void main(){ gl_Position = uLightVP * uModel * vec4(aPos,1.0); }`;
  var DFS = `#version 300 es
  precision highp float; void main(){}`;

  function compile(t, src) {
    var s = gl.createShader(t);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function link(vs, fs) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.bindAttribLocation(p, 1, 'aNrm');
    gl.bindAttribLocation(p, 2, 'aUV');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(p));
    return p;
  }

  var prog = link(VS, FS), dprog = link(DVS, DFS);
  var U = {}, D = {};
  ['uProj', 'uView', 'uModel', 'uNrm', 'uEye', 'uColor', 'uMetal', 'uRough',
    'uAlpha', 'uFade', 'uHasTex', 'uTex', 'uShadow', 'uLightVP', 'uLightDir',
    'uShadowOn', 'uTexel'].forEach(function (n) {
    U[n] = gl.getUniformLocation(prog, n);
  });
  ['uLightVP', 'uModel'].forEach(function (n) {
    D[n] = gl.getUniformLocation(dprog, n);
  });

  /* --------------------------------------------------- shadow map target */
  // half-resolution depth map on phones: the shader is fill-bound and a
  // 2048 map is a lot of memory and bandwidth for a 400px canvas
  var SHADOW = (window.innerWidth < 700 ? 1024 : 2048);
  var shadowTex = null, shadowFB = null, shadowOK = false;
  (function () {
    shadowTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, shadowTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, SHADOW, SHADOW, 0,
      gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    shadowFB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D,
      shadowTex, 0);
    shadowOK = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  })();

  var LIGHT = norm([0.40, 0.82, 0.52]);

  /* ------------------------------------------------------------ glb */
  var COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
    5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
  var NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

  function parseGLB(buf) {
    var dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546C67) throw new Error('not a glb');
    var off = 12, json = null, bin = null;
    while (off < dv.byteLength) {
      var len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
      var body = buf.slice(off + 8, off + 8 + len);
      if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(body));
      else if (type === 0x004E4942) bin = body;
      off += 8 + len + ((4 - len % 4) % 4);
    }
    if (!json) throw new Error('no json chunk');
    if (json.extensionsRequired && json.extensionsRequired.length)
      throw new Error('needs ' + json.extensionsRequired.join(', '));
    return { json: json, bin: bin };
  }

  function readAccessor(g, i) {
    var a = g.json.accessors[i];
    var v = g.json.bufferViews[a.bufferView];
    var TA = COMP[a.componentType], n = NUM[a.type];
    var base = (v.byteOffset || 0) + (a.byteOffset || 0);
    var stride = v.byteStride;
    if (!stride || stride === n * TA.BYTES_PER_ELEMENT)
      return new TA(g.bin, base, a.count * n);
    var out = new TA(a.count * n);
    for (var k = 0; k < a.count; k++)
      out.set(new TA(g.bin, base + k * stride, n), k * n);
    return out;
  }

  function nodeMatrix(nd) {
    if (nd.matrix) return new Float32Array(nd.matrix);
    var t = nd.translation || [0, 0, 0], r = nd.rotation || [0, 0, 0, 1],
      s = nd.scale || [1, 1, 1];
    var x = r[0], y = r[1], z = r[2], w = r[3];
    var x2 = x + x, y2 = y + y, z2 = z + z;
    var xx = x * x2, xy = x * y2, xz = x * z2;
    var yy = y * y2, yz = y * z2, zz = z * z2;
    var wx = w * x2, wy = w * y2, wz = w * z2;
    return new Float32Array([
      (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
      (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
      (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
      t[0], t[1], t[2], 1]);
  }

  function bindAttr(loc, arr, n) {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    if (arr instanceof Int8Array) gl.vertexAttribPointer(loc, n, gl.BYTE, true, 0, 0);
    else if (arr instanceof Int16Array) gl.vertexAttribPointer(loc, n, gl.SHORT, false, 0, 0);
    else if (arr instanceof Uint16Array) gl.vertexAttribPointer(loc, n, gl.UNSIGNED_SHORT, false, 0, 0);
    else gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 0, 0);
  }

  function boxOf(pos, m) {
    var lo = [1e30, 1e30, 1e30], hi = [-1e30, -1e30, -1e30];
    for (var i = 0; i < pos.length; i += 3) {
      var x = pos[i], y = pos[i + 1], z = pos[i + 2];
      var w0 = m[0] * x + m[4] * y + m[8] * z + m[12];
      var w1 = m[1] * x + m[5] * y + m[9] * z + m[13];
      var w2 = m[2] * x + m[6] * y + m[10] * z + m[14];
      if (w0 < lo[0]) lo[0] = w0; if (w0 > hi[0]) hi[0] = w0;
      if (w1 < lo[1]) lo[1] = w1; if (w1 > hi[1]) hi[1] = w1;
      if (w2 < lo[2]) lo[2] = w2; if (w2 > hi[2]) hi[2] = w2;
    }
    return { lo: lo, hi: hi };
  }

  var parts = [], bounds = null, ready = false, failed = false, texes = [];

  function build(g) {
    var scene = g.json.scenes[g.json.scene || 0], seen = [];

    function prim(p) {
      if (p.attributes.POSITION === undefined) return null;
      var pos = readAccessor(g, p.attributes.POSITION);
      var nrm = p.attributes.NORMAL !== undefined ? readAccessor(g, p.attributes.NORMAL) : null;
      var uv = p.attributes.TEXCOORD_0 !== undefined ? readAccessor(g, p.attributes.TEXCOORD_0) : null;
      var idx = p.indices !== undefined ? readAccessor(g, p.indices) : null;

      var vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      bindAttr(0, pos, 3);
      if (nrm) bindAttr(1, nrm, 3);
      if (uv) bindAttr(2, uv, 2); else { gl.disableVertexAttribArray(2); gl.vertexAttrib2f(2, 0, 0); }
      var count, itype;
      if (idx) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
        count = idx.length;
        itype = idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      } else count = pos.length / 3;
      gl.bindVertexArray(null);

      var mat = p.material !== undefined ? g.json.materials[p.material] : {};
      var pbr = mat.pbrMetallicRoughness || {};
      var col = pbr.baseColorFactor || [0.8, 0.8, 0.8, 1];
      return {
        vao: vao, count: count, indexed: !!idx, itype: itype,
        color: [col[0], col[1], col[2]],
        metal: pbr.metallicFactor !== undefined ? pbr.metallicFactor : 1,
        rough: pbr.roughnessFactor !== undefined ? pbr.roughnessFactor : 1,
        alpha: col[3] !== undefined ? col[3] : 1,
        tex: pbr.baseColorTexture ? pbr.baseColorTexture.index : -1,
        pos: pos
      };
    }

    function walk(ni, parent) {
      var nd = g.json.nodes[ni];
      var m = mul(parent, nodeMatrix(nd));
      if (nd.mesh !== undefined) {
        var mesh = g.json.meshes[nd.mesh], prims = [];
        mesh.primitives.forEach(function (p) { var q = prim(p); if (q) prims.push(q); });
        if (prims.length) {
          var lo = [1e30, 1e30, 1e30], hi = [-1e30, -1e30, -1e30];
          prims.forEach(function (q) {
            var b = boxOf(q.pos, m);
            for (var k = 0; k < 3; k++) {
              lo[k] = Math.min(lo[k], b.lo[k]); hi[k] = Math.max(hi[k], b.hi[k]);
            }
            q.pos = null;
          });
          seen.push({
            name: nd.name || mesh.name || ('part ' + seen.length),
            model: m, prims: prims,
            box: { lo: lo, hi: hi,
              c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
              r: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 }
          });
        }
      }
      (nd.children || []).forEach(function (c) { walk(c, m); });
    }

    var I = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    scene.nodes.forEach(function (n) { walk(n, I); });
    return seen;
  }

  function loadTextures(g) {
    if (!g.json.textures) return Promise.resolve();
    return Promise.all(g.json.textures.map(function (t, i) {
      var im = g.json.images[t.source];
      if (!im || im.bufferView === undefined) return null;
      var v = g.json.bufferViews[im.bufferView];
      var blob = new Blob([new Uint8Array(g.bin, v.byteOffset || 0, v.byteLength)],
        { type: im.mimeType || 'image/jpeg' });
      return createImageBitmap(blob).then(function (bmp) {
        var t2 = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t2);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        texes[i] = t2;
        if (bmp.close) bmp.close();
      }).catch(function () {});
    }).filter(Boolean));
  }

  /* ------------------------------------------------------------ timeline */
  var progress = 0, explode = 0, focus = -1, hold = 0;
  var camYaw = 0, camPitch = 0, camZoom = 1;
  var rank = [], spacing = 1, STOPS = [];

  function buildSpread() {
    var byZ = parts.map(function (p, i) { return i; })
      .sort(function (a, b) { return parts[a].box.c[2] - parts[b].box.c[2]; });
    rank = new Array(parts.length);
    byZ.forEach(function (pi, k) { rank[pi] = k; });
    var radii = parts.map(function (p) { return p.box.r; }).sort(function (a, b) { return a - b; });
    spacing = (radii[Math.floor(radii.length / 2)] || bounds.r * 0.3) * 0.62;
  }
  function offsetFor(i) { return (rank[i] - (parts.length - 1) / 2) * spacing; }

  /* Each stop carries its own camera, so the move between beats is a real
     change of viewpoint rather than one slow turntable. Angles alternate high
     and low and cross the front, which reads as deliberate camera work. */
  var ANGLES = [
    [-0.62, 0.30, 1.00], [0.55, 0.14, 0.94], [-1.15, 0.52, 1.06],
    [0.95, -0.22, 0.90], [-0.35, 0.66, 1.02], [1.35, 0.30, 0.96],
    [-1.55, 0.08, 0.92], [0.20, -0.44, 1.00], [-0.85, 0.44, 0.95],
    [1.10, 0.58, 1.04], [-0.20, 0.18, 0.90], [0.70, -0.10, 0.98]
  ];

  function buildTimeline() {
    var wanted = (host.dataset.tour || '').split(',')
      .map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
    var order = [];
    if (wanted.length) {
      wanted.forEach(function (w) {
        parts.forEach(function (p, i) {
          if (p.name.toLowerCase() === w && order.indexOf(i) < 0) order.push(i);
        });
      });
    }
    if (!order.length) {
      order = parts.map(function (p, i) { return i; })
        .filter(function (i) { return parts[i].box.r > bounds.r * 0.09; })
        .sort(function (a, b) { return parts[b].box.c[2] - parts[a].box.c[2]; });
    }

    STOPS = [
      { explode: 0, focus: -1, yaw: -0.62, pitch: 0.26, zoom: 1.00 },
      { explode: 0, focus: -1, yaw: 0.48, pitch: 0.10, zoom: 0.86 },
      { explode: 1, focus: -1, yaw: -1.05, pitch: 0.46, zoom: 1.08 }
    ];
    order.forEach(function (pi, k) {
      var a = ANGLES[k % ANGLES.length];
      STOPS.push({ explode: 1, focus: pi, yaw: a[0], pitch: a[1], zoom: a[2] });
    });
    STOPS.push({ explode: 1, focus: -1, yaw: 0.85, pitch: 0.36, zoom: 1.10 });
    STOPS.push({ explode: 0, focus: -1, yaw: -0.45, pitch: 0.24, zoom: 0.92 });
  }

  /* Dwell, then move. Each stop owns a slot of the scroll; the first 58% of a
     slot holds the camera still so the part can actually be looked at, and the
     rest eases to the next. Without the dwell every wheel notch nudged the
     camera and nothing ever settled. */
  var DWELL = 0.58;

  function sample(t) {
    var n = STOPS.length - 1;
    var u = clamp01(t) * n;
    var i = Math.min(Math.floor(u), n - 1);
    var f = u - i;
    var a = STOPS[i], b = STOPS[i + 1];
    var k = f <= DWELL ? 0 : ease((f - DWELL) / (1 - DWELL));

    explode = lerp(a.explode, b.explode, k);
    camYaw = lerp(a.yaw, b.yaw, k);
    camPitch = lerp(a.pitch, b.pitch, k);
    camZoom = lerp(a.zoom, b.zoom, k);
    focus = k < 0.5 ? a.focus : b.focus;
    hold = k < 0.5 ? 1 - k * 2 : (k - 0.5) * 2;
  }

  /* ------------------------------------------------------------ interaction */
  var drag = { on: false, x: 0, y: 0, yaw: 0, pitch: 0, id: null };
  host.addEventListener('pointerdown', function (e) {
    if (drag.id !== null) return;
    drag.on = true; drag.id = e.pointerId; drag.x = e.clientX; drag.y = e.clientY;
    host.classList.add('is-drag');
    if (host.setPointerCapture) { try { host.setPointerCapture(e.pointerId); } catch (x) {} }
  });
  host.addEventListener('pointermove', function (e) {
    if (!drag.on || e.pointerId !== drag.id) return;
    drag.yaw += (e.clientX - drag.x) * 0.008;
    drag.pitch = Math.max(-1.1, Math.min(1.1, drag.pitch + (e.clientY - drag.y) * 0.006));
    drag.x = e.clientX; drag.y = e.clientY;
    kick();
  });
  function endDrag(e) {
    if (e && e.pointerId !== drag.id) return;
    drag.on = false; drag.id = null; host.classList.remove('is-drag');
  }
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (ev) {
    host.addEventListener(ev, endDrag);
  });

  /* ------------------------------------------------------------ render */
  var raf = 0, size = [0, 0];
  var lightVP = null, shadowAt = -1;   // cached shadow pass state

  function resize() {
    var r = canvas.getBoundingClientRect();
    // fill-rate, not geometry, is the cost here: two lights, an env
    // function and PCF per pixel. 1.6x is past the point of visible gain.
    var dpr = Math.min(window.devicePixelRatio || 1, 1.6);
    var w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (w === size[0] && h === size[1]) return;
    canvas.width = w; canvas.height = h; size = [w, h];
  }

  function normalMat(m) {
    var a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6],
      g2 = m[8], h = m[9], i = m[10];
    var A = e * i - f * h, B = f * g2 - d * i, C = d * h - e * g2;
    var det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-20) return new Float32Array([a, b, c, d, e, f, g2, h, i]);
    var id = 1 / det;
    return new Float32Array([A * id, B * id, C * id,
      (c * h - b * i) * id, (a * i - c * g2) * id, (b * g2 - a * h) * id,
      (b * f - c * e) * id, (c * d - a * f) * id, (a * e - b * d) * id]);
  }

  function modelOf(i) {
    var m = parts[i].model.slice();
    m[14] += offsetFor(i) * explode;
    return m;
  }

  function frame() {
    raf = 0;
    resize();
    if (!ready) return;

    sample(progress);

    var spread = spacing * (parts.length - 1) * explode;
    var reach = bounds.r * 2 + spread;
    var wide = Math.max(bounds.r * 3.0, reach * 1.12) * camZoom;

    var tgt = bounds.c.slice(), dist = wide;
    if (focus >= 0) {
      var p = parts[focus];
      var c = p.box.c.slice();
      c[2] += offsetFor(focus) * explode;
      var pull = smooth(clamp01(hold * 1.5));
      tgt = [lerp(bounds.c[0], c[0], pull), lerp(bounds.c[1], c[1], pull),
        lerp(bounds.c[2], c[2], pull)];
      dist = lerp(wide, Math.max(p.box.r * 3.4, bounds.r * 0.42) * camZoom, pull);
      dist = Math.max(dist, bounds.r * 0.26);
    }

    var yaw = camYaw + drag.yaw;
    var pitch = Math.max(-1.25, Math.min(1.25, camPitch + drag.pitch));
    var eye = [tgt[0] + dist * Math.cos(pitch) * Math.sin(yaw),
      tgt[1] + dist * Math.sin(pitch),
      tgt[2] + dist * Math.cos(pitch) * Math.cos(yaw)];

    /* ---- shadow pass ----
       The depth map depends only on where the parts are, never on where the
       camera is, so it is regenerated when the explode amount actually moves
       and reused for every frame in between. Dragging the model re-renders the
       main pass alone; without this the 2048 map was being rebuilt for every
       mouse move, which was most of the frame cost. */
    var needShadow = shadowOK &&
      (lightVP === null || Math.abs(explode - shadowAt) > 0.004);
    if (needShadow) {
      shadowAt = explode;
      var ext = reach * 0.85;
      var le = [bounds.c[0] + LIGHT[0] * reach * 2,
        bounds.c[1] + LIGHT[1] * reach * 2,
        bounds.c[2] + LIGHT[2] * reach * 2];
      var up = Math.abs(LIGHT[1]) > 0.95 ? [0, 0, 1] : [0, 1, 0];
      lightVP = mul(ortho(ext, ext, 0.01, reach * 4.5), lookAt(le, bounds.c, up));

      gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFB);
      gl.viewport(0, 0, SHADOW, SHADOW);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(dprog);
      gl.uniformMatrix4fv(D.uLightVP, false, lightVP);
      // front-face culling in the depth pass pushes peter-panning to the far
      // side of each part, where it does not show
      gl.enable(gl.CULL_FACE); gl.cullFace(gl.FRONT);
      for (var i = 0; i < parts.length; i++) {
        gl.uniformMatrix4fv(D.uModel, false, modelOf(i));
        parts[i].prims.forEach(function (q) {
          if (q.alpha < 0.95) return;
          gl.bindVertexArray(q.vao);
          if (q.indexed) gl.drawElements(gl.TRIANGLES, q.count, q.itype, 0);
          else gl.drawArrays(gl.TRIANGLES, 0, q.count);
        });
      }
      gl.disable(gl.CULL_FACE);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // ---- main pass ----
    gl.viewport(0, 0, size[0], size[1]);
    gl.useProgram(prog);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    gl.uniformMatrix4fv(U.uProj, false,
      perspective(0.58, size[0] / Math.max(size[1], 1), bounds.r * 0.04, bounds.r * 60));
    gl.uniformMatrix4fv(U.uView, false, lookAt(eye, tgt, [0, 1, 0]));
    gl.uniform3fv(U.uEye, eye);
    gl.uniform3fv(U.uLightDir, LIGHT);
    gl.uniform1f(U.uShadowOn, shadowOK ? 1 : 0);
    gl.uniform1f(U.uTexel, 1 / SHADOW);
    if (shadowOK) {
      gl.uniformMatrix4fv(U.uLightVP, false, lightVP);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, shadowTex);
      gl.uniform1i(U.uShadow, 1);
    }

    var order = parts.map(function (p, i) { return i; }).sort(function (a, b) {
      if (focus >= 0) { if (a === focus) return -1; if (b === focus) return 1; }
      var aa = Math.min.apply(null, parts[a].prims.map(function (q) { return q.alpha; }));
      var bb = Math.min.apply(null, parts[b].prims.map(function (q) { return q.alpha; }));
      return (aa < 1) - (bb < 1);
    });
    var ghost = focus >= 0 ? lerp(1, 0.12, smooth(clamp01(hold * 1.5))) : 1;

    order.forEach(function (i) {
      var isGhost = focus >= 0 && i !== focus;
      gl.depthMask(!isGhost);
      var m = modelOf(i);
      gl.uniformMatrix4fv(U.uModel, false, m);
      gl.uniformMatrix3fv(U.uNrm, false, normalMat(m));
      gl.uniform1f(U.uFade, isGhost ? lerp(1, 0.32, smooth(clamp01(hold * 1.5))) : 1);
      parts[i].prims.forEach(function (q) {
        gl.uniform3fv(U.uColor, q.color);
        gl.uniform1f(U.uMetal, q.metal);
        gl.uniform1f(U.uRough, q.rough);
        gl.uniform1f(U.uAlpha, isGhost ? q.alpha * ghost : q.alpha);
        var t = q.tex >= 0 ? texes[q.tex] : null;
        gl.uniform1f(U.uHasTex, t ? 1 : 0);
        if (t) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(U.uTex, 0); }
        gl.bindVertexArray(q.vao);
        if (q.indexed) gl.drawElements(gl.TRIANGLES, q.count, q.itype, 0);
        else gl.drawArrays(gl.TRIANGLES, 0, q.count);
      });
    });
    gl.bindVertexArray(null);
    gl.depthMask(true);

    if (label) {
      var on = focus >= 0 && hold > 0.2;
      label.classList.toggle('is-on', on);
      if (on && nameEl) {
        nameEl.textContent = parts[focus].name;
        if (noteEl) noteEl.textContent = (focus + 1) + ' / ' + parts.length;
      }
    }
    if (bar) bar.style.transform = 'scaleX(' + progress.toFixed(4) + ')';
  }

  function kick() { if (!raf) raf = requestAnimationFrame(frame); }

  function onScroll() {
    var r = track.getBoundingClientRect();
    var travel = r.height - window.innerHeight;
    progress = travel > 0 ? clamp01(-r.top / travel) : 0;
    kick();
  }

  /* ------------------------------------------------------------ load */
  var io = new IntersectionObserver(function (entries) {
    if (!entries[0].isIntersecting || ready || failed) return;
    io.disconnect();
    host.classList.add('is-loading');
    fetch(SRC).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (buf) {
      var g = parseGLB(buf);
      parts = build(g);
      if (!parts.length) throw new Error('no meshes in model');
      return loadTextures(g);
    }).then(function () {
      var lo = [1e30, 1e30, 1e30], hi = [-1e30, -1e30, -1e30];
      parts.forEach(function (p) {
        for (var i = 0; i < 3; i++) {
          lo[i] = Math.min(lo[i], p.box.lo[i]); hi[i] = Math.max(hi[i], p.box.hi[i]);
        }
      });
      bounds = { c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
        r: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 || 1 };

      buildSpread();
      buildTimeline();
      ready = true;
      host.classList.remove('is-loading');
      host.classList.add('is-ready');
      host.dataset.parts = parts.length;
      host.dataset.stops = STOPS.length;
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', function () { size = [0, 0]; kick(); }, { passive: true });
      onScroll();
      if (reduce) { progress = 0; kick(); }
    }).catch(function (e) {
      failed = true;
      host.classList.add('xv-fallback');
      if (window.console) console.warn('[exploded view]', e.message);
    });
  }, { rootMargin: '700px 0px' });

  io.observe(host);
})();
