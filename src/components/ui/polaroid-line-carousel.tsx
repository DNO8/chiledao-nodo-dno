"use client";

import * as React from 'react';

// Adapted from the complete user-supplied Polaroid Line Carousel. The supplied
// quadratic string, peg, spring and velocity-driven pendulum model are retained.
export type Slide = {
  image: string;
  title?: string;
  caption?: string;
  alt: string;
  width: number;
  height: number;
  webp: string;
  avif: string;
  sizes: string;
};
export type PolaroidLineCarouselProps = {
  slides: Slide[];
  height?: number | string;
  cardWidth?: number;
  sag?: number;
  swing?: number;
  autoplay?: number;
  string?: string;
  background?: string;
  ink?: string;
  onChange?: (index: number) => void;
  className?: string;
  style?: React.CSSProperties;
  ariaLabel?: string;
};
export function wrap(i: number, n: number): number { return n ? ((i % n) + n) % n : 0; }
export function clamp(v: number, a: number, b: number): number { return Math.min(b, Math.max(a, v)); }
export function stringY(x: number, w: number, y0: number, sag: number): number {
  const t = clamp(x / w, 0, 1);
  return y0 + 4 * sag * t * (1 - t);
}
export function springStep(x: number, v: number, target: number, dt: number, k = 70): [number, number] {
  const c = 2 * Math.sqrt(k);
  const nv = v + (k * (target - x) - c * v) * dt;
  return [x + nv * dt, nv];
}
export function swingStep(a: number, w: number, lineVel: number, dt: number, gain: number): [number, number] {
  const nw = w + (-38 * a - 4.2 * w + lineVel * 0.0034 * gain) * dt;
  return [clamp(a + nw * dt, -0.6, 0.6), nw];
}
export function nearestAt(off: number, spacing: number, n: number): number {
  return clamp(Math.round(off / spacing), 0, Math.max(0, n - 1));
}
export function pad2(n: number): string { return n < 10 ? '0' + n : String(n); }

export function SlideImage({ slide }: { slide: Slide }) {
  return <picture>
    <source type="image/avif" srcSet={slide.avif} sizes={slide.sizes} />
    <source type="image/webp" srcSet={slide.webp} sizes={slide.sizes} />
    <img src={slide.image} srcSet={slide.webp} sizes={slide.sizes} width={slide.width} height={slide.height}
      alt={slide.alt} draggable={false} loading="lazy" decoding="async" />
  </picture>;
}

