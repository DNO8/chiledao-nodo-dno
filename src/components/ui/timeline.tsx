// Built using Hyperiux Vault: https://vault.hyperiux.com
// Desktop retains the user-supplied sticky horizontal canvas; mobile/tablet
// uses native vertical chronology with the same line-arrival point glow.
"use client";

import { useEffect, useRef, useState } from 'react';
import ImageLightbox, { type LightboxImage } from './image-lightbox';

export type TimelineMedia = {
  image: string;
  webp: string;
  avif: string;
  width: number;
  height: number;
  alt: string;
  caption: string;
  kind: 'photo' | 'poster' | 'logo';
  fullSrc: string;
  fullWidth: number;
  fullHeight: number;
};
export type TimelineItem = {
  id: string;
  period: string;
  title: string;
  content: string;
  future: boolean;
  media: TimelineMedia | null;
};

function Media({ media }: { media: TimelineMedia }) {
  return <picture>
    <source type="image/avif" srcSet={media.avif} sizes="(min-width: 1024px) 25vw, calc(100vw - 80px)" />
    <source type="image/webp" srcSet={media.webp} sizes="(min-width: 1024px) 25vw, calc(100vw - 80px)" />
    <img src={media.image} width={media.width} height={media.height} alt={media.alt}
      loading="eager" decoding="async" draggable={false} data-media-kind={media.kind} />
  </picture>;
}

