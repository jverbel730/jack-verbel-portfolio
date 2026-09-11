/* Jack Verbel — interactive exploded view.

   A purpose-built WebGL2 glTF viewer. Scroll drives a camera path that pulls
   the assembly apart and then pushes in on each part in turn; drag orbits it
   freely at any point.

   Why not three.js: this build environment has no network access to any CDN or
   package registry, so three.js could not be fetched, vendored or tested. Code
   that loads a library at runtime but was never once executed against it is not
   something to put on a portfolio. Everything here is written against the raw
   WebGL2 API and is exercised locally before it ships. It also happens to come
   in at a fraction of three.js's transfer size.

   Scroll contract: the section is a tall container with a sticky canvas. Page
   scroll is read, never intercepted -- no preventDefault on wheel, no
   scroll-jacking. The section always releases at its natural end.

   Requires an UNCOMPRESSED .glb (no Draco, no meshopt): those need decoders
   that cannot be written from scratch at sane cost. */
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

  // the model is 8.5 MB; on a metered or data-saver connection the rendered
  // animation in the markup is the better answer, so bail before fetching
  var conn = navigator.connection || navigator.webkitConnection;
  if (conn && (conn.saveData ||
      /^(slow-)?2g$/.test(conn.effectiveType || ''))) {
    host.classList.add('xv-fallback');
    return;
  }

  /* ------------------------------------------------------------ math */
  function mul(a, b) {                      // 4x4, column-major
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

  function trs(t, r, s) {                   // translation, quaternion, scale
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

  function smooth(t) { return t * t * (3 - 2 * t); }
  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  /* ------------------------------------------------------------ shaders */
  var VS = `#version 300 es
  in vec3 aPos; in vec3 aNrm; in vec2 aUV;
  uniform mat4 uProj, uView, uModel; uniform mat3 uNrm;
  out vec3 vN; out vec3 vP; out vec2 vUV;
  void main(){
    vec4 wp = uModel * vec4(aPos,1.0);
    vP = wp.xyz; vN = normalize(uNrm * aNrm); vUV = aUV;
    gl_Position = uProj * uView * wp;
  }`;

  /* A compact metallic-roughness model: GGX specular plus a two-tone
     hemispheric ambient standing in for an environment probe. There is no HDR
     to sample, so the ambient is analytic -- bright from above, faintly cool
     from below, which is what a white studio sweep actually looks like. */
  var FS = `#version 300 es
  precision highp float;
  in vec3 vN; in vec3 vP;
  uniform vec3 uEye, uColor; uniform float uMetal, uRough, uAlpha, uFade;
  uniform float uHasTex; uniform sampler2D uTex;
  in vec2 vUV;
  out vec4 frag;

  const vec3 L1 = normalize(vec3( 0.45, 0.75,  0.60));
  const vec3 L2 = normalize(vec3(-0.65, 0.30,  0.45));
  const vec3 L3 = normalize(vec3( 0.10,-0.45, -0.80));

  float ggx(vec3 N, vec3 V, vec3 L, float r){
    vec3 H = normalize(V+L);
    float a = max(r*r, 0.002);
    float nh = max(dot(N,H),0.0), nv = max(dot(N,V),1e-4), nl = max(dot(N,L),0.0);
    float d = (nh*nh)*(a*a-1.0)+1.0;
    float D = (a*a)/(3.14159*d*d);
    float k = (r+1.0)*(r+1.0)/8.0;
    float G = (nl/(nl*(1.0-k)+k))*(nv/(nv*(1.0-k)+k));
    return D*G/(4.0*nv*nl+1e-4);
  }

  vec3 lit(vec3 N, vec3 V, vec3 L, vec3 albedo, vec3 F0, float rough, float e){
    float nl = max(dot(N,L),0.0);
    vec3 spec = vec3(ggx(N,V,L,rough)) * F0;
    return (albedo/3.14159 + spec) * nl * e;
  }

  void main(){
    vec3 N = normalize(vN), V = normalize(uEye - vP);
    if(!gl_FrontFacing) N = -N;
    vec3 base = uColor;
    if(uHasTex > 0.5) base *= texture(uTex, vUV).rgb;
    vec3 albedo = base * (1.0 - uMetal);
    vec3 F0 = mix(vec3(0.04), base, uMetal);

    vec3 c  = lit(N,V,L1,albedo,F0,uRough,1.05);
    c += lit(N,V,L2,albedo,F0,uRough,0.42);
    c += lit(N,V,L3,albedo,F0,uRough,0.26);

    /* Ambient is kept deliberately low. There is no ambient occlusion here, so
       a strong uniform fill lands equally in every crevice and flattens the
       whole model into grey -- which is exactly how the first pass looked. A
       dim ambient plus strong keys keeps the blacks black. */
    float up = N.y*0.5+0.5;
    vec3 amb = mix(vec3(0.16,0.17,0.19), vec3(0.62,0.64,0.68), up);
    c += albedo*amb*0.30 + F0*amb*0.45*(1.0-uRough*0.8);

    float fres = pow(1.0-max(dot(N,V),0.0), 5.0);
    c += vec3(fres)*0.05*(1.0-uRough);

    c *= 1.25;                                    // exposure
    c = c/(c+vec3(1.0));                          // reinhard
    c = pow(c, vec3(1.0/2.2));
    c = clamp((c-0.5)*1.12+0.5, 0.0, 1.0);        // a little contrast back
    c = mix(vec3(1.0), c, uFade);                 // fade toward the page white
    frag = vec4(c, uAlpha);
  }`;

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  var prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(prog));
  gl.bindAttribLocation(prog, 0, 'aPos');
  gl.bindAttribLocation(prog, 1, 'aNrm');
  gl.bindAttribLocation(prog, 2, 'aUV');
  gl.linkProgram(prog);
  gl.useProgram(prog);

  var U = {};
  ['uProj', 'uView', 'uModel', 'uNrm', 'uEye', 'uColor', 'uMetal', 'uRough',
    'uAlpha', 'uFade', 'uHasTex', 'uTex'].forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });

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
      throw new Error('needs ' + json.extensionsRequired.join(', ') +
                      ' — re-export uncompressed');
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
    var out = new TA(a.count * n);            // de-interleave
    for (var k = 0; k < a.count; k++) {
      var src = new TA(g.bin, base + k * stride, n);
      out.set(src, k * n);
    }
    return out;
  }

  function nodeMatrix(nd) {
    if (nd.matrix) return new Float32Array(nd.matrix);
    return trs(nd.translation || [0, 0, 0], nd.rotation || [0, 0, 0, 1],
      nd.scale || [1, 1, 1]);
  }

  var parts = [], bounds = null, ready = false, failed = false;

  function build(g) {
    var scene = g.json.scenes[g.json.scene || 0];
    var seen = [];

    function prim(p) {
      if (p.attributes.POSITION === undefined) return null;
      var pos = readAccessor(g, p.attributes.POSITION);
      var nrm = p.attributes.NORMAL !== undefined
        ? readAccessor(g, p.attributes.NORMAL) : null;
      var uv = p.attributes.TEXCOORD_0 !== undefined
        ? readAccessor(g, p.attributes.TEXCOORD_0) : null;
      var idx = p.indices !== undefined ? readAccessor(g, p.indices) : null;
      if (!nrm) nrm = faceNormals(pos, idx);

      var mat = p.material !== undefined ? g.json.materials[p.material] : {};
      var pbr = mat.pbrMetallicRoughness || {};
      var col = pbr.baseColorFactor || [0.8, 0.8, 0.8, 1];

      var vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      bindAttr(0, pos, 3);
      bindAttr(1, nrm, 3);
      if (uv) bindAttr(2, uv, 2);
      else { gl.disableVertexAttribArray(2); gl.vertexAttrib2f(2, 0, 0); }

      var count, itype;
      if (idx) {
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
        var u32 = idx instanceof Uint32Array;
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
        count = idx.length;
        itype = u32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      } else {
        count = pos.length / 3;
      }
      gl.bindVertexArray(null);

      var texIdx = pbr.baseColorTexture ? pbr.baseColorTexture.index : -1;
      return {
        vao: vao, count: count, indexed: !!idx, itype: itype,
        color: [col[0], col[1], col[2]],
        metal: pbr.metallicFactor !== undefined ? pbr.metallicFactor : 1,
        rough: pbr.roughnessFactor !== undefined ? pbr.roughnessFactor : 1,
        alpha: col[3] !== undefined ? col[3] : 1,
        tex: texIdx, pos: pos
      };
    }

    function walk(ni, parent) {
      var nd = g.json.nodes[ni];
      var m = mul(parent, nodeMatrix(nd));
      if (nd.mesh !== undefined) {
        var mesh = g.json.meshes[nd.mesh];
        var prims = [];
        mesh.primitives.forEach(function (p) {
          var q = prim(p);
          if (q) prims.push(q);
        });
        if (prims.length) {
          // one bounding box for the whole part, from every primitive in it
          var lo = [1e30, 1e30, 1e30], hi = [-1e30, -1e30, -1e30];
          prims.forEach(function (q) {
            var b = boxOf(q.pos, m);
            for (var k = 0; k < 3; k++) {
              lo[k] = Math.min(lo[k], b.lo[k]);
              hi[k] = Math.max(hi[k], b.hi[k]);
            }
            q.pos = null;                    // release the copy, GL has it now
          });
          seen.push({
            name: nd.name || mesh.name || ('part ' + seen.length),
            model: m, prims: prims,
            alpha: Math.min.apply(null, prims.map(function (q) { return q.alpha; })),
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

  /* Textures live in bufferViews inside the glb, so they are decoded from
     blobs rather than fetched. There are only a handful (the strap pattern and
     the dial art); everything else is a flat material factor. */
  var texes = [];
  function loadTextures(g) {
    if (!g.json.textures) return Promise.resolve();
    var jobs = g.json.textures.map(function (t, i) {
      var im = g.json.images[t.source];
      if (!im || im.bufferView === undefined) return null;
      var v = g.json.bufferViews[im.bufferView];
      var blob = new Blob([new Uint8Array(g.bin, v.byteOffset || 0, v.byteLength)],
        { type: im.mimeType || 'image/jpeg' });
      return createImageBitmap(blob).then(function (bmp) {
        var t2 = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t2);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        texes[i] = t2;
        bmp.close && bmp.close();
      }).catch(function () {});
    }).filter(Boolean);
    return Promise.all(jobs);
  }

  /* Uploads the accessor in its own type rather than widening everything to
     float. The prepped model stores positions as int16 (dequantized by the
     node transform) and normals as normalized int8, which is most of why it is
     8.5 MB instead of 28. */
  function bindAttr(loc, arr, n) {
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    if (arr instanceof Int8Array)
      gl.vertexAttribPointer(loc, n, gl.BYTE, true, 0, 0);
    else if (arr instanceof Int16Array)
      gl.vertexAttribPointer(loc, n, gl.SHORT, false, 0, 0);
    else if (arr instanceof Uint16Array)
      gl.vertexAttribPointer(loc, n, gl.UNSIGNED_SHORT, false, 0, 0);
    else
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 0, 0);
  }

  function faceNormals(pos, idx) {
    var n = new Float32Array(pos.length);
    var tri = idx || { length: pos.length / 3, get: null };
    var count = idx ? idx.length : pos.length / 3;
    for (var i = 0; i < count; i += 3) {
      var a = (idx ? idx[i] : i) * 3, b = (idx ? idx[i + 1] : i + 1) * 3,
        c = (idx ? idx[i + 2] : i + 2) * 3;
      var u = [pos[b] - pos[a], pos[b + 1] - pos[a + 1], pos[b + 2] - pos[a + 2]];
      var v = [pos[c] - pos[a], pos[c + 1] - pos[a + 1], pos[c + 2] - pos[a + 2]];
      var f = cross(u, v);
      [a, b, c].forEach(function (o) {
        n[o] += f[0]; n[o + 1] += f[1]; n[o + 2] += f[2];
      });
    }
    for (var k = 0; k < n.length; k += 3) {
      var l = Math.hypot(n[k], n[k + 1], n[k + 2]) || 1;
      n[k] /= l; n[k + 1] /= l; n[k + 2] /= l;
    }
    return n;
  }

  function boxOf(pos, m) {
    var lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (var i = 0; i < pos.length; i += 3) {
      var x = pos[i], y = pos[i + 1], z = pos[i + 2];
      var wx = m[0] * x + m[4] * y + m[8] * z + m[12];
      var wy = m[1] * x + m[5] * y + m[9] * z + m[13];
      var wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      lo[0] = Math.min(lo[0], wx); hi[0] = Math.max(hi[0], wx);
      lo[1] = Math.min(lo[1], wy); hi[1] = Math.max(hi[1], wy);
      lo[2] = Math.min(lo[2], wz); hi[2] = Math.max(hi[2], wz);
    }
    return { lo: lo, hi: hi,
      c: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2],
      r: Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2 };
  }

  /* ------------------------------------------------------------ camera */
  var cam = { yaw: -0.55, pitch: 0.42, dist: 3, target: [0, 0, 0] };
  var drag = { on: false, x: 0, y: 0, yaw: 0, pitch: 0, id: null };
  var progress = 0, explode = 0, focus = -1, fade = 1;

  host.addEventListener('pointerdown', function (e) {
    if (drag.id !== null) return;
    drag.on = true; drag.id = e.pointerId;
    drag.x = e.clientX; drag.y = e.clientY;
    host.classList.add('is-drag');
    if (host.setPointerCapture) { try { host.setPointerCapture(e.pointerId); } catch (x) {} }
  });
  host.addEventListener('pointermove', function (e) {
    if (!drag.on || e.pointerId !== drag.id) return;
    drag.yaw += (e.clientX - drag.x) * 0.008;
    drag.pitch += (e.clientY - drag.y) * 0.006;
    drag.pitch = Math.max(-1.2, Math.min(1.2, drag.pitch));
    drag.x = e.clientX; drag.y = e.clientY;
    kick();
  });
  function endDrag(e) {
    if (e && e.pointerId !== drag.id) return;
    drag.on = false; drag.id = null; host.classList.remove('is-drag');
  }
  host.addEventListener('pointerup', endDrag);
  host.addEventListener('pointercancel', endDrag);
  host.addEventListener('lostpointercapture', endDrag);

  /* ------------------------------------------------------------ timeline */
  var STOPS = [];
  function buildTimeline() {
    // order parts back-to-front along the assembly axis so the explode reads
    // as a stack coming apart rather than an arbitrary scatter
    /* A curated tour. The assembly has 17 parts but several are spring bars,
       gaskets and keepers a millimetre across -- stopping the camera on those
       gives a screen of empty white. data-tour names the ones worth a beat, in
       the order they should be visited; anything else still renders, it just
       never becomes the subject. */
    var wanted = (host.dataset.tour || '').split(',')
      .map(function (s) { return s.trim().toLowerCase(); })
      .filter(Boolean);
    var order;
    if (wanted.length) {
      order = [];
      wanted.forEach(function (w) {
        parts.forEach(function (p, i) {
          if (p.name.toLowerCase() === w && order.indexOf(i) < 0) order.push(i);
        });
      });
    }
    if (!order || !order.length) {
      // fall back to every part big enough to read, top of the stack down
      order = parts.map(function (p, i) { return i; })
        .filter(function (i) { return parts[i].box.r > bounds.r * 0.09; })
        .sort(function (a, b) { return parts[b].box.c[2] - parts[a].box.c[2]; });
    }

    STOPS = [{ at: 0.00, explode: 0, focus: -1 },
      { at: 0.16, explode: 1, focus: -1 }];
    var span = 0.66, n = order.length;
    order.forEach(function (pi, k) {
      STOPS.push({ at: 0.20 + span * (k + 0.5) / n, explode: 1, focus: pi });
    });
    STOPS.push({ at: 0.90, explode: 1, focus: -1 });
    STOPS.push({ at: 1.00, explode: 0, focus: -1 });
  }

  function sample(t) {
    var i = 0;
    while (i < STOPS.length - 2 && t > STOPS[i + 1].at) i++;
    var a = STOPS[i], b = STOPS[i + 1];
    var u = smooth(clamp01((t - a.at) / Math.max(b.at - a.at, 1e-4)));
    explode = lerp(a.explode, b.explode, u);
    // focus snaps to whichever stop is nearer, so a part is held rather than
    // smeared through on the way to the next one
    focus = u < 0.5 ? a.focus : b.focus;
    var near = u < 0.5 ? 1 - u * 2 : (u - 0.5) * 2;
    return near;
  }

  /* ------------------------------------------------------------ render */
  var raf = 0, size = [0, 0];

  function resize() {
    var r = canvas.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (w === size[0] && h === size[1]) return;
    canvas.width = w; canvas.height = h; size = [w, h];
    gl.viewport(0, 0, w, h);
  }

  function frame() {
    raf = 0;
    resize();
    if (!ready) return;

    var hold = sample(progress);
    var span = bounds.r * 2.2;

    /* Camera target and distance: the whole assembly, or the focused part.
       The wide distance grows with the explode, because a spread stack is far
       bigger than a closed one and would otherwise burst out of frame. */
    var spread = spacing * (parts.length - 1) * explode;
    var wide = Math.max(bounds.r * 3.1, (bounds.r * 2 + spread) * 1.15);
    var tgt = bounds.c.slice(), dist = wide;
    if (focus >= 0) {
      var p = parts[focus];
      var c = p.box.c.slice();
      c[2] += offsetFor(focus) * explode;
      var pull = smooth(clamp01(hold * 1.6));
      tgt = [lerp(bounds.c[0], c[0], pull), lerp(bounds.c[1], c[1], pull),
        lerp(bounds.c[2], c[2], pull)];
      dist = lerp(wide, Math.max(p.box.r * 3.6, bounds.r * 0.40), pull);
      dist = Math.max(dist, bounds.r * 0.26);     // never inside the near plane
    }

    var yaw = cam.yaw + drag.yaw + progress * 1.1;
    var pitch = Math.max(-1.25, Math.min(1.25, cam.pitch + drag.pitch));
    var eye = [
      tgt[0] + dist * Math.cos(pitch) * Math.sin(yaw),
      tgt[1] + dist * Math.sin(pitch),
      tgt[2] + dist * Math.cos(pitch) * Math.cos(yaw)];

    var proj = perspective(0.62, size[0] / Math.max(size[1], 1),
      bounds.r * 0.04, bounds.r * 40);
    var view = lookAt(eye, tgt, [0, 1, 0]);

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE,
      gl.ONE_MINUS_SRC_ALPHA);

    gl.uniformMatrix4fv(U.uProj, false, proj);
    gl.uniformMatrix4fv(U.uView, false, view);
    gl.uniform3fv(U.uEye, eye);

    /* Draw order matters twice over. Transparent parts go last so the crystal
       composites over what sits behind it. And when a part is being focused it
       is drawn FIRST and opaque, with everything else following as ghosts with
       depth writes off -- otherwise a large part like the strap sits between
       the camera and a small one like the crown and simply hides it. Ghosting
       rather than culling keeps the assembly legible around the subject. */
    var order = parts.map(function (p, i) { return i; })
      .sort(function (a, b) {
        if (focus >= 0) {
          if (a === focus) return -1;
          if (b === focus) return 1;
        }
        return (parts[a].alpha < 1) - (parts[b].alpha < 1);
      });

    var ghost = focus >= 0 ? lerp(1, 0.13, smooth(clamp01(hold * 1.6))) : 1;

    order.forEach(function (i) {
      var p = parts[i];
      var isGhost = focus >= 0 && i !== focus;
      gl.depthMask(!isGhost);

      // the explode offset is applied on top of the part's own transform,
      // which also carries its dequantization scale
      var m = p.model.slice();
      m[14] += offsetFor(i) * explode;
      gl.uniformMatrix4fv(U.uModel, false, m);
      gl.uniformMatrix3fv(U.uNrm, false, normalMat(m));
      gl.uniform1f(U.uFade, isGhost ? lerp(1, 0.30, smooth(clamp01(hold * 1.6))) : 1);

      p.prims.forEach(function (q) {
        gl.uniform3fv(U.uColor, q.color);
        gl.uniform1f(U.uMetal, q.metal);
        gl.uniform1f(U.uRough, Math.max(q.rough, 0.06));
        gl.uniform1f(U.uAlpha, isGhost ? q.alpha * ghost : q.alpha);
        var t = q.tex >= 0 ? texes[q.tex] : null;
        gl.uniform1f(U.uHasTex, t ? 1 : 0);
        if (t) {
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, t);
          gl.uniform1i(U.uTex, 0);
        }
        gl.bindVertexArray(q.vao);
        if (q.indexed) gl.drawElements(gl.TRIANGLES, q.count, q.itype, 0);
        else gl.drawArrays(gl.TRIANGLES, 0, q.count);
      });
    });
    gl.bindVertexArray(null);
    gl.depthMask(true);

    if (label) {
      var on = focus >= 0 && hold > 0.25;
      label.classList.toggle('is-on', on);
      if (on && nameEl) {
        nameEl.textContent = parts[focus].name;
        if (noteEl) noteEl.textContent = (focus + 1) + ' / ' + parts.length;
      }
    }
    if (bar) bar.style.transform = 'scaleX(' + progress.toFixed(4) + ')';
  }

  /* Spread by RANK along the assembly axis, not by true distance.

     True distance fails badly here: the strap hangs ~48 mm below the case
     while the twelve parts that make up the watch head are stacked inside
     9 mm. Scaled against the whole bounding box those twelve land within a
     couple of percent of each other and the head never visibly comes apart --
     which is what the first attempt did. Ranking them and spacing evenly is
     also what a drafted exploded view actually does.

     Spacing comes off the median part radius so it tracks the size of the
     things being separated rather than the strap's reach. */
  var rank = [], spacing = 1;
  function buildSpread() {
    var byZ = parts.map(function (p, i) { return i; })
      .sort(function (a, b) { return parts[a].box.c[2] - parts[b].box.c[2]; });
    rank = new Array(parts.length);
    byZ.forEach(function (pi, k) { rank[pi] = k; });

    var radii = parts.map(function (p) { return p.box.r; }).sort(function (a, b) {
      return a - b;
    });
    var median = radii[Math.floor(radii.length / 2)] || bounds.r * 0.3;
    spacing = median * 0.62;
  }

  function offsetFor(i) {
    return (rank[i] - (parts.length - 1) / 2) * spacing;
  }

  /* Inverse-transpose of the upper 3x3, not the 3x3 itself. The prep step
     quantizes each part in its own frame, so every node carries a different
     non-uniform scale; using the raw matrix would skew every normal and the
     shading would go visibly wrong on anything that is not a cube. */
  function normalMat(m) {
    var a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6],
      g = m[8], h = m[9], i = m[10];
    var A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
    var det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-20)
      return new Float32Array([a, b, c, d, e, f, g, h, i]);
    var id = 1 / det;
    // (M^-1)^T, written out directly
    return new Float32Array([
      A * id, B * id, C * id,
      (c * h - b * i) * id, (a * i - c * g) * id, (b * g - a * h) * id,
      (b * f - c * e) * id, (c * d - a * f) * id, (a * e - b * d) * id]);
  }

  function kick() { if (!raf) raf = requestAnimationFrame(frame); }

  /* ------------------------------------------------------------ scroll */
  function onScroll() {
    var r = track.getBoundingClientRect();
    var travel = r.height - window.innerHeight;
    progress = travel > 0 ? clamp01(-r.top / travel) : 0;
    kick();
  }

  /* ------------------------------------------------------------ load */
  function fail(msg) {
    failed = true;
    host.classList.add('xv-fallback');
    if (window.console) console.warn('[exploded view]', msg);
  }

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
      return loadTextures(g).then(function () { return g; });
    }).then(function (g) {

      var lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
      parts.forEach(function (p) {
        for (var i = 0; i < 3; i++) {
          lo[i] = Math.min(lo[i], p.box.lo[i]);
          hi[i] = Math.max(hi[i], p.box.hi[i]);
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
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', function () { size = [0, 0]; kick(); },
        { passive: true });
      onScroll();
      if (reduce) { progress = 0.5; kick(); }
    }).catch(function (e) { fail(e.message); });
  }, { rootMargin: '700px 0px' });

  io.observe(host);
})();
