/* Jack Verbel — interactive exploded view.

   A purpose-built WebGL2 renderer for the watch assembly. Scroll drives a
   camera path that pulls it apart and pushes in on each part; drag orbits it.

   Why not three.js: this build environment has no network access to any CDN or
   package registry, so three.js could not be fetched, vendored or tested, and
   shipping a library that was never once executed is not an option. Everything
   here runs against raw WebGL2 and is exercised locally before it ships.

   The pipeline, and why each stage is there:

     BACKGROUND  a studio gradient with a glow behind the subject. Product
                 renders live or die on what is behind them; on flat white the
                 model read as a CAD screenshot no matter how well it was lit.
     SHADOW      2048² depth map from the key light, 3×3 PCF. Cached, because
                 it depends on the explode amount and never on the camera.
     SCENE       drawn into a multisampled float target so highlights can go
                 above 1.0 and survive to the bloom stage.
     BLOOM       bright-pass then separable blur at quarter res. This is what
                 makes a specular read as a light source rather than a white
                 pixel.
     COMPOSITE   ACES tonemap, vignette, and a little grain to kill banding in
                 the background gradient.

   Explode grouping matters as much as any of it: the strap, keeper, buckle and
   spring bars move as ONE body, because giving each its own offset tore the
   strap into fragments that floated apart.

   Scroll contract: a tall container with a sticky canvas. Page scroll is read,
   never intercepted. Progress is damped toward the scroll position rather than
   snapped to it, which is what makes the motion feel continuous.

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

  var gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
  if (!gl) { host.classList.add('xv-fallback'); return; }

  var reduce = window.matchMedia &&
               window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var conn = navigator.connection || navigator.webkitConnection;
  if (conn && (conn.saveData || /^(slow-)?2g$/.test(conn.effectiveType || ''))) {
    host.classList.add('xv-fallback');
    return;
  }

  var HDR = !!gl.getExtension('EXT_color_buffer_float');
  var CFMT = HDR ? gl.RGBA16F : gl.RGBA8;
  var CTYPE = HDR ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;
  var MAXSAMP = Math.min(gl.getParameter(gl.MAX_SAMPLES) || 1, 4);

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
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0,
      x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
  }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
      a[0] * b[1] - a[1] * b[0]];
  }
  function norm(v) { var l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* ------------------------------------------------------------ shaders */
  var FSQ = `#version 300 es
  out vec2 vUV;
  void main(){
    vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2);
    vUV = p; gl_Position = vec4(p*2.0-1.0, 0.0, 1.0);
  }`;

  var BG_FS = `#version 300 es
  precision highp float; in vec2 vUV; out vec4 frag;
  uniform vec2 uAspect;
  void main(){
    /* A seamless studio backdrop: dark at the edges, a soft pool of light
       behind where the subject sits. This is the single biggest reason the
       model stopped reading as a CAD screenshot. */
    vec2 p = (vUV - 0.5) * uAspect;
    float r = length(p * vec2(1.0, 1.25));
    vec3 deep = vec3(0.022, 0.023, 0.028);
    vec3 mid  = vec3(0.075, 0.078, 0.092);
    vec3 glow = vec3(0.30, 0.31, 0.35);
    vec3 c = mix(mid, deep, smoothstep(0.15, 1.05, r));
    c += glow * (1.0 - smoothstep(0.0, 0.62, r)) * 0.55;
    // a cool sliver along the bottom, like light spilling onto a sweep
    c += vec3(0.05,0.06,0.09) * smoothstep(0.55, 1.0, vUV.y) * 0.0;
    c += vec3(0.04,0.045,0.06) * smoothstep(0.35, 0.0, vUV.y);
    frag = vec4(c, 1.0);
  }`;

  var VS = `#version 300 es
  in vec3 aPos; in vec3 aNrm; in vec2 aUV;
  uniform mat4 uProj, uView, uModel, uLightVP; uniform mat3 uNrm;
  out vec3 vN; out vec3 vP; out vec2 vT; out vec4 vLP;
  void main(){
    vec4 wp = uModel * vec4(aPos,1.0);
    vP = wp.xyz; vN = normalize(uNrm * aNrm); vT = aUV;
    vLP = uLightVP * wp;
    gl_Position = uProj * uView * wp;
  }`;

  var FS = `#version 300 es
  precision highp float;
  precision highp sampler2DShadow;
  in vec3 vN; in vec3 vP; in vec2 vT; in vec4 vLP;
  uniform vec3 uEye, uColor, uLightDir;
  uniform float uMetal, uRough, uAlpha, uFade, uHasTex, uShadowOn, uTexel;
  uniform sampler2D uTex;
  uniform sampler2DShadow uShadow;
  out vec4 frag;

  vec3 env(vec3 d, float rough){
    /* The studio as a function. A polished part is a mirror, and a mirror of
       flat grey is flat grey -- so this has real features: a hard horizon, an
       overhead softbox and two rim strips. The horizon edge is what reads as
       metal. */
    float y = d.y;
    vec3 ground = mix(vec3(0.010,0.010,0.013), vec3(0.16,0.16,0.18),
                      smoothstep(-1.0, -0.04, y));
    vec3 sky = mix(vec3(0.30,0.31,0.35), vec3(0.66,0.68,0.74),
                   smoothstep(0.0, 0.85, y));
    float box = smoothstep(0.55, 0.97, y) * (1.0 - 0.42 * abs(d.z));
    sky += vec3(5.4,5.4,5.6) * box;
    sky += vec3(2.6,2.64,2.8) *
           smoothstep(0.88, 1.0, dot(normalize(vec3(-0.78,0.34,-0.52)), d));
    sky += vec3(1.5,1.5,1.6) *
           smoothstep(0.91, 1.0, dot(normalize(vec3(0.72,0.18,0.66)), d));
    vec3 col = mix(ground, sky, smoothstep(-0.03, 0.02, y));
    col += vec3(0.26,0.27,0.30) * smoothstep(0.25, 1.0, d.z*0.5+0.5)
           * (0.30 + 1.0 * smoothstep(-0.65, 0.75, y));
    return mix(col, vec3(0.30,0.31,0.34), rough*rough*0.8);
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
  vec3 fres(vec3 F0, float c){ return F0 + (1.0-F0)*pow(1.0-c,5.0); }

  float shadow(){
    if(uShadowOn < 0.5) return 1.0;
    vec3 p = vLP.xyz / vLP.w * 0.5 + 0.5;
    if(p.z > 1.0 || p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) return 1.0;
    float s = 0.0;
    for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++)
      s += texture(uShadow, vec3(p.xy + vec2(float(x),float(y))*uTexel, p.z-0.0022));
    return s/9.0;
  }

  void main(){
    vec3 N = normalize(vN), V = normalize(uEye - vP);
    if(!gl_FrontFacing) N = -N;
    vec3 base = uColor;
    if(uHasTex > 0.5) base *= texture(uTex, vT).rgb;

    float rough = clamp(uRough, 0.03, 1.0);
    vec3 albedo = base * (1.0 - uMetal);
    vec3 F0 = mix(vec3(0.04), base, uMetal);
    vec3 R = reflect(-V, N);
    float nv = max(dot(N,V), 1e-4);

    vec3 L = normalize(uLightDir);
    float sh = shadow();
    vec3 c = (albedo/3.14159 + vec3(ggx(N,V,L,rough))*F0) * max(dot(N,L),0.0) * 4.2 * sh;

    vec3 L2 = normalize(vec3(-0.72, 0.26, 0.55));
    vec3 L3 = normalize(vec3(0.18, -0.58, -0.78));
    c += (albedo/3.14159 + vec3(ggx(N,V,L2,rough))*F0) * max(dot(N,L2),0.0) * 1.15;
    c += (albedo/3.14159 + vec3(ggx(N,V,L3,rough))*F0) * max(dot(N,L3),0.0) * 0.42;

    float ao = mix(0.42, 1.0, sh);
    c += albedo * env(N,1.0) * 0.42 * ao;
    c += env(R,rough) * fres(F0,nv) * mix(1.0,0.22,rough) * ao;

    // output stays linear HDR: tonemapping happens in the composite pass so
    // the bloom stage has real above-1.0 values to work with
    c = mix(vec3(0.055,0.057,0.066), c, uFade);
    frag = vec4(c, uAlpha);
  }`;

  var DVS = `#version 300 es
  in vec3 aPos; uniform mat4 uLightVP, uModel;
  void main(){ gl_Position = uLightVP * uModel * vec4(aPos,1.0); }`;
  var DFS = `#version 300 es
  precision highp float; void main(){}`;

  var BRIGHT_FS = `#version 300 es
  precision highp float; in vec2 vUV; out vec4 frag;
  uniform sampler2D uSrc;
  void main(){
    vec3 c = texture(uSrc, vUV).rgb;
    float l = dot(c, vec3(0.2126,0.7152,0.0722));
    frag = vec4(c * smoothstep(0.75, 2.2, l), 1.0);
  }`;

  var BLUR_FS = `#version 300 es
  precision highp float; in vec2 vUV; out vec4 frag;
  uniform sampler2D uSrc; uniform vec2 uDir;
  void main(){
    // 9-tap gaussian, linear-sampled
    vec3 c = texture(uSrc, vUV).rgb * 0.2270270270;
    c += texture(uSrc, vUV + uDir*1.3846153846).rgb * 0.3162162162;
    c += texture(uSrc, vUV - uDir*1.3846153846).rgb * 0.3162162162;
    c += texture(uSrc, vUV + uDir*3.2307692308).rgb * 0.0702702703;
    c += texture(uSrc, vUV - uDir*3.2307692308).rgb * 0.0702702703;
    frag = vec4(c, 1.0);
  }`;

  var COMP_FS = `#version 300 es
  precision highp float; in vec2 vUV; out vec4 frag;
  uniform sampler2D uScene, uBloom; uniform float uTime;
  vec3 aces(vec3 x){
    return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0);
  }
  void main(){
    vec3 c = texture(uScene, vUV).rgb + texture(uBloom, vUV).rgb * 0.55;
    c = aces(c * 0.58);
    // vignette
    vec2 p = (vUV - 0.5) * 2.0;
    c *= 1.0 - 0.30 * pow(clamp(length(p*vec2(0.92,1.0)) * 0.72, 0.0, 1.0), 2.2);
    c = pow(c, vec3(1.0/2.2));
    // a touch of grain: the background is a wide smooth gradient and 8-bit
    // output bands visibly without it
    float n = fract(sin(dot(vUV*vec2(1271.3,913.7) + uTime, vec2(12.9898,78.233)))*43758.5453);
    c += (n - 0.5) * 0.012;
    frag = vec4(c, 1.0);
  }`;

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
  function uni(p, names) {
    var o = {};
    names.forEach(function (n) { o[n] = gl.getUniformLocation(p, n); });
    return o;
  }

  var prog = link(VS, FS), dprog = link(DVS, DFS);
  var bgProg = link(FSQ, BG_FS), brProg = link(FSQ, BRIGHT_FS);
  var blProg = link(FSQ, BLUR_FS), cmProg = link(FSQ, COMP_FS);

  var U = uni(prog, ['uProj', 'uView', 'uModel', 'uNrm', 'uEye', 'uColor',
    'uMetal', 'uRough', 'uAlpha', 'uFade', 'uHasTex', 'uTex', 'uShadow',
    'uLightVP', 'uLightDir', 'uShadowOn', 'uTexel']);
  var D = uni(dprog, ['uLightVP', 'uModel']);
  var BG = uni(bgProg, ['uAspect']);
  var BR = uni(brProg, ['uSrc']);
  var BL = uni(blProg, ['uSrc', 'uDir']);
  var CM = uni(cmProg, ['uScene', 'uBloom', 'uTime']);

  var emptyVAO = gl.createVertexArray();

  /* --------------------------------------------------- render targets */
  var SHADOW = window.innerWidth < 700 ? 1024 : 2048;
  var shadowTex, shadowFB, shadowOK = false;
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
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, shadowTex, 0);
    shadowOK = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  })();

  var msFB = null, msC = null, msD = null;
  var sceneFB = null, sceneTex = null;
  var bloomFB = [null, null], bloomTex = [null, null];
  var fbW = 0, fbH = 0, bW = 0, bH = 0;

  function tex2d(w, h, fmt, type) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt, w, h, 0, gl.RGBA, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  function makeTargets(w, h) {
    if (w === fbW && h === fbH) return;
    fbW = w; fbH = h;
    bW = Math.max(2, w >> 2); bH = Math.max(2, h >> 2);

    [msFB, sceneFB, bloomFB[0], bloomFB[1]].forEach(function (f) {
      if (f) gl.deleteFramebuffer(f);
    });
    [sceneTex, bloomTex[0], bloomTex[1]].forEach(function (t) {
      if (t) gl.deleteTexture(t);
    });
    if (msC) gl.deleteRenderbuffer(msC);
    if (msD) gl.deleteRenderbuffer(msD);

    // multisampled offscreen: rendering to a texture loses the context's own
    // MSAA, and on a model made of thin rings the aliasing is unmissable
    msFB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, msFB);
    msC = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, msC);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, MAXSAMP, CFMT, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, msC);
    msD = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, msD);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, MAXSAMP, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, msD);

    sceneTex = tex2d(w, h, CFMT, CTYPE);
    sceneFB = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, sceneFB);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, sceneTex, 0);

    for (var i = 0; i < 2; i++) {
      bloomTex[i] = tex2d(bW, bH, CFMT, CTYPE);
      bloomFB[i] = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, bloomFB[i]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, bloomTex[i], 0);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  var LIGHT = norm([0.38, 0.80, 0.56]);

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
    var a = g.json.accessors[i], v = g.json.bufferViews[a.bufferView];
    var TA = COMP[a.componentType], n = NUM[a.type];
    var base = (v.byteOffset || 0) + (a.byteOffset || 0), stride = v.byteStride;
    if (!stride || stride === n * TA.BYTES_PER_ELEMENT)
      return new TA(g.bin, base, a.count * n);
    var out = new TA(a.count * n);
    for (var k = 0; k < a.count; k++) out.set(new TA(g.bin, base + k * stride, n), k * n);
    return out;
  }
  function nodeMatrix(nd) {
    if (nd.matrix) return new Float32Array(nd.matrix);
    var t = nd.translation || [0, 0, 0], r = nd.rotation || [0, 0, 0, 1], s = nd.scale || [1, 1, 1];
    var x = r[0], y = r[1], z = r[2], w = r[3];
    var x2 = x + x, y2 = y + y, z2 = z + z;
    var xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
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
      var a = m[0] * x + m[4] * y + m[8] * z + m[12];
      var b = m[1] * x + m[5] * y + m[9] * z + m[13];
      var c = m[2] * x + m[6] * y + m[10] * z + m[14];
      if (a < lo[0]) lo[0] = a; if (a > hi[0]) hi[0] = a;
      if (b < lo[1]) lo[1] = b; if (b > hi[1]) hi[1] = b;
      if (c < lo[2]) lo[2] = c; if (c > hi[2]) hi[2] = c;
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
      return { vao: vao, count: count, indexed: !!idx, itype: itype,
        color: [col[0], col[1], col[2]],
        metal: pbr.metallicFactor !== undefined ? pbr.metallicFactor : 1,
        rough: pbr.roughnessFactor !== undefined ? pbr.roughnessFactor : 1,
        alpha: col[3] !== undefined ? col[3] : 1,
        tex: pbr.baseColorTexture ? pbr.baseColorTexture.index : -1, pos: pos };
    }
    function walk(ni, parent) {
      var nd = g.json.nodes[ni], m = mul(parent, nodeMatrix(nd));
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
          seen.push({ name: nd.name || mesh.name || ('part ' + seen.length),
            model: m, prims: prims,
            box: { lo: lo, hi: hi,
              c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
              r: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 } });
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

  /* ------------------------------------------------- explode grouping */
  /* The strap is six separate nodes -- band, upper band, keeper, buckle, the
     red accent and the spring bars. Giving each its own offset tore it into
     pieces that floated off on their own, which is exactly the "randomly
     floating" bits. They move as one body instead. */
  var STRAP = ['strap', 'strap upper', 'strap accent', 'strap keeper',
    'buckle', 'spring bars'];
  var groupId = [], groupOffset = [], nGroups = 0;

  function buildSpread() {
    var isStrap = parts.map(function (p) {
      return STRAP.indexOf(p.name.toLowerCase()) >= 0;
    });
    var head = [];
    parts.forEach(function (p, i) { if (!isStrap[i]) head.push(i); });
    head.sort(function (a, b) { return parts[a].box.c[2] - parts[b].box.c[2]; });

    groupId = new Array(parts.length);
    head.forEach(function (pi, k) { groupId[pi] = k; });
    var strapGroup = head.length;
    parts.forEach(function (p, i) { if (isStrap[i]) groupId[i] = strapGroup; });
    nGroups = head.length + 1;

    var radii = head.map(function (i) { return parts[i].box.r; })
      .sort(function (a, b) { return a - b; });
    var spacing = (radii[Math.floor(radii.length / 2)] || bounds.r * 0.3) * 0.52;

    groupOffset = [];
    for (var gI = 0; gI < nGroups; gI++)
      groupOffset[gI] = (gI - (nGroups - 1) / 2) * spacing;
    // the strap is the biggest body: push it clear of the head stack
    groupOffset[strapGroup] = -(nGroups / 2 + 0.8) * spacing;
    spread = spacing * nGroups;
  }
  var spread = 1;
  function offsetFor(i) { return groupOffset[groupId[i]]; }

  /* ------------------------------------------------------------ timeline */
  var progress = 0, target = 0, explode = 0, focus = -1, hold = 0;
  var camYaw = 0, camPitch = 0, camZoom = 1, STOPS = [];

  /* yaw, pitch, framing margin. The margins vary on purpose: some beats sit
     right on top of a part, others hang back and let it sit in the frame. */
  var ANGLES = [
    [-0.55, 0.26, 1.30], [0.78, 0.10, 1.05], [-1.30, 0.55, 1.45],
    [1.10, -0.32, 1.12], [-0.28, 0.74, 1.25], [1.55, 0.26, 1.08],
    [-1.75, 0.06, 1.38], [0.30, -0.55, 1.15], [-0.98, 0.48, 1.28],
    [1.28, 0.64, 1.20], [-0.16, 0.16, 1.02], [0.86, -0.16, 1.34]
  ];

  function buildTimeline() {
    var wanted = (host.dataset.tour || '').split(',')
      .map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
    var order = [];
    wanted.forEach(function (w) {
      parts.forEach(function (p, i) {
        if (p.name.toLowerCase() === w && order.indexOf(i) < 0) order.push(i);
      });
    });
    if (!order.length) {
      order = parts.map(function (p, i) { return i; })
        .filter(function (i) { return parts[i].box.r > bounds.r * 0.09; })
        .sort(function (a, b) { return parts[b].box.c[2] - parts[a].box.c[2]; });
    }
    STOPS = [
      { explode: 0, focus: -1, yaw: -0.55, pitch: 0.20, zoom: 1.18 },
      { explode: 0, focus: -1, yaw: 0.85, pitch: -0.05, zoom: 0.95 },
      { explode: 0, focus: -1, yaw: -0.25, pitch: 0.78, zoom: 1.08 },
      { explode: 1, focus: -1, yaw: -1.20, pitch: 0.34, zoom: 1.05 }
    ];
    order.forEach(function (pi, k) {
      var a = ANGLES[k % ANGLES.length];
      STOPS.push({ explode: 1, focus: pi, yaw: a[0], pitch: a[1], zoom: a[2] });
    });
    STOPS.push({ explode: 1, focus: -1, yaw: 1.05, pitch: 0.30, zoom: 1.02 });
    STOPS.push({ explode: 0, focus: -1, yaw: -0.42, pitch: 0.18, zoom: 0.98 });
  }

  var DWELL = 0.46;
  function sample(t) {
    var n = STOPS.length - 1;
    var u = clamp01(t) * n, i = Math.min(Math.floor(u), n - 1), f = u - i;
    var a = STOPS[i], b = STOPS[i + 1];
    var k = f <= DWELL ? 0 : ease((f - DWELL) / (1 - DWELL));
    explode = lerp(a.explode, b.explode, k);
    camYaw = lerp(a.yaw, b.yaw, k);
    camPitch = lerp(a.pitch, b.pitch, k);
    camZoom = lerp(a.zoom, b.zoom, k);
    focus = k < 0.5 ? a.focus : b.focus;
    hold = k < 0.5 ? 1 - k * 2 : (k - 0.5) * 2;
  }

  /* ------------------------------------------------------------ drag */
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
    drag.pitch = Math.max(-1.05, Math.min(1.05, drag.pitch + (e.clientY - drag.y) * 0.006));
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
  var FOV = 0.62;
  var raf = 0, size = [0, 0], lightVP = null, shadowAt = -1, t0 = performance.now();

  function resize() {
    var r = canvas.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 1.75);
    var w = Math.max(2, Math.round(r.width * dpr)), h = Math.max(2, Math.round(r.height * dpr));
    if (w === size[0] && h === size[1]) return;
    canvas.width = w; canvas.height = h; size = [w, h];
    makeTargets(w, h);
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
  function fsq() { gl.bindVertexArray(emptyVAO); gl.drawArrays(gl.TRIANGLES, 0, 3); }

  function drawParts(progLocs, depthOnly) {
    var order = parts.map(function (p, i) { return i; }).sort(function (a, b) {
      if (!depthOnly && focus >= 0) { if (a === focus) return -1; if (b === focus) return 1; }
      var aa = Math.min.apply(null, parts[a].prims.map(function (q) { return q.alpha; }));
      var bb = Math.min.apply(null, parts[b].prims.map(function (q) { return q.alpha; }));
      return (aa < 1) - (bb < 1);
    });
    var ghost = focus >= 0 ? lerp(1, 0.10, smooth(clamp01(hold * 1.5))) : 1;
    order.forEach(function (i) {
      var isGhost = !depthOnly && focus >= 0 && i !== focus;
      var m = modelOf(i);
      if (depthOnly) {
        gl.uniformMatrix4fv(D.uModel, false, m);
      } else {
        gl.depthMask(!isGhost);
        gl.uniformMatrix4fv(U.uModel, false, m);
        gl.uniformMatrix3fv(U.uNrm, false, normalMat(m));
        gl.uniform1f(U.uFade, isGhost ? lerp(1, 0.30, smooth(clamp01(hold * 1.5))) : 1);
      }
      parts[i].prims.forEach(function (q) {
        if (depthOnly && q.alpha < 0.95) return;
        if (!depthOnly) {
          gl.uniform3fv(U.uColor, q.color);
          gl.uniform1f(U.uMetal, q.metal);
          gl.uniform1f(U.uRough, q.rough);
          gl.uniform1f(U.uAlpha, isGhost ? q.alpha * ghost : q.alpha);
          var t = q.tex >= 0 ? texes[q.tex] : null;
          gl.uniform1f(U.uHasTex, t ? 1 : 0);
          if (t) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(U.uTex, 0); }
        }
        gl.bindVertexArray(q.vao);
        if (q.indexed) gl.drawElements(gl.TRIANGLES, q.count, q.itype, 0);
        else gl.drawArrays(gl.TRIANGLES, 0, q.count);
      });
    });
    gl.bindVertexArray(null);
    if (!depthOnly) gl.depthMask(true);
  }

  function frame() {
    raf = 0;
    resize();
    if (!ready) return;

    /* Damped, not snapped. The camera chases the scroll position instead of
       being pinned to it, which is the whole difference between "jumps on
       every wheel notch" and a continuous move. */
    var d = target - progress;
    if (Math.abs(d) > 0.00008) {
      progress += d * (drag.on ? 1 : 0.085);
      kick();
    } else progress = target;

    sample(progress);

    /* Framing, done properly. The previous version multiplied the bounding
       radius by hand-tuned constants and cropped the watch off both edges.
       This solves for the distance at which a sphere of a given radius fills
       the frame, then backs off by a margin -- so camZoom is now a readable
       "how much air around the subject" number rather than a magic constant.
       Fitting is done on the narrower of the two FOVs, or a wide viewport
       crops a tall subject like the strap. */
    var reach = bounds.r + spread * explode * 0.5;
    var aspect = size[0] / size[1];
    var vfov = FOV, hfov = 2 * Math.atan(Math.tan(FOV / 2) * aspect);
    var tightest = Math.tan(Math.min(vfov, hfov) / 2);

    function fit(radius, margin) { return radius / tightest * margin; }

    var wide = fit(reach, camZoom);
    var tgt = bounds.c.slice(), dist = wide;
    if (focus >= 0) {
      var p = parts[focus];
      var c = p.box.c.slice();
      c[2] += offsetFor(focus) * explode;
      var pull = smooth(clamp01(hold * 1.5));
      tgt = [lerp(bounds.c[0], c[0], pull), lerp(bounds.c[1], c[1], pull),
        lerp(bounds.c[2], c[2], pull)];
      // floor the radius: a spring bar is a millimetre across and framing it
      // exactly would put the camera inside the rest of the assembly
      var pr = Math.max(p.box.r, bounds.r * 0.16);
      dist = lerp(wide, fit(pr, camZoom), pull);
      dist = Math.max(dist, bounds.r * 0.20);
    }
    var yaw = camYaw + drag.yaw;
    var pitch = Math.max(-1.2, Math.min(1.2, camPitch + drag.pitch));
    var eye = [tgt[0] + dist * Math.cos(pitch) * Math.sin(yaw),
      tgt[1] + dist * Math.sin(pitch), tgt[2] + dist * Math.cos(pitch) * Math.cos(yaw)];

    // ---- shadow (cached against explode) ----
    if (shadowOK && (lightVP === null || Math.abs(explode - shadowAt) > 0.004)) {
      shadowAt = explode;
      var ext = reach * 0.9;
      var le = [bounds.c[0] + LIGHT[0] * reach * 2, bounds.c[1] + LIGHT[1] * reach * 2,
        bounds.c[2] + LIGHT[2] * reach * 2];
      lightVP = mul(ortho(ext, ext, 0.01, reach * 4.5), lookAt(le, bounds.c, [0, 1, 0]));
      gl.bindFramebuffer(gl.FRAMEBUFFER, shadowFB);
      gl.viewport(0, 0, SHADOW, SHADOW);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
      gl.useProgram(dprog);
      gl.uniformMatrix4fv(D.uLightVP, false, lightVP);
      gl.enable(gl.CULL_FACE); gl.cullFace(gl.FRONT);
      drawParts(D, true);
      gl.disable(gl.CULL_FACE);
    }

    // ---- scene into the multisampled float target ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, msFB);
    gl.viewport(0, 0, size[0], size[1]);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    gl.useProgram(bgProg);
    gl.uniform2f(BG.uAspect, Math.max(1, size[0] / size[1]), Math.max(1, size[1] / size[0]));
    fsq();

    gl.enable(gl.DEPTH_TEST); gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(prog);
    gl.uniformMatrix4fv(U.uProj, false,
      perspective(FOV, size[0] / size[1], bounds.r * 0.02, bounds.r * 120));
    gl.uniformMatrix4fv(U.uView, false, lookAt(eye, tgt, [0, 1, 0]));
    gl.uniform3fv(U.uEye, eye);
    gl.uniform3fv(U.uLightDir, LIGHT);
    gl.uniform1f(U.uShadowOn, shadowOK ? 1 : 0);
    gl.uniform1f(U.uTexel, 1 / SHADOW);
    if (shadowOK) {
      gl.uniformMatrix4fv(U.uLightVP, false, lightVP);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, shadowTex);
      gl.uniform1i(U.uShadow, 1);
    }
    drawParts(U, false);

    // resolve MSAA into a sampleable texture
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msFB);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, sceneFB);
    gl.blitFramebuffer(0, 0, size[0], size[1], 0, 0, size[0], size[1],
      gl.COLOR_BUFFER_BIT, gl.LINEAR);

    // ---- bloom ----
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    gl.viewport(0, 0, bW, bH);
    gl.bindFramebuffer(gl.FRAMEBUFFER, bloomFB[0]);
    gl.useProgram(brProg);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.uniform1i(BR.uSrc, 0); fsq();

    gl.useProgram(blProg);
    for (var pass = 0; pass < 2; pass++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, bloomFB[1]);
      gl.bindTexture(gl.TEXTURE_2D, bloomTex[0]);
      gl.uniform1i(BL.uSrc, 0); gl.uniform2f(BL.uDir, 1 / bW, 0); fsq();
      gl.bindFramebuffer(gl.FRAMEBUFFER, bloomFB[0]);
      gl.bindTexture(gl.TEXTURE_2D, bloomTex[1]);
      gl.uniform1i(BL.uSrc, 0); gl.uniform2f(BL.uDir, 0, 1 / bH); fsq();
    }

    // ---- composite ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, size[0], size[1]);
    gl.useProgram(cmProg);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, sceneTex);
    gl.uniform1i(CM.uScene, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, bloomTex[0]);
    gl.uniform1i(CM.uBloom, 1);
    gl.uniform1f(CM.uTime, (performance.now() - t0) * 0.001);
    fsq();

    if (label) {
      var on = focus >= 0 && hold > 0.15;
      label.classList.toggle('is-on', on);
      if (on && nameEl) {
        nameEl.textContent = parts[focus].name;
        if (noteEl) noteEl.textContent = 'Part ' + (focus + 1) + ' of ' + parts.length;
      }
    }
    if (bar) bar.style.transform = 'scaleX(' + progress.toFixed(4) + ')';
  }

  function kick() { if (!raf) raf = requestAnimationFrame(frame); }

  function onScroll() {
    var r = track.getBoundingClientRect();
    var travel = r.height - window.innerHeight;
    target = travel > 0 ? clamp01(-r.top / travel) : 0;
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
      progress = target;
      kick();
    }).catch(function (e) {
      failed = true;
      host.classList.add('xv-fallback');
      if (window.console) console.warn('[exploded view]', e.message);
    });
  }, { rootMargin: '800px 0px' });

  io.observe(host);
})();