export default function Timeline({ items }: { items: TimelineItem[] }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<{ image: LightboxImage; invoker: HTMLElement } | null>(null);
  const alignFocused = useRef<(element: HTMLElement) => void>(() => {});

  const openImage = (item: TimelineItem, invoker: HTMLElement) => {
    if (!item.media) return;
    const context = item.media.kind === 'poster' ? 'Afiche de archivo; no es una convocatoria vigente.'
      : item.media.kind === 'logo' ? 'Identidad del encuentro; no es una fotografía.' : 'Fotografía de archivo.';
    setViewer({ image: { ...item.media, caption: `${item.title} · ${item.period}. ${item.media.caption} ${context}` }, invoker });
  };

  useEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    const track = trackRef.current;
    if (!root || !canvas || !track) return;
    let disposed = false;
    let cleanup = () => {};
    // Browser-only imports keep plugins out of Astro SSR and preserve static
    // chronology if loading, initialization or the media query fails.
    void Promise.all([import('gsap'), import('gsap/ScrollTrigger'), import('gsap/SplitText')])
      .then(([core, triggerModule, splitModule]) => {
        if (disposed) return;
        const gsap = core.gsap;
        const { ScrollTrigger } = triggerModule;
        const { SplitText } = splitModule;
        gsap.registerPlugin(ScrollTrigger, SplitText);
        // ScrollTrigger caches viewport smoothness, then writes auto/smooth
        // during refresh without preserving inline presence or priority.
        // Own only those temporary writes, including the queued smooth RAF.
        const captureScrollDeclarations = () => [document.documentElement, document.body].map(element => ({
          element, value: element.style.getPropertyValue('scroll-behavior'),
          priority: element.style.getPropertyPriority('scroll-behavior'),
        }));
        let scrollDeclarations: ReturnType<typeof captureScrollDeclarations> | null = null;
        let restoreFrame = 0;
        let retired = false;
        const restoreScrollDeclarations = (declarations: ReturnType<typeof captureScrollDeclarations>) => {
          declarations.forEach(({ element, value, priority }) => {
            if (value) element.style.setProperty('scroll-behavior', value, priority);
            else element.style.removeProperty('scroll-behavior');
          });
        };
        const beforeRefresh = () => {
          // A refresh can start between GSAP's smooth RAF and our restoration.
          // Keep the authored baseline until the finite refresh burst settles.
          if (!retired && !disposed) scrollDeclarations ??= captureScrollDeclarations();
        };
        const afterRefresh = () => {
          const declarations = scrollDeclarations;
          if (retired || disposed || !declarations) return;
          restoreScrollDeclarations(declarations);
          cancelAnimationFrame(restoreFrame);
          const frame = requestAnimationFrame(() => {
            if (retired || disposed || restoreFrame !== frame) return;
            restoreFrame = 0;
            restoreScrollDeclarations(declarations);
            scrollDeclarations = null;
          });
          restoreFrame = frame;
        };
        ScrollTrigger.addEventListener('refreshInit', beforeRefresh);
        ScrollTrigger.addEventListener('refresh', afterRefresh);
        const mm = gsap.matchMedia();
        cleanup = () => {
          retired = true;
          ScrollTrigger.removeEventListener('refreshInit', beforeRefresh);
          ScrollTrigger.removeEventListener('refresh', afterRefresh);
          cancelAnimationFrame(restoreFrame);
          restoreFrame = 0;
          mm.revert();
          if (scrollDeclarations) restoreScrollDeclarations(scrollDeclarations);
          scrollDeclarations = null;
        };
        mm.add({ desktop: '(min-width: 1024px)', mobile: '(max-width: 1023px)',
          tall: '(min-height: 800px)', reduce: '(prefers-reduced-motion: reduce)' }, context => {
          if (context.conditions?.reduce || (context.conditions?.desktop && !context.conditions?.tall) || disposed) return;
          const splits: ReturnType<typeof SplitText.create>[] = [];
          let active = true;
          const desktop = !!context.conditions?.desktop;
          const axis = desktop ? 'scaleX' : 'scaleY';
          root.dataset.enhanced = 'true';
          root.dataset.mode = desktop ? 'horizontal' : 'vertical';
          const distance = () => Math.max(0, track.scrollWidth - canvas.clientWidth);
          const header = () => document.querySelector('header')?.getBoundingClientRect().height ?? 65;
          const range = () => Math.max(1, root.offsetHeight - canvas.offsetHeight);
          const start = () => `top top+=${header()}`;
          const end = () => `+=${range()}`;
          const line = root.querySelector<HTMLElement>('[data-journey-line]');
          const entries = [...root.querySelectorAll<HTMLElement>('[data-milestone]')];
          const points = entries.flatMap(entry => {
            const dot = entry.querySelector<HTMLElement>('[data-dot]');
            return dot ? [{ entry, dot, threshold: Infinity }] : [];
          });
          const syncPoints = () => {
            if (!active || !line) return;
            // Read the rendered line, not a separate visibility trigger or
            // rounded diagnostic progress. Dot transforms stay CSS-owned.
            const progress = Number(gsap.getProperty(line, axis));
            points.forEach(({ dot, threshold }) => {
              const reached = Number.isFinite(progress) && progress >= threshold;
              if (reached) {
                if (!dot.hasAttribute('data-reached')) dot.dataset.reached = 'true';
              } else dot.removeAttribute('data-reached');
            });
          };
          const measurePoints = () => {
            // These offsets share the untransformed track coordinate system.
            // Reject unknown offset parents or hidden/zero-size geometry.
            points.forEach(point => {
              const { entry, dot } = point;
              const length = line ? (desktop ? line.offsetWidth : line.offsetHeight) : 0;
              const center = desktop ? entry.offsetLeft + dot.offsetLeft + dot.offsetWidth / 2
                : entry.offsetTop + dot.offsetTop + dot.offsetHeight / 2;
              point.threshold = line && line.offsetParent === track && entry.offsetParent === track
                && dot.offsetParent === entry && length > 0 && dot.offsetWidth > 0
                ? (center - (desktop ? line.offsetLeft : line.offsetTop)) / length
                : Infinity;
            });
            syncPoints();
          };
          const progression = gsap.timeline({ defaults: { ease: 'none' },
            onUpdate: syncPoints,
            scrollTrigger: { id: 'chile-dao-timeline', trigger: desktop ? root : track,
              start: desktop ? start : 'top center',
              end: desktop ? end : () => `+=${line?.offsetHeight ?? track.offsetHeight}`, scrub: true,
              invalidateOnRefresh: true,
              onUpdate: self => { root.dataset.progress = self.progress.toFixed(4); } } });
          if (desktop) progression.fromTo(track, { x: 0 }, { x: () => -distance(), duration: 1 });
          alignFocused.current = desktop ? element => {
            if (root.querySelector('dialog[open]')) return;
            const entry = element.closest<HTMLElement>('[data-milestone]');
            if (!entry) return;
            // Align the focused column through the same vertical progress model.
            const offset = Math.min(distance(), Math.max(0, entry.offsetLeft - 32));
            const progress = offset / (distance() || 1);
            window.scrollTo({ top: scrollY + root.getBoundingClientRect().top - header() + range() * progress, behavior: 'instant' });
            progression.scrollTrigger?.update();
          } : () => {};
          root.dataset.progress = String(progression.scrollTrigger?.progress ?? 0);
          progression.fromTo(line, { [axis]: 0 }, { [axis]: 1, duration: 1 }, 0);
          measurePoints();
          ScrollTrigger.addEventListener('refresh', measurePoints);
          if (desktop) entries.forEach(entry => {
            // A milestone reveals before its column reaches the canvas centre.
            const initial = entry.offsetLeft + entry.clientWidth <= canvas.clientWidth;
            const revealEnd = () => Math.min(1, Math.max(0,
              (entry.offsetLeft + entry.clientWidth - canvas.clientWidth) / (distance() || 1)));
            const ownedTrigger = () => ({ trigger: root,
              start: () => `top+=${range() * Math.max(0, revealEnd() - .14)} top+=${header()}`,
              end: () => `top+=${range() * Math.max(.01, revealEnd())} top+=${header()}`,
              scrub: true, invalidateOnRefresh: true });
            gsap.fromTo(entry.querySelector('[data-stem]'), { scaleY: initial ? 1 : 0 },
              { scaleY: 1, ease: 'none', scrollTrigger: ownedTrigger() });
            for (const element of entry.querySelectorAll<HTMLElement>('[data-reveal]')) {
              const split = SplitText.create(element, { type: 'lines', mask: 'lines', linesClass: 'timeline-split-line',
                aria: 'auto', autoSplit: true,
                onSplit: self => gsap.fromTo(self.lines, { yPercent: initial ? 0 : 110 },
                  { yPercent: 0, ease: 'power2.out', stagger: .02, scrollTrigger: ownedTrigger() }) });
              splits.push(split);
            }
          });
          root.dataset.ownedTriggers = String(desktop ? 1 + entries.length * 3 : 1);
          // Refresh only after actual layout inputs, never via an idle RAF loop.
          let frame = 0;
          const refresh = () => {
            if (active && !frame) frame = requestAnimationFrame(() => {
              frame = 0;
              if (active && !disposed) {
                ScrollTrigger.refresh();
                if (root.dataset.enhanced) root.dataset.ownedTriggers = String(ScrollTrigger.getAll()
                  .filter(trigger => trigger.trigger === root || trigger.trigger === track).length);
              }
            });
          };
          const observer = new ResizeObserver(refresh);
          observer.observe(canvas);
          observer.observe(track);
          const images = [...root.querySelectorAll('img')];
          images.forEach(image => image.addEventListener('load', refresh));
          void document.fonts.ready.then(() => { if (active && !disposed) refresh(); });
          refresh();
          return () => {
            active = false;
            ScrollTrigger.removeEventListener('refresh', measurePoints);
            points.forEach(({ dot }) => dot.removeAttribute('data-reached'));
            alignFocused.current = () => {};
            observer.disconnect();
            images.forEach(image => image.removeEventListener('load', refresh));
            cancelAnimationFrame(frame);
            splits.forEach(split => split.revert());
            // Breakpoint re-entry can snapshot a previous measured translate.
            // The static DOM owns no inline transforms: restore that boundary.
            for (const element of [track, line, ...root.querySelectorAll<HTMLElement>('[data-stem], [data-dot]')]) {
              element?.style.removeProperty('transform');
              element?.style.removeProperty('transform-origin');
              element?.style.removeProperty('translate');
              element?.style.removeProperty('rotate');
              element?.style.removeProperty('scale');
            }
            delete root.dataset.enhanced;
            delete root.dataset.mode;
            delete root.dataset.progress;
            delete root.dataset.ownedTriggers;
          };
        }, root);
      }).catch(() => {
        cleanup();
        delete root.dataset.enhanced;
      });
    return () => { disposed = true; cleanup(); };
  }, [items]);

  return <div ref={rootRef} data-timeline className="chile-timeline">
    <style>{styles}</style>
    <div ref={canvasRef} data-timeline-canvas className="timeline-canvas">
      <div className="timeline-heading">
        <div><h2 id="trayectoria-heading">Nuestra trayectoria</h2><p>Aprendizaje y comunidad · 2025–2026 y próximos capítulos</p></div>
      </div>
      <div ref={trackRef} data-timeline-track className="timeline-track">
        <ol aria-label="Hitos de Chile DAO" className="timeline-milestones">
          {items.map((item, index) => <li key={item.id} data-milestone={item.id}
            className={index % 2 === 0 ? 'milestone above' : 'milestone below'}>
            <span data-stem className="milestone-stem" aria-hidden="true" />
            <span data-dot className="milestone-dot" aria-hidden="true" />
            <div className="milestone-content">
              <p data-timeline-period className="milestone-period">{item.period}</p>
              <h3 data-reveal>{item.title}</h3>
              <p data-reveal>{item.content}</p>
              {item.media && <><a href={item.media.fullSrc} data-timeline-image={item.id}
                aria-label={`Ampliar imagen: ${item.media.alt}`}
                onFocus={event => alignFocused.current(event.currentTarget)}
                onClick={event => { event.preventDefault(); openImage(item, event.currentTarget); }}
                onKeyDown={event => {
                  if (event.key === ' ') { event.preventDefault(); openImage(item, event.currentTarget); }
                }}><Media media={item.media} /></a>
                {item.media.kind !== 'photo' && <p className="media-label">{item.media.kind === 'poster' ? 'Afiche de archivo; no es una convocatoria vigente.' : 'Identidad del encuentro; no es una fotografía.'}</p>}
              </>}
              {item.future && <span className="future-mark" aria-hidden="true">↗</span>}
            </div>
          </li>)}
        </ol>
        <span data-journey-line className="journey-line" aria-hidden="true" />
      </div>
    </div>
    <ImageLightbox image={viewer?.image ?? null} invoker={viewer?.invoker ?? null} onClose={() => setViewer(null)} />
  </div>;
}

