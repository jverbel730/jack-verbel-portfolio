/* Jack Verbel — portfolio
   Hover pops: three small themed icons drift out of an element and fade.
   Add data-pop="<name>" to any element; names are the keys of ICONS below.
   Silent no-op on touch devices and when the visitor prefers reduced motion. */
(function () {
  'use strict';

  var S = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">';

  var ICONS = {
    watch: S + '<circle cx="12" cy="12" r="5.4"/><path d="M12 9.3V12l1.9 1.3"/>' +
      '<path d="M9.6 6.8 10 3.4h4l.4 3.4M9.6 17.2 10 20.6h4l.4-3.4"/></svg>',

    wrench: S + '<path d="M14.6 6.4a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.7-3.7a6 6 0 0 1-7.9 7.9' +
      'l-6.8 6.8a2.1 2.1 0 0 1-3-3l6.8-6.8a6 6 0 0 1 7.9-7.9l-3.7 3.7z"/></svg>',

    javelin: S + '<path d="M4.5 19.5 18 6"/><path d="M21 3l-4.6 1.1 3.5 3.5z" fill="currentColor" stroke="none"/>' +
      '<path d="M10.4 11.9 12.1 13.6"/></svg>',

    box: S + '<path d="M21 8v8l-9 5-9-5V8l9-5 9 5z"/><path d="M3.3 7.6 12 12.5l8.7-4.9M12 21v-8.5"/></svg>',

    pencil: S + '<path d="M17.5 3.2a2.6 2.6 0 0 1 3.7 3.7L7.6 20.5 2.6 22l1.5-5z"/><path d="M15.4 5.3 19 8.9"/></svg>',

    gear: S + '<circle cx="12" cy="12" r="6.6"/><circle cx="12" cy="12" r="2.5"/>' +
      '<path d="M12 2.2v2.6M12 19.2v2.6M21.8 12h-2.6M4.8 12H2.2M18.9 5.1l-1.8 1.8M6.9 17.1l-1.8 1.8' +
      'M18.9 18.9l-1.8-1.8M6.9 6.9 5.1 5.1"/></svg>',

    trophy: S + '<circle cx="12" cy="9" r="5"/><path d="M9.2 13.7 8.2 22l3.8-2.2L15.8 22l-1-8.3"/></svg>',

    cap: S + '<path d="M2 8.6 12 4l10 4.6-10 4.6z"/><path d="M6.2 10.7V15c0 1.7 2.6 3 5.8 3s5.8-1.3 5.8-3v-4.3"/></svg>',

    mail: S + '<rect x="2.6" y="5" width="18.8" height="14" rx="2.4"/><path d="m3.4 6.6 8.6 5.8 8.6-5.8"/></svg>',

    phone: S + '<rect x="6.2" y="2.4" width="11.6" height="19.2" rx="2.6"/><path d="M10.4 5.4h3.2"/></svg>',

    pin: S + '<path d="M12 21.2s6.8-5.6 6.8-11a6.8 6.8 0 1 0-13.6 0c0 5.4 6.8 11 6.8 11z"/><circle cx="12" cy="10" r="2.4"/></svg>',

    linkedin: S + '<rect x="3" y="3" width="18" height="18" rx="3.2"/><path d="M7.6 10.6V17M7.6 7.3v.1' +
      'M11.6 17v-3.5a2.4 2.4 0 0 1 4.8 0V17"/></svg>',

    bulb: S + '<path d="M9.4 18.2h5.2M10.4 21h3.2"/>' +
      '<path d="M12 3a6 6 0 0 0-3.5 10.9c.6.4.9 1.1.9 1.8v.5h5.2v-.5c0-.7.3-1.4.9-1.8A6 6 0 0 0 12 3z"/></svg>',

    cube: S + '<path d="M12 2.6 20.5 7v10L12 21.4 3.5 17V7z"/><path d="M3.5 7 12 11.6 20.5 7M12 11.6v9.8"/></svg>',

    air: S + '<path d="M3 8.2h10.4a2.9 2.9 0 1 0-2.9-2.9"/><path d="M3 12.6h13.6a2.9 2.9 0 1 1-2.9 2.9"/><path d="M3 17h8.4"/></svg>'
  };

  if (window.matchMedia) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (window.matchMedia('(hover: none)').matches) return;
  }

  var COUNT = 3;

  function burst(el, name) {
    var svg = ICONS[name];
    if (!svg) return;
    var r = el.getBoundingClientRect();
    if (!r.width) return;

    var top = r.top + (window.pageYOffset || 0);
    var left = r.left + (window.pageXOffset || 0);
    // spread across the element, but never wider than a comfortable 220px
    var span = Math.min(r.width, 220);
    var originX = left + (r.width - span) / 2;

    for (var i = 0; i < COUNT; i++) {
      var s = document.createElement('span');
      s.className = 'pop' + (i === 1 ? ' pop-deep' : '');
      s.innerHTML = svg;
      // keep the icon inside the page so a burst never adds a scrollbar
      var x = originX + span * (0.18 + 0.32 * i);
      var limit = (document.documentElement.clientWidth || 0) - 30;
      if (limit > 40) x = Math.max(24, Math.min(x, limit));
      s.style.left = x + 'px';
      s.style.top = (top + r.height * 0.35) + 'px';
      s.style.setProperty('--dx', ((i - 1) * 20 + (Math.random() * 12 - 6)).toFixed(1) + 'px');
      s.style.setProperty('--dy', (-30 - Math.random() * 16).toFixed(1) + 'px');
      s.style.setProperty('--rot', (Math.random() * 44 - 22).toFixed(1) + 'deg');
      s.style.animationDelay = (i * 55) + 'ms';
      document.body.appendChild(s);
      (function (node) {
        setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 1100);
      })(s);
    }
  }

  function wire(el) {
    var busy = false;
    el.addEventListener('mouseenter', function () {
      if (busy) return;
      busy = true;
      setTimeout(function () { busy = false; }, 620);
      burst(el, el.getAttribute('data-pop'));
    });
  }

  function init(root) {
    var nodes = (root || document).querySelectorAll('[data-pop]');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].__popWired) continue;
      nodes[i].__popWired = 1;
      wire(nodes[i]);
    }
  }

  // content injected later (the locked case study) re-uses this
  window.__wirePops = init;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

