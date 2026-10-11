"use client";

// Adapted from the user's supplied WorksWheel, not a replacement carousel.
// At rest the work sits tangent to a ring. The first notch opens it into a
// vertical 3D drum. One number drives the original transform chain: 0 is the
// ring, 1 presents item 0, and each whole number after that presents the next.
import * as React from "react";
import { cn } from "@/lib/utils";

export interface WorksWheelItem {
  id: string;
  title: string;
  image: string;
  alt: string;
  width: number;
  height: number;
  webp: string;
  avif: string;
}

export interface WorksWheelProps extends Omit<React.ComponentPropsWithoutRef<"div">, "children"> {
  items: WorksWheelItem[];
  label?: string;
  action?: string;
  onActiveIndexChange?: (index: number) => void;
  onModeChange?: (mode: 'ring' | 'drum') => void;
  onControlsHeightChange?: (height: number) => void;
  introSize?: { w: number; h: number };
  showControls?: boolean;
  detailsHeight?: number;
}

/* Original geometry: card-relative sizing keeps the ring and bowed drum
   proportional even when width, rather than height, caps the card. */
const CARD_H = 0.38;
const CARD_MAX_W = 0.34;
const CARD_RATIO = 1.45;
const STEP = 40;
const DRUM = 2.22;
const LENS = 2.7;
const RING_R = 1.14;
// The strip bends around a centre off to the left, not a flat vertical stack.
const BOW = 1.82;
const TITLE = 0.124;
const INDEX = 0.04;
const CULL = 1.6;
const WHEEL_UNITS = 900;
const DRAG_UNITS = 420;
const SETTLE = 140;
const EASE = 0.12;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
type Stage = { w: number; h: number };
const rad = (deg: number) => (deg * Math.PI) / 180;
const bowAt = (drumDeg: number, bow: number) => -bow * (1 - Math.cos(rad(drumDeg)));

/** Preserve the supplied ring -> bowed 3D drum transform order. */
function place(ringDeg: number, drumDeg: number, ringR: number, drumR: number, bow: number, m: number) {
  return (
    `translateX(${m * bowAt(drumDeg, bow)}px)` +
    ` rotateZ(${(1 - m) * ringDeg}deg) translateY(${-(1 - m) * ringR}px)` +
    ` rotateX(${m * drumDeg}deg) translateZ(${m * drumR}px)`
  );
}

