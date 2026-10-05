/* =============================================================================
   motion.js — every animation in the portal lives here.
   -----------------------------------------------------------------------------
   Principles:
   * rAF-throttled pointer maths so tilt/magnetic never block the main thread.
   * Everything is a no-op when the user prefers reduced motion.
   * Observers are pooled per-element (WeakMap) and disconnect when nodes leave.
   ========================================================================== */

const reduced = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Cheap RAF gate: coalesce many calls into one frame. */
export function rafThrottle(fn) {
  let queued = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...lastArgs);
    });
  };
}

/* ------------------------------------------------------- scroll progress -- */
export function scrollProgress(target = document.documentElement) {
  let ticking = false;
  const update = () => {
    const max = target.scrollHeight - target.clientHeight;
    const ratio = max > 0 ? Math.min(Math.max(target.scrollTop / max, 0), 1) : 0;
    target.style.setProperty('--read-progress', ratio.toFixed(4));
    ticking = false;
  };
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(update);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  update();
  return () => {
    window.removeEventListener('scroll', onScroll);
    window.removeEventListener('resize', onScroll);
  };
}

/* ---------------------------------------------------------- reveal on IO -- */

/** Adds [data-reveal] elements to the pool; stagger is computed per batch. */
export function observeReveals(root = document) {
  const nodes = Array.from(root.querySelectorAll('[data-reveal]:not([data-reveal-bound])'));
  if (!nodes.length) return;

  if (reduced()) {
    nodes.forEach((n) => n.classList.add('is-revealed'));
    return;
  }

  // Stagger siblings that appear in the same parent, capped so a 20-item grid
  // does not take 1.6s to finish.
  const perParent = new Map();
  for (const node of nodes) {
    node.dataset.revealBound = '1';
    const parent = node.parentElement;
    const index = perParent.get(parent) ?? 0;
    perParent.set(parent, index + 1);
    node.style.setProperty('--reveal-delay', `${Math.min(index, 8) * 68}ms`);
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('is-revealed');
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });

  nodes.forEach((n) => observer.observe(n));
}

/** Stagger children of a freshly rendered container. */
export function stagger(container, { step = 55, max = 12 } = {}) {
  if (!container || reduced()) return;
  const items = Array.from(container.children);
  items.slice(0, max).forEach((item, i) => {
    item.style.animationDelay = `${i * step}ms`;
  });
}

/* --------------------------------------------------------------- count-up -- */

const easeOutExpo = (t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t));

/**
 * Animates a numeric string ("9.50", "90.2%") into an element.
 * Non-numeric content is left untouched so the call is always safe.
 */
export function countUp(node, { duration = 1150, decimals = null, suffix = '' } = {}) {
  if (!node) return;
  const raw = node.dataset.count ?? node.textContent;
  const target = Number.parseFloat(String(raw).replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(target)) return;
  if (reduced()) { node.textContent = String(raw); return; }

  const digits = decimals ?? (String(raw).includes('.')
    ? String(raw).split('.')[1].replace(/[^0-9]/g, '').length
    : 0);

  const start = performance.now();
  const step = (now) => {
    const t = Math.min((now - start) / duration, 1);
    const value = target * easeOutExpo(t);
    node.textContent = `${value.toFixed(digits)}${suffix}`;
    if (t < 1) requestAnimationFrame(step);
    else node.textContent = String(raw);
  };
  requestAnimationFrame(step);
}

export function countUpAll(root = document, options = {}) {
  if (reduced()) return;
  const nodes = Array.from(root.querySelectorAll('[data-count]'));
  if (!nodes.length) return;

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      countUp(entry.target, options);
      observer.unobserve(entry.target);
    }
  }, { threshold: 0.35 });

  nodes.forEach((n) => observer.observe(n));
}

/* ------------------------------------------------------------------ bars -- */

/** Resets and animates every [data-bar] scale value inside root. */
export function animateBars(root = document) {
  const nodes = Array.from(root.querySelectorAll('[data-bar]'));
  if (!nodes.length) return;
  if (reduced()) {
    nodes.forEach((n) => n.style.setProperty('--value', n.dataset.bar));
    return;
  }
  nodes.forEach((n) => n.style.setProperty('--value', '0'));
  // One frame later so the browser paints the 0 state before transitioning.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    nodes.forEach((n, i) => {
      n.style.transitionDelay = `${Math.min(i, 14) * 42}ms`;
      n.style.setProperty('--value', n.dataset.bar);
    });
  }));
}

/* ------------------------------------------------------------ 3D tilt ---- */

const tiltState = new WeakMap();

/**
 * Subtle perspective tilt that follows the pointer. Bounded to `max` degrees
 * so text never distorts, and disabled on touch/coarse pointers.
 */