/* Custom cursor — an arcane sigil: a four-point spark on the pointer, four
   fixed cardinal marks, and two counter-turning rune rings that trail behind.
   Opens and quickens over anything interactive; casts a rune ring on click.
   Native cursor is only hidden once this runs, so no-JS keeps its arrow. */
(function () {
  'use strict';

  if (!window.matchMedia) return;
  if (window.matchMedia('(hover: none)').matches) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var core, ring, x = -200, y = -200, rx = -200, ry = -200, raf = 0, started = false;

  // a four-point arcane spark sits on the pointer
  var STAR = '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path fill="currentColor" d="M12 1c.55 5.35 4.65 9.45 10 10-5.35.55-9.45 4.65-10 10' +
    '-.55-5.35-4.65-9.45-10-10 5.35-.55 9.45-4.65 10-10z"/></svg>';

  // two rune rings: broken dashes so they read as turning glyphs
  var ORBIT_OUTER = '<svg viewBox="0 0 48 48" aria-hidden="true" fill="none" ' +
    'stroke="currentColor" stroke-linecap="round">' +
    '<circle cx="24" cy="24" r="21" stroke-width="1.7" stroke-dasharray="2.5 8.5"/>' +
    '<circle cx="24" cy="24" r="17" stroke-width="1.3" stroke-dasharray="18 30" opacity="0.75"/>' +
    '</svg>';

  var ORBIT_INNER = '<svg viewBox="0 0 48 48" aria-hidden="true" fill="none" ' +
    'stroke="currentColor" stroke-linecap="round">' +
    '<circle cx="24" cy="24" r="19" stroke-width="2" stroke-dasharray="11 26"/>' +
    '</svg>';

  // the cast ring thrown on click
  var CAST = '<svg viewBox="0 0 48 48" aria-hidden="true" fill="none" ' +
    'stroke="currentColor" stroke-linecap="round">' +
    '<circle cx="24" cy="24" r="20" stroke-width="1.8" stroke-dasharray="3 9"/>' +
    '<circle cx="24" cy="24" r="14" stroke-width="1.2" stroke-dasharray="16 26" opacity="0.7"/>' +
    '</svg>';

  function build() {
    core = document.createElement('div');
    core.id = 'xcur-core';
    core.setAttribute('aria-hidden', 'true');
    core.innerHTML = '<i class="xc-star">' + STAR + '</i><i class="xc-t xc-n"></i>' +
                     '<i class="xc-t xc-s"></i><i class="xc-t xc-w"></i><i class="xc-t xc-e"></i>';

    ring = document.createElement('div');
    ring.id = 'xcur-ring';
    ring.setAttribute('aria-hidden', 'true');
    ring.innerHTML = '<i class="xc-orbit o1">' + ORBIT_OUTER + '</i>' +
                     '<i class="xc-orbit o2">' + ORBIT_INNER + '</i>';

    document.body.appendChild(ring);
    document.body.appendChild(core);
    document.documentElement.classList.add('xcur-on');
  }

  function loop() {
    rx += (x - rx) * 0.19;
    ry += (y - ry) * 0.19;
    core.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
    ring.style.transform = 'translate3d(' + rx + 'px,' + ry + 'px,0)';
    raf = requestAnimationFrame(loop);
  }

  var HOT = 'a,button,[data-pop],.card,input,textarea,select,summary,[role="button"],#globe';

  function onMove(e) {
    x = e.clientX; y = e.clientY;
    if (!started) {
      started = true;
      rx = x; ry = y;
      core.style.opacity = ring.style.opacity = '1';
      raf = requestAnimationFrame(loop);
    }
    var hot = e.target && e.target.closest && e.target.closest(HOT);
    core.classList.toggle('is-hot', !!hot);
    ring.classList.toggle('is-hot', !!hot);
  }

  function ripple() {
    var r = document.createElement('i');
    r.className = 'xc-ripple';
    r.innerHTML = CAST;
    r.style.left = x + 'px';
    r.style.top = y + 'px';
    document.body.appendChild(r);
    setTimeout(function () { if (r.parentNode) r.parentNode.removeChild(r); }, 700);
  }

  function start() {
    build();
    document.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('mousedown', function () {
      core.classList.add('is-down');
      ring.classList.add('is-down');
      ripple();
    });
    document.addEventListener('mouseup', function () {
      core.classList.remove('is-down');
      ring.classList.remove('is-down');
    });
    document.addEventListener('mouseleave', function () {
      core.style.opacity = ring.style.opacity = '0';
    });
    document.addEventListener('mouseenter', function () {
      core.style.opacity = ring.style.opacity = '1';
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();

/* Interactive globe — a wireframe fantasy planet carrying the design process.
   Auto-spins, and you can grab it and throw it. Renders itself into #globe. */
(function () {
  'use strict';

  var host = document.getElementById('globe');
  if (!host) return;

  var NS = 'http://www.w3.org/2000/svg';
  var R = 150, CX = 200, CY = 200;
  var DEG = Math.PI / 180;

  // ---- the six stops, placed so each swings to the front in turn -------------
  var STEPS = [
    { lat: 36, lon: -60, label: 'Research',    icon: 'M11 3.6a7.4 7.4 0 1 0 0 14.8 7.4 7.4 0 0 0 0-14.8M16.4 16.4 21 21' },
    { lat: 10, lon: -12, label: 'Sketching',   icon: 'M17.5 3.2a2.6 2.6 0 0 1 3.7 3.7L7.6 20.5 2.6 22l1.5-5zM15.4 5.3 19 8.9' },
    { lat: -30, lon: -42, label: 'Ideation',   icon: 'M9.4 18.2h5.2M10.4 21h3.2M12 3a6 6 0 0 0-3.5 10.9c.6.4.9 1.1.9 1.8v.5h5.2v-.5c0-.7.3-1.4.9-1.8A6 6 0 0 0 12 3z' },
    { lat: 32, lon: 62, label: 'CAD',          icon: 'M12 2.6 20.5 7v10L12 21.4 3.5 17V7zM3.5 7 12 11.6 20.5 7M12 11.6v9.8' },
    { lat: -16, lon: 112, label: 'Prototyping', icon: 'M3.4 8.2 12 3.4l8.6 4.8-8.6 4.8zM3.4 12.6 12 17.4l8.6-4.8M3.4 17 12 21.8l8.6-4.8' },
    { lat: -4, lon: 176, label: 'Rendering',   icon: 'M12 20.2a6.8 6.8 0 1 0 0-13.6 6.8 6.8 0 0 0 0 13.6M9.4 11a3.6 3.6 0 0 1 2.4-1.1M12 2v1.9M20.1 5.9l-1.4 1.4M3.9 5.9l1.4 1.4' } //
  ];

  // ---- geometry -------------------------------------------------------------
  function v(lat, lon) {
    var a = lat * DEG, b = lon * DEG;
    return [Math.cos(a) * Math.sin(b), Math.sin(a), Math.cos(a) * Math.cos(b)];
  }

  var wires = [];
  for (var lon = -180; lon < 180; lon += 30) {          // meridians
    var m = [];
    for (var la = -90; la <= 90; la += 4) m.push(v(la, lon));
    wires.push({ pts: m, w: lon === 0 ? 1.5 : 1 });
  }
  [-60, -30, 0, 30, 60].forEach(function (la) {          // parallels
    var q = [];
    for (var lo = -180; lo <= 180; lo += 4) q.push(v(la, lo));
    wires.push({ pts: q, w: la === 0 ? 1.5 : 1 });
  });

  // ---- fantasy landmasses: wobbled circles rolled onto the sphere ------------
  function blob(lat, lon, size, seed) {
    var out = [], base = v(lat, lon);
    // an orthonormal frame at the blob centre
    var up = Math.abs(base[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
    var e1 = norm(cross(up, base)), e2 = cross(base, e1);
    for (var i = 0; i <= 46; i++) {
      var t = i / 46 * Math.PI * 2;
      var r = size * (1 + 0.30 * Math.sin(3 * t + seed) + 0.18 * Math.sin(5 * t + seed * 2)
                        + 0.10 * Math.sin(8 * t + seed * 3));
      var s = Math.sin(r), c = Math.cos(r);
      out.push(norm([
        base[0] * c + (e1[0] * Math.cos(t) + e2[0] * Math.sin(t)) * s,
        base[1] * c + (e1[1] * Math.cos(t) + e2[1] * Math.sin(t)) * s,
        base[2] * c + (e1[2] * Math.cos(t) + e2[2] * Math.sin(t)) * s
      ]));
    }
    return { pts: out, c: base };
  }
  function cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
  function norm(a) { var l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0]/l, a[1]/l, a[2]/l]; }

  var LAND = [
    blob(28, -46, 0.44, 1.1), blob(-22, -18, 0.36, 2.7), blob(6, 74, 0.40, 4.2),
    blob(-40, 130, 0.30, 0.6), blob(52, 158, 0.26, 3.3), blob(-6, -128, 0.28, 5.1)
  ];

  // ---- svg scaffold ---------------------------------------------------------
  function el(n, at) { var e = document.createElementNS(NS, n); for (var k in at) e.setAttribute(k, at[k]); return e; }

  var svg = el('svg', { viewBox: '0 0 400 400', class: 'globe-svg' });
  svg.appendChild(el('circle', { cx: CX, cy: CY, r: R + 16, class: 'g-atmo' }));
  svg.appendChild(el('circle', { cx: CX, cy: CY, r: R, class: 'g-disc' }));

  var gLand = el('g', { class: 'g-land' });
  var gWire = el('g', { class: 'g-wire' });
  var gMark = el('g', { class: 'g-mark' });
  svg.appendChild(gLand); svg.appendChild(gWire);
  svg.appendChild(el('circle', { cx: CX, cy: CY, r: R, class: 'g-limb' }));
  svg.appendChild(gMark);
  host.appendChild(svg);

  var landPaths = LAND.map(function () { var p = el('path', {}); gLand.appendChild(p); return p; });
  var wirePaths = wires.map(function (w) {
    var p = el('path', { 'stroke-width': w.w }); gWire.appendChild(p); return p;
  });

  var marks = STEPS.map(function (s) {
    var g = el('g', { class: 'g-step' });
    g.appendChild(el('circle', { r: 5.5, class: 'g-dot' }));
    var ico = el('g', { class: 'g-ico' });
    ico.appendChild(el('path', { d: s.icon }));
    g.appendChild(ico);
    var t = el('text', { class: 'g-lab', x: 26, y: 5 });
    t.textContent = s.label;
    g.appendChild(t);
    var lead = el('path', { class: 'g-lead', d: 'M7 0H21' });
    g.appendChild(lead);
    gMark.appendChild(g);
    return { g: g, ico: ico, lab: t, lead: lead, p: v(s.lat, s.lon) };
  });

  // ---- rotation -------------------------------------------------------------
  var yaw = 0.6, pitch = -0.24, spin = 0.0022, vy = 0, vp = 0, dragging = false, px = 0, py = 0;
  var slow = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function rot(p) {
    var cy0 = Math.cos(yaw), sy = Math.sin(yaw);
    var x = p[0] * cy0 + p[2] * sy, z = -p[0] * sy + p[2] * cy0, y = p[1];
    var cp = Math.cos(pitch), sp = Math.sin(pitch);
    return [x, y * cp - z * sp, y * sp + z * cp];
  }
  function sx(q) { return CX + R * q[0]; }
  function sy2(q) { return CY - R * q[1]; }

  function draw() {
    // wires, split where they pass behind the limb
    for (var i = 0; i < wires.length; i++) {
      var d = '', pen = false;
      var pts = wires[i].pts;
      for (var j = 0; j < pts.length; j++) {
        var q = rot(pts[j]);
        if (q[2] > 0) { d += (pen ? 'L' : 'M') + sx(q).toFixed(1) + ' ' + sy2(q).toFixed(1); pen = true; }
        else pen = false;
      }
      wirePaths[i].setAttribute('d', d);
    }
    // landmasses; points behind the limb are pinned to the rim
    for (var k = 0; k < LAND.length; k++) {
      var c = rot(LAND[k].c);
      if (c[2] < -0.30) { landPaths[k].setAttribute('d', ''); continue; }
      var dd = '', ps = LAND[k].pts;
      for (var n = 0; n < ps.length; n++) {
        var r2 = rot(ps[n]), X, Y;
        if (r2[2] >= 0) { X = sx(r2); Y = sy2(r2); }
        else { var l = Math.hypot(r2[0], r2[1]) || 1; X = CX + R * r2[0] / l; Y = CY - R * r2[1] / l; }
        dd += (n ? 'L' : 'M') + X.toFixed(1) + ' ' + Y.toFixed(1);
      }
      landPaths[k].setAttribute('d', dd + 'Z');
      landPaths[k].setAttribute('opacity', (0.55 + 0.45 * Math.max(0, c[2])).toFixed(2));
    }
    // markers
    for (var m = 0; m < marks.length; m++) {
      var mk = marks[m], q2 = rot(mk.p);
      if (q2[2] <= 0.06) { mk.g.setAttribute('opacity', 0); mk.g.style.display = 'none'; continue; }
      mk.g.style.display = '';
      var o = Math.min(1, (q2[2] - 0.06) / 0.34);
      mk.g.setAttribute('opacity', o.toFixed(2));
      mk.g.setAttribute('transform', 'translate(' + sx(q2).toFixed(1) + ' ' + sy2(q2).toFixed(1) + ')');
      mk.ico.setAttribute('transform', 'translate(-9 -30) scale(0.78)');
      // flip the label inboard when the marker sits near the right limb
      var flip = sx(q2) > CX + 46;
      mk.lab.setAttribute('x', flip ? -26 : 26);
      mk.lab.setAttribute('text-anchor', flip ? 'end' : 'start');
      mk.lead.setAttribute('d', flip ? 'M-7 0H-21' : 'M7 0H21');
      var show = q2[2] > 0.52;
      mk.lab.setAttribute('opacity', show ? 1 : 0);
      mk.lead.setAttribute('opacity', show ? 0.7 : 0);
    }
  }

  function frame() {
    if (!dragging) {
      yaw += vy + (slow ? 0 : spin);
      pitch += vp;
      vy *= 0.94; vp *= 0.94;
      if (Math.abs(vy) < 1e-5) vy = 0;
      if (Math.abs(vp) < 1e-5) vp = 0;
      pitch = Math.max(-1.15, Math.min(1.15, pitch));
    }
    draw();
    requestAnimationFrame(frame);
  }

  host.addEventListener('pointerdown', function (e) {
    dragging = true; px = e.clientX; py = e.clientY; vy = vp = 0;
    host.setPointerCapture(e.pointerId); host.classList.add('is-grabbed');
  });
  host.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    var dx = e.clientX - px, dy = e.clientY - py;
    px = e.clientX; py = e.clientY;
    yaw += dx * 0.0075;
    pitch = Math.max(-1.15, Math.min(1.15, pitch + dy * 0.0060));
    vy = dx * 0.0075; vp = dy * 0.0060;
    draw();
  });
  function release(e) {
    if (!dragging) return;
    dragging = false; host.classList.remove('is-grabbed');
    try { host.releasePointerCapture(e.pointerId); } catch (err) {}
  }
  host.addEventListener('pointerup', release);
  host.addEventListener('pointercancel', release);

  draw();
  requestAnimationFrame(frame);
})();