const styles = `
.chile-timeline { --timeline-header: 65px; color: #f8f6ee; background: var(--color-navy, #0e1320); }
.timeline-canvas { padding: 24px; }
.timeline-heading { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
.timeline-heading h2 { font-size: clamp(24px,3vw,40px); font-weight: 700; line-height: 1.15; }
.timeline-heading p { margin-top: 8px; font-size: 14px; }
.timeline-milestones { display: grid; gap: 24px; list-style: none; margin: 0; padding: 0; }
.milestone-content { display: flex; flex-direction: column; gap: 8px; }
.milestone h3 { font-size: 22px; line-height: 1.15; font-weight: 700; }
.milestone p { font-size: 16px; line-height: 1.35; }
.milestone .milestone-period { font-size: 14px; color: #f8f6eebb; }
.milestone picture { display: block; height: 180px; background: #192031; border-radius: 8px; overflow: hidden; }
.milestone img { display: block; height: 100%; width: 100%; object-fit: contain; }
.milestone .media-label { font-size: 12px; }
[data-timeline-image] { display:block; border-radius:8px; }
[data-timeline-image]:focus-visible { outline:2px solid #f8f6ee; outline-offset:3px; }
.milestone-stem, .milestone-dot, .journey-line { display: none; }
.future-mark { font-size: 72px; color: #f31e32; }
[data-enhanced] .milestone-dot[data-reached] { transform: scale(1.75); transform-origin: center; box-shadow: 0 0 6px 2px #c8172a99, 0 0 16px 4px #f31e3240; }
@media (min-width: 1024px) {
.chile-timeline[data-enhanced] { height: max(200vw, 2400px); }
[data-enhanced] .timeline-canvas { position: sticky; top: var(--timeline-header); height: calc(100svh - var(--timeline-header)); min-height: 720px; overflow: hidden; padding: 24px 0; }
[data-enhanced] .timeline-heading { padding: 0 24px; }
[data-enhanced] .timeline-track { position: relative; height: calc(100% - 100px); width: max-content; padding: 0 32px; }
[data-enhanced] .timeline-milestones { height: 100%; grid-template-columns: repeat(7, clamp(260px,27vw,390px)); gap: 48px; }
[data-enhanced] .milestone { position: relative; display: grid; grid-template-rows: 1fr 1fr; }
[data-enhanced] .milestone-content { padding: 0 16px 16px; }
[data-enhanced] .above .milestone-content { grid-row: 1; align-self: end; }
[data-enhanced] .below .milestone-content { grid-row: 2; padding-top: 24px; align-self: start; }
[data-enhanced] .milestone picture { height: clamp(90px,12vh,140px); }
[data-enhanced] .milestone-stem { display: block; position: absolute; left: 0; width: 1px; height: 44%; background: #c8172a; }
[data-enhanced] .above .milestone-stem { bottom: 50%; transform-origin: bottom; }
[data-enhanced] .below .milestone-stem { top: 50%; transform-origin: top; }
[data-enhanced] .milestone-dot { display: block; position: absolute; left: -5px; top: calc(50% - 5px); width: 10px; height: 10px; border-radius: 50%; background: #c8172a; }
[data-enhanced] .journey-line { display: block; position: absolute; left: 32px; right: 32px; top: 50%; height: 1px; background: #c8172a; transform-origin: left; }
.chile-timeline:not([data-enhanced]) .timeline-milestones { grid-template-columns: repeat(2,minmax(0,1fr)); }
}
@media (min-width: 768px) { .chile-timeline { --timeline-header: 81px; } }
@media (max-width: 1023px) {
  .timeline-canvas { padding: 24px; }
  .timeline-track { position: relative; margin-left: 8px; }
  .timeline-milestones { grid-template-columns: minmax(0,1fr); gap: 40px; }
  .milestone { position: relative; min-width: 0; padding-left: 24px; }
  .milestone-content { overflow-wrap: anywhere; }
  .milestone picture { height: clamp(180px,40vw,300px); }
  /* Decoration does not depend on JavaScript or motion eligibility. The base
     rail remains visible while the separate progress line has scaleY zero. */
  .timeline-track::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 1px; background: #c8172a; pointer-events: none; }
  .milestone-dot { display: block; position: absolute; left: -4.5px; top: 10px; width: 10px; height: 10px; border-radius: 50%; background: #c8172a; }
  .journey-line { display: block; position: absolute; left: 0; top: 0; bottom: 0; width: 1px; background: #f31e32; transform-origin: top; pointer-events: none; }
}
@media (prefers-reduced-motion: reduce) {
  .chile-timeline[data-enhanced] { height: auto; }
}
`;