export function tilt(node, { max = 5, scale = 1.012, glare = true } = {}) {
  if (!node || reduced()) return;
  if (window.matchMedia('(pointer: coarse)').matches) return;
  if (tiltState.has(node)) return;

  const shine = glare
    ? Object.assign(document.createElement('span'), {
      className: 'tilt-shine',
      style: 'position:absolute;inset:0;border-radius:inherit;pointer-events:none;'
        + 'opacity:0;transition:opacity .4s ease;'
        + 'background:radial-gradient(240px circle at var(--mx,50%) var(--my,50%),'
        + 'color-mix(in srgb, var(--accent) 16%, transparent), transparent 62%)',
    })
    : null;

  if (shine) {
    if (getComputedStyle(node).position === 'static') node.style.position = 'relative';
    node.append(shine);
  }

  const move = rafThrottle((event) => {
    const rect = node.getBoundingClientRect();
    const px = (event.clientX - rect.left) / rect.width;
    const py = (event.clientY - rect.top) / rect.height;
    const ry = (px - 0.5) * max * 2;
    const rx = (0.5 - py) * max * 2;
    node.style.transition = 'transform .18s cubic-bezier(.22,1,.36,1), box-shadow .3s ease';
    node.style.transform =
      `perspective(900px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) scale(${scale})`;
    if (shine) {
      shine.style.opacity = '1';
      shine.style.setProperty('--mx', `${(px * 100).toFixed(1)}%`);
      shine.style.setProperty('--my', `${(py * 100).toFixed(1)}%`);
    }
  });

  const leave = () => {
    node.style.transition = 'transform .5s cubic-bezier(.22,1,.36,1)';
    node.style.transform = '';
    if (shine) shine.style.opacity = '0';
  };

  node.classList.add('tilt-host');
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerleave', leave);
  tiltState.set(node, () => {
    node.removeEventListener('pointermove', move);
    node.removeEventListener('pointerleave', leave);
  });
}

export function tiltAll(root = document, selector = '[data-tilt]', options) {
  root.querySelectorAll(selector).forEach((n) => tilt(n, options));
}

/* ------------------------------------------------------------ magnetic --- */

/** Button that leans toward the cursor. Ignored for coarse pointers. */
export function magnetic(node, { strength = 0.28 } = {}) {
  if (!node || reduced()) return;
  if (window.matchMedia('(pointer: coarse)').matches) return;

  const move = rafThrottle((event) => {
    const rect = node.getBoundingClientRect();
    const dx = (event.clientX - (rect.left + rect.width / 2)) * strength;
    const dy = (event.clientY - (rect.top + rect.height / 2)) * strength;
    node.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
  });

  const leave = () => {
    node.style.transition = 'transform .45s cubic-bezier(.34,1.56,.64,1)';
    node.style.transform = '';
    setTimeout(() => { node.style.transition = ''; }, 460);
  };

  node.addEventListener('pointermove', move);
  node.addEventListener('pointerleave', leave);
}

export function magneticAll(root = document, selector = '[data-magnetic]') {
  root.querySelectorAll(selector).forEach((n) => magnetic(n));
}

/* --------------------------------------------------------------- ripple -- */

export function rippleAll(root = document, selector = '[data-ripple], .btn') {
  if (reduced()) return;
  root.querySelectorAll(selector).forEach((node) => {
    if (node.dataset.rippleBound) return;
    node.dataset.rippleBound = '1';
    if (getComputedStyle(node).position === 'static') node.style.position = 'relative';
    node.style.overflow = 'hidden';

    node.addEventListener('pointerdown', (event) => {
      const rect = node.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height);
      const ink = document.createElement('span');
      ink.className = 'ripple-ink';
      ink.style.width = ink.style.height = `${size}px`;
      ink.style.left = `${event.clientX - rect.left - size / 2}px`;
      ink.style.top = `${event.clientY - rect.top - size / 2}px`;
      node.append(ink);
      setTimeout(() => ink.remove(), 700);
    });
  });
}

/* ------------------------------------------------------- smooth scroll --- */

/** Animated scroll to an element honouring reduced-motion and sticky header. */
export function scrollTo(target, { offset = 0, behavior } = {}) {
  const node = typeof target === 'string' ? document.querySelector(target) : target;
  if (!node) return;
  const top = node.getBoundingClientRect().top + window.scrollY - offset;
  window.scrollTo({
    top: Math.max(top, 0),
    behavior: behavior ?? (reduced() ? 'auto' : 'smooth'),
  });
}

/** Scroll progress 0..1 of an element through the viewport. */
export function inView(node, threshold = 0.2) {
  const rect = node.getBoundingClientRect();
  const visible = rect.top < window.innerHeight * (1 - threshold)
    && rect.bottom > window.innerHeight * threshold;
  return visible;
}

/* ------------------------------------------------------------- init all -- */

export function initMotion(root = document) {
  observeReveals(root);
  countUpAll(root);
  animateBars(root);
  tiltAll(root);
  magneticAll(root);
  rippleAll(root);
  scrollProgress();
}

/** Run the animation hooks after any innerHTML swap. */
export function refresh(root = document) {
  requestAnimationFrame(() => {
    observeReveals(root);
    countUpAll(root);
    animateBars(root);
    tiltAll(root);
    magneticAll(root);
  });
}