export function WorksWheel({ items, label = "Chile DAO", action = "Ver", className,
  onActiveIndexChange, onModeChange, onControlsHeightChange, introSize = { w: 260, h: 380 },
  showControls = true, detailsHeight = 300, ...props }: WorksWheelProps) {
  const id = React.useId();
  const stageId = `${id}-stage`;
  const instructionsId = `${id}-instructions`;
  const stageRef = React.useRef<HTMLDivElement>(null);
  const controlsRef = React.useRef<HTMLDivElement>(null);
  const [controlsHeight, setControlsHeight] = React.useState(showControls ? 96 : 0);
  const wheelRef = React.useRef<HTMLDivElement>(null);
  const cardRefs = React.useRef<(HTMLDivElement | null)[]>([]);
  const labelRef = React.useRef<HTMLDivElement>(null);
  const titleRef = React.useRef<HTMLDivElement>(null);
  const wake = React.useRef<() => void>(() => {});
  const turn = React.useRef(0);
  const target = React.useRef(0);
  const settling = React.useRef(0);
  const drag = React.useRef<{ coordinate: number; moved: number; touch: boolean } | null>(null);
  const suppressClick = React.useRef(false);
  const [active, setActive] = React.useState(0);
  const [stage, setStage] = React.useState<Stage>({ w: 0, h: 0 });
  const [reduced, setReduced] = React.useState(false);
  const count = items.length;
  const last = Math.max(count - 1, 0);
  const previousActive = React.useRef(0);
  const previousMode = React.useRef<'ring' | 'drum'>('ring');

  React.useEffect(() => {
    if (previousActive.current !== active) {
      previousActive.current = active;
      onActiveIndexChange?.(active);
    }
  }, [active, onActiveIndexChange]);

  // Read media only after mount: SSR and initial hydration stay identical.
  React.useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const read = () => setReduced(query.matches);
    read();
    query.addEventListener("change", read);
    return () => query.removeEventListener("change", read);
  }, []);

  React.useEffect(() => {
    const element = controlsRef.current;
    if (!element || !showControls) {
      setControlsHeight(0);
      onControlsHeightChange?.(0);
      return;
    }
    if (typeof ResizeObserver !== 'function') return;
    const read = () => {
      const height = element.offsetHeight;
      setControlsHeight(height);
      onControlsHeightChange?.(height);
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
   }, [onControlsHeightChange, showControls]);

  React.useEffect(() => {
    const el = stageRef.current;
    // Keep stage.w at zero when measurement cannot be maintained. That leaves
    // the original CSS ring and native artwork anchors in control.
    if (!el || typeof ResizeObserver !== 'function') return;
    const read = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const metrics = React.useMemo(() => {
    const { w, h } = stage;
    const cardW = Math.min(h * CARD_H * CARD_RATIO, w * (w < 600 ? .65 : CARD_MAX_W), 360);
    const cardH = cardW / CARD_RATIO;
    const viewerH = w >= 900 ? h * .78 : Math.max(120, h - detailsHeight - 48);
    const viewerW = w >= 900 ? w * .58 : w * .88;
    const frontSizes = items.map(item => {
      const ratio = item.width / item.height;
      const height = Math.min(viewerH, viewerW / ratio);
      return { w: height * ratio, h: height };
    });
    const drumR = (frontSizes[active]?.h ?? cardH) * DRUM;
    const ringFaceW = Math.min(w < 600 ? 74 : 150, Math.max(50, (w - introSize.w) / 4));
    const ringScale = ringFaceW / (cardW || 1);
    const ringX = Math.max(introSize.w / 2 + ringFaceW / 2 + 12, w / 2 - ringFaceW * .55 - 12);
    const ringR = Math.max(cardH * RING_R, introSize.h / 2 + ringFaceW * .6 + 24, h / 2 - ringFaceW * .6 - 12);
    return { cardW, cardH, frontSizes, viewerH, ringR, ringX, ringScale, drumR, bow: cardH * BOW,
      depth: drumR * LENS, title: Math.max(16, cardH * TITLE), index: Math.max(14, cardH * INDEX) };
  }, [stage, items, active, introSize, detailsHeight]);

  // Draw only while moving. Inputs wake the loop; rest schedules no idle RAF.
  React.useEffect(() => {
    if (!stage.h) return;
    let frame = 0;
    const { ringR, ringX, ringScale, drumR, bow } = metrics;
    const draw = () => {
      frame = 0;
      const gap = target.current - turn.current;
      if (reduced || Math.abs(gap) < 0.0005) turn.current = target.current;
      else turn.current += gap * EASE;
      const t = turn.current;
      const m = clamp(t, 0, 1);
      const pos = Math.max(0, t - 1);
      if (wheelRef.current) {
        wheelRef.current.style.transform = `translateZ(${-m * drumR}px)`;
        wheelRef.current.style.top = `${lerp(stage.h / 2, stage.w >= 900 ? stage.h / 2 : metrics.viewerH / 2 + 16, m)}px`;
        wheelRef.current.style.left = `${lerp(50, stage.w >= 900 ? 34 : 50, m)}%`;
      }
      for (let i = 0; i < count; i++) {
        const d = i - pos;
        const card = cardRefs.current[i];
        if (card) {
          const size = metrics.frontSizes[i];
          const width = lerp(metrics.cardW, size.w, m);
          const height = lerp(metrics.cardH, size.h, m);
          card.style.width = `${width}px`;
          card.style.height = `${height}px`;
          card.style.marginLeft = `${-width / 2}px`;
          card.style.marginTop = `${-height / 2}px`;
          const culled = m > 0.5 && Math.abs(d) > CULL;
          const angle = d * (360 / count);
          // A measured superellipse opens room for the intro on narrow screens.
          // The original ring -> bowed drum transform order remains underneath.
          const x = Math.sign(Math.sin(rad(angle))) * Math.abs(Math.sin(rad(angle))) ** .5 * ringX;
          const y = -Math.sign(Math.cos(rad(angle))) * Math.abs(Math.cos(rad(angle))) ** (stage.w < 360 ? .2 : .5) * ringR;
          const correctionX = x - Math.sin(rad(angle)) * ringR;
          const correctionY = y + Math.cos(rad(angle)) * ringR;
          card.style.transform = `translate(${(1 - m) * correctionX}px,${(1 - m) * correctionY}px) `
            + place(angle, d * STEP, ringR, drumR, bow, m);
          card.style.opacity = culled ? "0" : "1";
          card.style.pointerEvents = culled ? "none" : "auto";
          card.style.zIndex = String(Math.round(100 - Math.abs(d) * 2));
          const face = card.firstElementChild as HTMLElement | null;
          if (face) face.style.transform = `scale(${lerp(ringScale, 1, m)})`;
        }
      }
      if (labelRef.current) labelRef.current.style.opacity = String(1 - m);
      if (titleRef.current) titleRef.current.style.opacity = String(m);
      if (stageRef.current) {
        stageRef.current.dataset.turn = String(t);
        stageRef.current.dataset.draws = String(Number(stageRef.current.dataset.draws ?? 0) + 1);
      }
      const mode = target.current === 0 ? 'ring' : 'drum';
      if (previousMode.current !== mode) {
        previousMode.current = mode;
        onModeChange?.(mode);
      }
      const near = clamp(Math.round(pos), 0, last);
      setActive(prev => prev === near ? prev : near);
      if (turn.current !== target.current) frame = requestAnimationFrame(draw);
    };
    wake.current = () => { if (!frame) frame = requestAnimationFrame(draw); };
    wake.current();
    return () => { cancelAnimationFrame(frame); wake.current = () => {}; };
  }, [metrics, stage.h, count, last, reduced, onModeChange]);

  const to = React.useCallback((next: number) => {
    target.current = clamp(next, 0, last + 1);
    wake.current();
  }, [last]);

  React.useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      // Release outward movement at both boundaries to native page scrolling.
      if ((target.current === 0 && event.deltaY <= 0)
        || (target.current === last + 1 && event.deltaY >= 0)) return;
      event.preventDefault();
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1);
      to(target.current + pixels / WHEEL_UNITS);
      window.clearTimeout(settling.current);
      settling.current = window.setTimeout(() => to(Math.round(target.current)), SETTLE);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      window.clearTimeout(settling.current);
      drag.current = null;
    };
  }, [to, last]);

  const select = (next: number) => {
    window.clearTimeout(settling.current);
    to(next);
  };
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    suppressClick.current = (drag.current?.moved ?? 0) > 5;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    to(Math.round(target.current));
  };

  return (
    <div role="group" aria-label="Archivo de actividades de Chile DAO" data-works-wheel
      className={cn("bg-background text-foreground relative w-full overflow-hidden select-none rounded-xl", className)} {...props}>
      <div className="works-viewport relative"
        style={{ height: `calc(var(--hero-height) - ${controlsHeight}px)` }}>
        <div ref={stageRef} id={stageId} data-works-stage data-turn="0" tabIndex={stage.w ? 0 : undefined} role={stage.w ? 'listbox' : 'group'}
          aria-label="Afiches de actividades" aria-describedby={instructionsId}
          aria-activedescendant={stage.w ? `${id}-work-${active}` : undefined}
          className="absolute inset-0 cursor-grab touch-pan-y outline-none focus-visible:outline-2 focus-visible:outline-paper focus-visible:-outline-offset-4 active:cursor-grabbing"
          style={{ perspective: `${metrics.depth}px` }}
          onPointerDown={event => {
            if (event.button !== 0) return;
            window.clearTimeout(settling.current);
            const touch = event.pointerType !== "mouse";
            suppressClick.current = false;
            drag.current = { coordinate: touch ? event.clientX : event.clientY, moved: 0, touch };
          }}
          onPointerMove={event => {
            const current = drag.current;
            if (!current) return;
            const coordinate = current.touch ? event.clientX : event.clientY;
            const distance = current.coordinate - coordinate;
            current.moved += Math.abs(distance);
            if (current.moved > 5 && !event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.setPointerCapture(event.pointerId);
            }
            to(target.current + distance / DRAG_UNITS);
            current.coordinate = coordinate;
          }}
          onPointerUp={endDrag} onPointerCancel={endDrag}
          onKeyDown={event => {
            if (event.key === "ArrowDown") select(Math.round(target.current) + 1);
            else if (event.key === "ArrowUp") select(Math.round(target.current) - 1);
            else if (event.key === "Home") select(0);
            else if (event.key === "End") select(last + 1);
            else return;
            event.preventDefault();
          }}>
          <div ref={wheelRef} className="works-ring absolute top-1/2 left-1/2 [transform-style:preserve-3d]">
            {items.map((item, i) => (
              <div key={item.id} id={`${id}-work-${i}`} role={stage.w ? 'option' : undefined} aria-selected={stage.w ? i === active : undefined}
                aria-label={item.title} data-work-card={i}
                ref={node => { cardRefs.current[i] = node; }}
                onClick={() => { if (!suppressClick.current) select(i + 1); }}
                className="absolute [backface-visibility:hidden]"
                style={{ '--ring-angle': `${i * 360 / count}deg`,
                  '--ring-x-factor': Math.sign(Math.sin(rad(i * 360 / count))) * Math.abs(Math.sin(rad(i * 360 / count))) ** .5,
                  '--ring-y-factor': -Math.sign(Math.cos(rad(i * 360 / count))) * Math.abs(Math.cos(rad(i * 360 / count))) ** .5,
                  '--ring-narrow-y-factor': -Math.sign(Math.cos(rad(i * 360 / count))) * Math.abs(Math.cos(rad(i * 360 / count))) ** .2,
                } as React.CSSProperties}>
                <span data-work-face className="relative block size-full overflow-hidden rounded-lg bg-transparent">
                  <a data-hero-photo href={item.image} draggable={false} aria-label={`${item.title} · Afiche de archivo`}
                    tabIndex={stage.w ? -1 : 0} onClick={event => { if (stage.w) event.preventDefault(); }}
                    className="block size-full">
                  <picture className="block size-full">
                    <source type="image/avif" srcSet={item.avif} sizes="(min-width: 900px) 58vw, 88vw" />
                    <source type="image/webp" srcSet={item.webp} sizes="(min-width: 900px) 58vw, 88vw" />
                    <img src={item.image} alt={item.alt} width={item.width} height={item.height}
                       draggable={false} loading="eager" fetchPriority={i === 0 ? 'high' : 'auto'} decoding="async"
                      className="size-full object-contain" />
                  </picture>
                  </a>
                </span>
              </div>
            ))}
          </div>
        </div>
        {/* The supplied title/index positions remain card-relative. Short visual
            index labels leave room for the ring; full names label each control. */}
        <div ref={labelRef} className="sr-only"
          style={{ fontSize: metrics.title }}>{label}</div>
        <div ref={titleRef} aria-hidden="true"
          className="sr-only"
          style={{ fontSize: metrics.title }}>{items[active]?.title}</div>
      </div>
      <p className="sr-only" id={instructionsId}>{stage.w ? 'Usa ↑ y ↓ o gira con la rueda del ratón. Arrastra verticalmente con ratón u horizontalmente en pantalla táctil. Inicio vuelve al círculo; Fin muestra el último afiche.' : 'Afiches de archivo; no son convocatorias vigentes. Abre cada imagen para consultar el afiche completo.'}</p>
      {showControls && <div ref={controlsRef} className="relative z-10 flex flex-col items-center p-1 text-center text-sm">
        <ol className="text-muted-foreground flex flex-wrap justify-center w-[352px] max-w-full max-[359px]:w-44 text-center leading-[1.75]"
          style={{ fontSize: metrics.index }} aria-label="Elegir actividad">
          {items.map((item, i) => (
            <li key={item.id}>
              <button type="button" data-work-index={i} aria-controls={stageId}
                aria-label={`${action} ${item.title}`} aria-pressed={i === active}
                onClick={() => select(i + 1)} title={item.title}
                className={cn("min-h-11 min-w-11 rounded cursor-pointer outline-none focus-visible:outline-2 focus-visible:outline-paper",
                  i === active && "text-foreground font-bold bg-paper/10")}>{String(i + 1).padStart(2, "0")}</button>
            </li>
          ))}
        </ol>
        <div className="flex flex-wrap justify-center gap-x-2">
          <button type="button" data-works-reset aria-controls={stageId} onClick={() => select(0)}
            className="min-h-11 rounded px-3 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-paper">Volver al círculo</button>
          <a href={items[active]?.image} title="Afiche de archivo; no es una convocatoria vigente." className="inline-flex min-h-11 items-center underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-paper">Ver afiche de archivo</a>
        </div>
      </div>}
    </div>
  );
}

export default WorksWheel;
