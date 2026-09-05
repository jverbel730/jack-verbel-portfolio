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

  function init() {
    var nodes = document.querySelectorAll('[data-pop]');
    for (var i = 0; i < nodes.length; i++) wire(nodes[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

/* Custom cursor — a soft crosshair: centre dot, four pill ticks, and a ring
   that trails behind. Grows over anything interactive, springs on click.
   Native cursor is only hidden once this runs, so no-JS keeps its arrow. */
(function () {
  'use strict';

  if (!window.matchMedia) return;
  if (window.matchMedia('(hover: none)').matches) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var core, ring, x = -200, y = -200, rx = -200, ry = -200, raf = 0, started = false;

  function build() {
    core = document.createElement('div');
    core.id = 'xcur-core';
    core.setAttribute('aria-hidden', 'true');
    core.innerHTML = '<i class="xc-dot"></i><i class="xc-t xc-n"></i>' +
                     '<i class="xc-t xc-s"></i><i class="xc-t xc-w"></i><i class="xc-t xc-e"></i>';

    ring = document.createElement('div');
    ring.id = 'xcur-ring';
    ring.setAttribute('aria-hidden', 'true');
    ring.innerHTML = '<i class="xc-ring"></i>';

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

  var HOT = 'a,button,[data-pop],.card,input,textarea,select,summary,[role="button"]';

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
    r.style.left = x + 'px';
    r.style.top = y + 'px';
    document.body.appendChild(r);
    setTimeout(function () { if (r.parentNode) r.parentNode.removeChild(r); }, 620);
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
