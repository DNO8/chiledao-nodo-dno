import { useEffect, useMemo, useRef, useState } from 'react';
import type { MotionValue } from 'motion/react';
import {
  AnimatePresence,
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useTransform,
} from 'motion/react';
import { trayectoria } from '../../data';
import type { OptimizedImage } from '../../lib/optimized-images';

const X1 = 20;
const Y1 = 240;
const X2 = 980;
const Y2 = 240;
const PATH_LENGTH = Math.hypot(X2 - X1, Y2 - Y1);

const MILESTONES = [
  { left: '2%', top: '50%', height: 50 },
  { left: '18%', top: '50%', height: 95 },
  { left: '34%', top: '50%', height: 65 },
  { left: '50%', top: '50%', height: 115 },
  { left: '66%', top: '50%', height: 75 },
  { left: '82%', top: '50%', height: 105 },
  { left: '98%', top: '50%', height: 85 },
];

function TimelinePicture({
  image,
  alt,
  className,
}: {
  image: OptimizedImage;
  alt: string;
  className?: string;
}) {
  return (
    <picture className="contents">
      <source srcSet={image.avif} type="image/avif" />
      <source srcSet={image.webp} type="image/webp" />
      <img
        src={image.jpg}
        alt={alt}
        width={image.width}
        height={image.height}
        loading="lazy"
        decoding="async"
        className={className}
      />
    </picture>
  );
}

function RocketArc() {
  // "To the moon": rocket climbs a brief ~45° arc toward the moon (SMIL, no JS timers).
  return (
    <svg viewBox="0 0 320 200" className="h-3/4 w-full max-w-3xl" aria-hidden="true">
      {/* Stars */}
      <circle cx="30" cy="30" r="1.5" className="fill-paper/40" />
      <circle cx="90" cy="15" r="1" className="fill-paper/30" />
      <circle cx="180" cy="25" r="1.5" className="fill-paper/40" />
      <circle cx="300" cy="90" r="1" className="fill-paper/30" />
      <circle cx="60" cy="110" r="1" className="fill-paper/30" />
      {/* Moon */}
      <circle cx="272" cy="40" r="16" className="fill-paper/80" />
      <circle cx="266" cy="36" r="3" className="fill-navy-soft/40" />
      <circle cx="276" cy="46" r="2" className="fill-navy-soft/40" />
      {/* Arc path the rocket follows (ends pointing ~45° upward toward the moon) */}
      <path id="rocket-arc" d="M 36 176 C 120 168 190 118 248 52" fill="none" stroke="none" />
      <g>
        {/* Rocket drawn pointing along +x; rotate="auto" aligns it to the path tangent */}
        <path d="M -8 -4 L 6 -4 Q 15 0 6 4 L -8 4 Z" className="fill-white-warm" />
        <circle cx="2" cy="0" r="2" className="fill-navy-soft" />
        <path d="M -8 -4 L -13 -8 L -10 -2 Z" className="fill-red" />
        <path d="M -8 4 L -13 8 L -10 2 Z" className="fill-red" />
        <path d="M -9 -2 L -17 0 L -9 2 Z" className="fill-red" opacity="0.9">
          <animate attributeName="opacity" values="0.9;0.35;0.9" dur="0.35s" repeatCount="indefinite" />
        </path>
        <animateMotion dur="2.6s" repeatCount="indefinite" rotate="auto" calcMode="spline" keyPoints="0;1" keyTimes="0;1" keySplines="0.4 0 0.2 1">
          <mpath href="#rocket-arc" />
        </animateMotion>
      </g>
    </svg>
  );
}

