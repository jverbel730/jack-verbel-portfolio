/* Jack Verbel — portfolio behaviour.

   Two small things, and deliberately nothing else. A reviewer gives this
   site a couple of minutes; anything that delays or hijacks their scroll
   is spending that time on the wrong thing.

     1. a hairline under the nav once the page has moved
     2. a short rise-and-fade as each beat arrives

   Both are IntersectionObserver-driven, so there is no scroll handler and
   no rAF loop running behind the page. */
(function () {
  'use strict';

  var reduce = window.matchMedia &&
               window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---- nav hairline ---- */
  var nav = document.querySelector('.nav');
  if (nav && 'IntersectionObserver' in window) {
    var probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:1px;';
    document.body.prepend(probe);
    new IntersectionObserver(function (entries) {
      nav.classList.toggle('is-stuck', !entries[0].isIntersecting);
    }).observe(probe);
  }

  /* ---- reveal on arrival ---- */
  if (reduce || !('IntersectionObserver' in window)) return;

  var targets = document.querySelectorAll('[data-rv]');
  if (!targets.length) return;

  var io = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (!e.isIntersecting) continue;
      e.target.classList.add('rv-in');
      io.unobserve(e.target);           // one-shot; nothing keeps observing
    }
  }, { rootMargin: '0px 0px -12% 0px', threshold: 0.06 });

  var vh = window.innerHeight;
  for (var i = 0; i < targets.length; i++) {
    var el = targets[i];
    // anything already on screen at load is shown immediately: a reveal the
    // visitor never saw begin just reads as a page that loaded broken
    if (el.getBoundingClientRect().top < vh * 0.92) {
      el.classList.add('rv-in');
      continue;
    }
    el.classList.add('rv');
    io.observe(el);
  }
})();