const PL_CSS = [
  '.pl-root{position:relative;width:100%;overflow:hidden;background:var(--pl-bg);color:var(--pl-ink);user-select:none;-webkit-user-select:none;touch-action:pan-y;outline:none;cursor:grab;border-radius:16px}',
  ".pl-root[data-drag='1']{cursor:grabbing}",
  '.pl-root:focus-visible{box-shadow:inset 0 0 0 2px var(--pl-ink)}',
  '.pl-string{position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;overflow:visible}',
  '.pl-card{position:absolute;left:0;top:0;width:var(--pl-cw);transform-origin:50% 0;will-change:transform;cursor:inherit}',
  '.pl-print{margin-top:10px;background:#fbfaf7;padding:10px 10px 0;box-shadow:0 1px 2px rgba(0,0,0,.12),0 18px 30px -16px rgba(0,0,0,.4);transition:transform .5s cubic-bezier(.2,.7,.2,1),filter .5s ease}',
  ".pl-card[data-on='0'] .pl-print{transform:scale(.9);filter:saturate(.7) brightness(.96)}",
  '.pl-shot{position:relative;aspect-ratio:1;overflow:hidden;background:#d9d5cc}',
  '.pl-shot img{position:absolute;inset:0;width:100%;height:100%;max-width:none;object-fit:contain;display:block;pointer-events:none}',
  ".pl-note{min-height:46px;display:flex;align-items:center;justify-content:center;padding:6px;font:italic 400 15px/1.2 ui-serif,Georgia,'Times New Roman',serif;color:#3b3833}",
  '.pl-peg{position:absolute;left:50%;top:0;width:10px;height:26px;margin-left:-5px;border-radius:2px;background:linear-gradient(90deg,#c9a67a,#e3c9a1 45%,#b8915f);box-shadow:0 2px 3px rgba(0,0,0,.25)}',
  ".pl-peg::after{content:'';position:absolute;left:4px;top:8px;width:2px;height:7px;background:rgba(80,60,30,.45);border-radius:1px}",
  '.pl-bar{position:absolute;left:16px;right:16px;bottom:16px;display:grid;grid-template-columns:1fr auto auto auto;align-items:center;gap:12px;cursor:default}',
  '.pl-cap{grid-column:1/-1;min-width:0;padding-bottom:.15em}',
  '.pl-cap>*{display:block;animation:pl-in .55s cubic-bezier(.2,.8,.2,1) both}',
  '.pl-title{font:500 22px/1.15 ui-serif,Georgia,serif}',
  '.pl-sub{margin-top:4px;font:400 14px/1.4 ui-sans-serif,system-ui,sans-serif;color:var(--pl-muted)}',
  '.pl-count{font:500 14px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.14em;color:var(--pl-muted)}',
  '.pl-count b{color:var(--pl-ink);font-weight:500}',
  '.pl-btn{appearance:none;width:44px;height:44px;border-radius:50%;border:1px solid var(--pl-line);background:transparent;color:inherit;display:grid;place-items:center;cursor:pointer;transition:background .2s ease,color .2s ease}',
  '.pl-btn:hover:not(:disabled){background:var(--pl-ink);color:var(--pl-bg)}',
  '.pl-btn:disabled{opacity:.5;cursor:default}',
  '.pl-btn:focus-visible{outline:2px solid var(--pl-ink);outline-offset:2px}',
  '.pl-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
  '@keyframes pl-in{from{transform:translateY(100%);opacity:0}to{transform:none;opacity:1}}',
  // A nonzero global reduced duration must not animate imperative card poses.
  '@media(prefers-reduced-motion:reduce){.pl-cap>*{animation:none}.pl-print{transition:none}.pl-card{transition:none!important}}',
].join('\n');

