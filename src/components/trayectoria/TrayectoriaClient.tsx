import { useEffect, useMemo, useRef, useState } from 'react';
import type { MotionValue } from 'motion/react';
import { motion, useReducedMotion, useScroll, useTransform } from 'motion/react';
import { trayectoria } from '../../data';

const X1 = 20;
const Y1 = 240;
const X2 = 980;
const Y2 = 240;
const PATH_LENGTH = Math.hypot(X2 - X1, Y2 - Y1);

const MILESTONES = [
  { left: '2%', top: '50%', height: 50 },
  { left: '26%', top: '50%', height: 100 },
  { left: '50%', top: '50%', height: 70 },
  { left: '74%', top: '50%', height: 120 },
  { left: '98%', top: '50%', height: 90 },
];

function VerticalTimeline() {
  return (
    <ol className="relative pl-8 md:pl-12 border-l-2 border-paper/30">
      {trayectoria.map((item) => (
        <li key={item.title} className="relative pb-10 last:pb-0">
          <span
            className="absolute -left-[34px] md:-left-[50px] top-1 w-3 h-3 rounded-full bg-red ring-4 ring-navy-soft"
            aria-hidden="true"
          />
          <span className="font-mono text-sm font-bold text-red">{item.year}</span>
          <h3 className="font-heading text-xl md:text-2xl font-semibold tracking-tight text-white-warm mt-1 mb-2">
            {item.title}
          </h3>
          <p className="text-paper/80 leading-relaxed max-w-3xl">{item.description}</p>
        </li>
      ))}
    </ol>
  );
}

export default function TrayectoriaClient() {
  const containerRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = useReducedMotion();
  const [isMobile, setIsMobile] = useState(false);

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

  if (prefersReducedMotion || isMobile) {
    return <VerticalTimeline />;
  }

  return (
    <div ref={containerRef} className="relative min-h-[220vh]">
      <div className="sticky top-0 h-screen flex flex-col justify-start overflow-hidden bg-navy-soft">
        <div className="max-w-[var(--container-w)] mx-auto px-6 pt-16 md:pt-20">
          <p className="font-mono text-sm uppercase tracking-widest text-red mb-4">Trayectoria</p>
          <h2
            id="trayectoria-heading"
            className="font-heading text-3xl md:text-4xl lg:text-5xl font-bold tracking-tight text-white-warm"
          >
            Iniciativas realizadas y por venir.
          </h2>
        </div>

        <div className="relative w-[86%] max-w-[1120px] mx-auto mt-16 md:mt-24 h-[480px]">
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
  item: { year: number; title: string; description: string };
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
      className="absolute flex flex-col items-center w-[220px] -translate-x-1/2 -translate-y-full"
      style={{ left, top }}
    >
      <div
        className={`text-center mb-0.5 transition-all duration-500 ${isActive ? 'opacity-100 translate-y-0' : 'opacity-30 translate-y-2.5'}`}
      >
        <span
          className={`block font-heading text-4xl font-bold leading-none tracking-tight transition-colors duration-300 ${isActive ? 'text-red' : 'text-paper/40'}`}
        >
          {item.year}
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