function VerticalTimeline({ images }: { images: Record<string, OptimizedImage> }) {
  return (
    <ol className="relative pl-8 md:pl-12 border-l-2 border-paper/30">
      {trayectoria.map((item) => (
        <li key={item.title} className="relative pb-10 last:pb-0">
          <span
            className="absolute -left-[34px] md:-left-[50px] top-1 w-3 h-3 rounded-full bg-red ring-4 ring-navy-soft"
            aria-hidden="true"
          />
          {item.images.length > 0 &&
            (item.images.length === 1 ? (
              <TimelinePicture
                image={images[item.images[0]]}
                alt={`${item.title} — ChileDAO`}
                className="mb-4 aspect-[16/10] w-full rounded-lg object-cover ring-1 ring-paper/20"
              />
            ) : (
              <div
                className={`mb-4 grid gap-2 ${item.images.length >= 3 ? 'grid-cols-3' : 'grid-cols-2'}`}
              >
                {item.images.map((name) => (
                  <TimelinePicture
                    key={name}
                    image={images[name]}
                    alt={`${item.title} — ChileDAO`}
                    className="aspect-[4/3] w-full rounded-lg object-cover ring-1 ring-paper/20"
                  />
                ))}
              </div>
            ))}
          <div className="rounded-lg bg-navy/60 p-4 ring-1 ring-paper/10">
            <span className="font-mono text-sm font-bold text-red">{item.period}</span>
            <h3 className="font-heading text-xl md:text-2xl font-semibold tracking-tight text-white-warm mt-1 mb-2">
              {item.title}
            </h3>
            <p className="text-paper/80 leading-relaxed max-w-3xl">{item.description}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

export default function TrayectoriaClient({ images }: { images: Record<string, OptimizedImage> }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = useReducedMotion();
  const [isMobile, setIsMobile] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const update = () => setIsMobile(window.innerWidth < 768);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start start', 'end end'],
  });

  const dashOffset = useTransform(scrollYProgress, [0, 1], [PATH_LENGTH, 0]);
  const progressPct = useTransform(scrollYProgress, [0, 1], [0, 100]);

  const milestoneThresholds = useMemo(
    () => MILESTONES.map((m) => parseFloat(m.left) - 1),
    [],
  );

  // Active milestone = highest threshold reached; all of its photos render as
  // full-viewport columns behind the timeline (fully driven by progressPct).
  useMotionValueEvent(progressPct, 'change', (latest) => {
    let nextIndex = 0;
    for (let i = 0; i < milestoneThresholds.length; i += 1) {
      if (latest >= milestoneThresholds[i]) nextIndex = i;
    }
    setActiveIndex(nextIndex);
  });

  if (prefersReducedMotion || isMobile) {
    return <VerticalTimeline images={images} />;
  }

  const activeItem = trayectoria[activeIndex];

  return (
    <div ref={containerRef} className="relative min-h-[220vh]">
      <div className="sticky top-0 h-screen flex flex-col justify-start overflow-hidden bg-navy-soft">
        {/* Full-viewport photo columns behind the timeline; masked edges dissolve into the section background. */}
        <div className="absolute inset-0 z-0" aria-hidden="true">
          <AnimatePresence initial={false}>
            <motion.div
              key={activeIndex}
              className="absolute inset-0 flex"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.6, ease: 'easeInOut' }}
              style={{
                maskImage:
                  'linear-gradient(to right, transparent, black 10%, black 90%, transparent), linear-gradient(to bottom, transparent, black 12%, black 88%, transparent)',
                maskComposite: 'intersect',
                WebkitMaskImage:
                  'linear-gradient(to right, transparent, black 10%, black 90%, transparent), linear-gradient(to bottom, transparent, black 12%, black 88%, transparent)',
                WebkitMaskComposite: 'source-in',
              }}
            >
              {activeItem.images.length > 0 ? (
                activeItem.images.map((name) => (
                  <div key={name} className="relative h-full flex-1 overflow-hidden">
                    <TimelinePicture
                      image={images[name]}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  </div>
                ))
              ) : (
                <div className="absolute inset-0 flex items-center justify-center">
                  <RocketArc />
                </div>
              )}
            </motion.div>
          </AnimatePresence>
          <div className="absolute inset-0 bg-navy/55" />
        </div>

        <div className="relative z-10 max-w-[var(--container-w)] mx-auto px-6 pt-16 md:pt-20 w-full">
          <p className="font-mono text-sm uppercase tracking-widest text-red mb-4">Trayectoria</p>
          <h2
            id="trayectoria-heading"
            className="font-heading text-3xl md:text-4xl lg:text-5xl font-bold tracking-tight text-white-warm"
          >
            Iniciativas realizadas y por venir.
          </h2>
        </div>

        <div className="relative z-10 w-[86%] max-w-[1120px] mx-auto mt-16 md:mt-24 h-[480px]">
          <svg
            className="absolute inset-0 w-full h-full"
            viewBox="0 0 1000 480"
            preserveAspectRatio="xMidYMid meet"
            aria-hidden="true"
          >
            <line
              x1={X1}
              y1={Y1}
              x2={X2}
              y2={Y2}
              className="stroke-paper/30"
              strokeWidth={4}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
            <motion.line
              x1={X1}
              y1={Y1}
              x2={X2}
              y2={Y2}
              stroke="#f31e32"
              strokeWidth={4}
              strokeLinecap="round"
              fill="none"
              strokeDasharray={PATH_LENGTH}
              style={{ strokeDashoffset: dashOffset }}
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          {trayectoria.map((item, index) => {
            const threshold = milestoneThresholds[index];
            const pos = MILESTONES[index];
            return (
              <Milestone
                key={item.title}
                item={item}
                left={pos.left}
                top={pos.top}
                height={pos.height}
                progress={progressPct}
                threshold={threshold}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Milestone({
  item,
  left,
  top,
  height,
  progress,
  threshold,
}: {
  item: { period: string; title: string; description: string };
  left: string;
  top: string;
  height: number;
  progress: MotionValue<number>;
  threshold: number;
}) {
  const [isActive, setIsActive] = useState(false);

  useEffect(() => {
    const unsubscribe = progress.on('change', (latest: number) => {
      setIsActive(latest >= threshold);
    });
    return () => unsubscribe();
  }, [progress, threshold]);

  return (
    <div
      className="absolute flex flex-col items-center w-[170px] -translate-x-1/2 -translate-y-full"
      style={{ left, top }}
    >
      <div
        className={`text-center mb-0.5 rounded-lg bg-navy/70 px-3 py-2 ring-1 ring-paper/10 backdrop-blur-sm transition-all duration-500 ${isActive ? 'opacity-100 translate-y-0' : 'opacity-30 translate-y-2.5'}`}
      >
        <span
          className={`block font-heading text-4xl font-bold leading-none tracking-tight transition-colors duration-300 ${isActive ? 'text-red' : 'text-paper/40'}`}
        >
          {item.period}
        </span>
        <h3 className="text-sm font-bold uppercase tracking-wider text-white-warm mt-2.5 leading-tight">
          {item.title}
        </h3>
        <p className="text-xs text-paper/70 mt-2 leading-relaxed">{item.description}</p>
      </div>

      <div
        className={`w-[3px] origin-bottom transition-all duration-500 ${isActive ? 'bg-red scale-y-100' : 'bg-paper/30 scale-y-[0.35]'}`}
        style={{ height }}
      />

      <div
        className={`w-[26px] h-[14px] rounded-[50%] -mt-1.5 shadow-lg transition-all duration-300 ${isActive ? 'bg-red scale-[1.15]' : 'bg-paper/30'}`}
      />
    </div>
  );
}