export default function PolaroidLineCarousel({
  slides, height = 540, cardWidth = 260, sag = 28, swing = 1, autoplay = 4500,
  string = '#8a7f72', background = '#efece6', ink = '#161513',
  onChange, className, style, ariaLabel = 'Encuentros de formación',
}: PolaroidLineCarouselProps) {
  const n = slides.length;
  const [active, setActive] = React.useState(0), [dragging, setDragging] = React.useState(false);
  const [size, setSize] = React.useState({ w: 520, h: 540, cw: cardWidth });
  const rootRef = React.useRef<HTMLDivElement>(null), pathRef = React.useRef<SVGPathElement>(null);
  const barRef = React.useRef<HTMLDivElement>(null);
  const cards = React.useRef<(HTMLDivElement | null)[]>([]);
  const sim = React.useRef({ off: 0, vel: 0, target: 0, a: [] as number[], w: [] as number[] });
  const drag = React.useRef<null | { pointerId: number; pointerType: string; x: number; y: number; off: number; lx: number; lt: number; v: number; moved: boolean; vertical: boolean }>(null);
  const disposeGesture = React.useRef<() => void>(() => {});
  const lastTouch = React.useRef(0), activeRef = React.useRef(0), opts = React.useRef({ sag, swing });
  const reduced = React.useRef(false), wake = React.useRef<() => void>(() => {});
  const destination = React.useRef(0);
  opts.current = { sag, swing };
  const spacing = size.cw * 1.08;
  const previousSpacing = React.useRef(spacing);
  const goTo = React.useCallback((i: number) => {
    destination.current = clamp(i, 0, n - 1);
    sim.current.target = destination.current * spacing;
    wake.current();
  }, [n, spacing]);
  const release = React.useCallback(() => {
    const d = drag.current;
    // Retire ownership before releasing capture: lostpointercapture may reenter.
    drag.current = null;
    disposeGesture.current(); disposeGesture.current = () => {};
    if (d && rootRef.current?.hasPointerCapture(d.pointerId)) rootRef.current.releasePointerCapture(d.pointerId);
    setDragging(false);
    return d;
  }, []);
  const cancelGesture = React.useCallback(() => {
    const d = release();
    if (!d) return;
    lastTouch.current = performance.now();
    sim.current.vel = 0;
    if (d.moved) goTo(activeRef.current);
  }, [release, goTo]);

  React.useEffect(() => {
    const root = rootRef.current, bar = barRef.current;
    if (!root || !bar) return;
    const read = () => {
      const r = root.getBoundingClientRect();
      const y0 = Math.max(32, r.height * .12);
      const cw = Math.round(Math.max(120, Math.min(cardWidth, r.width * .78,
        r.height - bar.offsetHeight - 32 - y0 - sag - 80)));
      setSize({ w: r.width, h: r.height, cw });
    };
    const ro = new ResizeObserver(read);
    ro.observe(root); ro.observe(bar); read();
    return () => ro.disconnect();
  }, [cardWidth, sag]);
  React.useLayoutEffect(() => {
    // Caption wrapping can change spacing while Home/End is still traversing
    // intermediate slides. Remap the simulation, not its requested destination.
    const ratio = spacing / previousSpacing.current;
    previousSpacing.current = spacing;
    sim.current.target = destination.current * spacing;
    sim.current.off *= ratio;
    sim.current.vel *= ratio;
    if (drag.current) drag.current.off *= ratio;
    // The geometry-dependent controller below restarts with the new spacing;
    // do not wake its previous reduced-motion frame with remapped coordinates.
  }, [spacing]);
  React.useEffect(() => { onChange?.(active); }, [active, onChange]);
  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    let visible = false, raf = 0, timer = 0, prev = performance.now();
    const S = sim.current;
    const canRun = () => visible && !document.hidden;
    const frame = (now: number) => {
      raf = 0;
      if (!canRun()) return;
      const reduce = reduced.current;
      const dt = Math.min(.033, (now - prev) / 1000);
      prev = now;
      const { w, h, cw } = size;
      const y0 = Math.max(32, h * .12), d = drag.current;
      let lineVel = 0;
      if (reduce) {
        if (!d?.moved) S.off = S.target;
        S.vel = 0;
      }
      else if (d?.moved) lineVel = d.v * 1000;
      else {
        const before = S.off;
        [S.off, S.vel] = springStep(S.off, S.vel, S.target, dt);
        lineVel = -(S.off - before) / Math.max(dt, 1e-3);
      }
      const o = opts.current, g = reduce ? 0 : o.swing, near = nearestAt(S.off, spacing, n);
      for (let i = 0; i < n; i++) {
        const el = cards.current[i];
        if (!el) continue;
        const x = w / 2 + i * spacing - S.off;
        const culled = x < -cw * 1.5 || x > w + cw * 1.5;
        if (culled && !reduce) { el.style.visibility = 'hidden'; continue; }
        // Reduced draws also clear retained angles on hidden, culled cards.
        el.style.visibility = culled ? 'hidden' : 'visible';
        let a = S.a[i] || 0, av = S.w[i] || 0;
        if (reduce) { a = 0; av = 0; }
        else {
          [a, av] = swingStep(a, av, lineVel, dt, g);
          if (g) a += Math.sin(now / 1300 + i * 1.7) * .0009 * g;
        }
        S.a[i] = a; S.w[i] = av;
        const y = stringY(x, w, y0, o.sag) - 6;
        el.style.transform = 'translate(' + (x - cw / 2).toFixed(1) + 'px,' + y.toFixed(1) + 'px) rotate(' + a.toFixed(4) + 'rad)';
        el.style.zIndex = String(i === near ? n + 1 : n - Math.abs(i - near));
      }
      pathRef.current?.setAttribute('d', 'M0 ' + y0 + ' Q' + w / 2 + ' ' + (y0 + 2 * o.sag) + ' ' + w + ' ' + y0);
      root.dataset.offset = String(S.off);
      root.dataset.velocity = String(S.vel);
      root.dataset.draws = String(Number(root.dataset.draws ?? 0) + 1);
      root.dataset.reduced = String(reduce);
      if (near !== activeRef.current) { activeRef.current = near; setActive(near); }
      if (!reduce) raf = requestAnimationFrame(frame);
    };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; clearInterval(timer); timer = 0; };
    const start = () => {
      stop(); prev = performance.now();
      if (!canRun()) return;
      if (reduced.current) frame(prev);
      else raf = requestAnimationFrame(frame);
      if (autoplay && n > 1 && !reduced.current) timer = window.setInterval(() => {
        if (!canRun() || drag.current || performance.now() - lastTouch.current < autoplay) return;
        goTo(activeRef.current >= n - 1 ? 0 : activeRef.current + 1);
      }, autoplay);
    };
    wake.current = () => {
      if (!canRun()) return;
      if (reduced.current) frame(performance.now());
      else if (!raf) { prev = performance.now(); raf = requestAnimationFrame(frame); }
    };
    const readMotion = () => {
      if (reduced.current !== query.matches) cancelGesture();
      reduced.current = query.matches; start();
    };
    const readVisibility = () => { if (document.hidden) cancelGesture(); start(); };
    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; start(); });
    query.addEventListener('change', readMotion);
    document.addEventListener('visibilitychange', readVisibility);
    io.observe(root); readMotion();
    return () => {
      stop(); io.disconnect();
      release(); wake.current = () => {};
      query.removeEventListener('change', readMotion);
      document.removeEventListener('visibilitychange', readVisibility);
    };
  }, [size, spacing, n, autoplay, goTo, release, cancelGesture]);
  React.useEffect(() => {
    const root = rootRef.current;
    const focused = document.activeElement;
    if ((active === 0 && focused === root?.querySelector('.pl-prev'))
      || (active === n - 1 && focused === root?.querySelector('.pl-next'))) root?.focus({ preventScroll: true });
  }, [active, n]);

  const onDown = (e: React.PointerEvent) => {
    if (drag.current || e.button !== 0 || (e.target as HTMLElement).closest('.pl-bar')) return;
    lastTouch.current = performance.now();
    drag.current = { pointerId: e.pointerId, pointerType: e.pointerType, x: e.clientX, y: e.clientY, off: sim.current.off, lx: e.clientX,
      lt: e.timeStamp, v: 0, moved: false, vertical: false };
    // Observe retirement outside the root without capturing a click or native pan.
    const up = (event: PointerEvent) => onUp(event);
    const cancel = (event: PointerEvent) => onCancel(event);
    const move = (event: PointerEvent) => {
      const d = drag.current;
      if (d?.pointerId === event.pointerId && d.pointerType === 'mouse' && !(event.buttons & 1)) cancelGesture();
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('pointermove', move);
    window.addEventListener('blur', cancelGesture);
    disposeGesture.current = () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('blur', cancelGesture);
    };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    if (d.pointerType === 'mouse' && !(e.buttons & 1)) { cancelGesture(); return; }
    if (d.vertical) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dy) > 5 && Math.abs(dy) > Math.abs(dx)) { d.vertical = true; return; }
    if (!d.moved && Math.abs(dx) > 5) { d.moved = true; setDragging(true); rootRef.current?.setPointerCapture(e.pointerId); }
    if (!d.moved) return;
    const dt = Math.max(1, e.timeStamp - d.lt);
    d.v = .7 * ((e.clientX - d.lx) / dt) + .3 * d.v;
    d.lx = e.clientX; d.lt = e.timeStamp;
    const max = (n - 1) * spacing;
    let off = d.off - dx;
    if (off < 0) off *= .35;
    if (off > max) off = max + (off - max) * .35;
    sim.current.off = off;
    if (reduced.current) wake.current();
  };
  const onUp = (e: React.PointerEvent | PointerEvent) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    release(); lastTouch.current = performance.now();
    if (d.vertical) return;
    if (d.moved) {
      sim.current.vel = reduced.current ? 0 : -d.v * 1000;
      goTo(nearestAt(sim.current.off - (reduced.current ? 0 : d.v * 180), spacing, n)); return;
    }
    const card = e.target instanceof Element && rootRef.current?.contains(e.target) ? e.target.closest('[data-i]') : null;
    if (card) goTo(Number(card.getAttribute('data-i')));
  };
  const onCancel = (e: React.PointerEvent | PointerEvent) => {
    if (drag.current?.pointerId === e.pointerId) cancelGesture();
  };
  const onLostCapture = (e: React.PointerEvent) => {
    // Implicit descendant touch capture can be lost during transfer to this root.
    if (e.target === e.currentTarget && drag.current?.moved) onCancel(e);
  };
  const step = (dir: number) => { lastTouch.current = performance.now(); goTo(clamp(activeRef.current + dir, 0, n - 1)); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'Home') goTo(0);
    else if (e.key === 'End') goTo(n - 1);
    else return;
    e.preventDefault();
  };
  const s = slides[active];
  return <div ref={rootRef} className={['pl-root', className].filter(Boolean).join(' ')}
    style={{ height, '--pl-bg': background, '--pl-ink': ink, '--pl-muted': '#514b43', '--pl-line': '#80776b', '--pl-cw': size.cw + 'px', ...style } as React.CSSProperties}
    data-drag={dragging ? '1' : '0'} data-active={active} role="region" aria-roledescription="carrusel"
    aria-label={ariaLabel} tabIndex={0} onKeyDown={onKey} onPointerDown={onDown} onPointerMove={onMove}
    onPointerUp={onUp} onPointerCancel={onCancel} onLostPointerCapture={onLostCapture}>
    <style>{PL_CSS}</style>
    <svg className="pl-string" aria-hidden="true"><path ref={pathRef} fill="none" stroke={string} strokeWidth="1.5" strokeLinecap="round" /></svg>
    {slides.map((sl, i) => <div key={sl.image} className="pl-card" data-i={i} data-on={i === active ? '1' : '0'}
      ref={el => { cards.current[i] = el; }} aria-hidden={i === active ? undefined : true}>
      <figure className="pl-print"><div className="pl-shot"><SlideImage slide={sl} /></div><figcaption className="pl-note">{sl.title}</figcaption></figure>
      <div className="pl-peg" />
    </div>)}
    <div ref={barRef} className="pl-bar">
      <div className="pl-cap" key={active} aria-hidden="true"><span className="pl-title">{s?.title}</span><span className="pl-sub">{s?.caption}</span></div>
      <span className="pl-count" aria-hidden="true"><b>{pad2(active + 1)}</b> / {pad2(n)}</span>
      <button type="button" className="pl-btn pl-prev" disabled={active === 0} aria-label="Foto anterior" onClick={() => step(-1)}>←</button>
      <button type="button" className="pl-btn pl-next" disabled={active === n - 1} aria-label="Foto siguiente" onClick={() => step(1)}>→</button>
    </div>
    <div className="pl-sr" aria-live="polite" aria-atomic="true">{`Foto ${active + 1} de ${n}: ${s?.title}. ${s?.caption}`}</div>
  </div>;
}
