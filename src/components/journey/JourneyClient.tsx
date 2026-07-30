import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion, useScroll, useTransform, useMotionValueEvent } from 'motion/react';
import { journey } from '../../data';

const SLIDE_COUNT = journey.length;

function JourneyPicture({ base, alt }: { base: string; alt: string }) {
  return (
    <picture className="contents">
      <source srcSet={`/media/images/journey/${base}.avif`} type="image/avif" />
      <source srcSet={`/media/images/journey/${base}.webp`} type="image/webp" />
      <img
        src={`/media/images/journey/${base}.jpg`}
        alt={alt}
        className="absolute inset-0 h-full w-full object-cover"
        loading="lazy"
        decoding="async"
      />
    </picture>
  );
}

export default function JourneyClient() {
  const containerRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = useReducedMotion();
  const [activeIndex, setActiveIndex] = useState(0);
  const [displayIndex, setDisplayIndex] = useState(0);
  const [isChanging, setIsChanging] = useState(false);

  const { scrollYProgress } = useScroll({
    target: containerRef,
    offset: ['start start', 'end end'],
  });

  const progressWidth = useTransform(scrollYProgress, [0, 1], ['0%', '100%']);
  const dotLeft = useTransform(scrollYProgress, [0, 1], ['0%', '100%']);

  useMotionValueEvent(scrollYProgress, 'change', (latest) => {
    const nextIndex = Math.min(Math.floor(latest * SLIDE_COUNT), SLIDE_COUNT - 1);
    setActiveIndex(nextIndex);
  });

  useEffect(() => {
    if (activeIndex === displayIndex) return;
    setIsChanging(true);
    const timer = window.setTimeout(() => {
      setDisplayIndex(activeIndex);
      setIsChanging(false);
    }, 220);
    return () => window.clearTimeout(timer);
  }, [activeIndex, displayIndex]);

  if (prefersReducedMotion) {
    return (
      <div className="bg-navy">
        <div className="max-w-[var(--container-w)] mx-auto px-6 py-20 md:py-32">
          <p className="font-mono text-sm uppercase tracking-widest text-red mb-4">Recorrido</p>
          <h2 id="recorrido-heading" className="font-heading text-3xl md:text-4xl lg:text-5xl font-bold tracking-tight text-white-warm mb-12 md:mb-16">
            Un territorio · una ruta
          </h2>
          <div className="space-y-16 md:space-y-24">
            {journey.map((slide, index) => (
              <article key={slide.region} className="grid md:grid-cols-2 gap-8 items-center">
                <div className="relative aspect-[16/10] overflow-hidden rounded-lg">
                  <div className="absolute inset-0 bg-navy/40 mix-blend-multiply z-10" />
                  <JourneyPicture base={slide.image} alt={slide.region} />
                </div>
                <div>
                  <span className="font-mono text-red font-bold text-sm">{String(index + 1).padStart(2, '0')}</span>
                  <p className="text-xs uppercase tracking-widest font-bold text-white-warm/80 mt-2 mb-4">
                    {slide.region}
                  </p>
                  <p className="text-sm uppercase tracking-widest font-bold text-red mb-4">{slide.eyebrow}</p>
                  <h3 className="font-heading text-2xl md:text-3xl font-bold text-white-warm mb-4">
                    {slide.heading}
                  </h3>
                  <p className="text-white-warm/75 leading-relaxed">{slide.description}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const current = journey[displayIndex];

  return (
    <div ref={containerRef} className="relative min-h-[350vh]">
      <div className="sticky top-0 h-screen overflow-hidden bg-navy text-white-warm">
        <h2 id="recorrido-heading" className="sr-only">
          Recorrido — Un territorio · una ruta
        </h2>
        <div className="absolute inset-0">
          {journey.map((slide, index) => {
            const isActive = index === activeIndex;
            const isTonedSoft = slide.region === 'Zona Central';
            return (
              <div
                key={slide.region}
                className={`absolute inset-0 transition-opacity duration-700 ${isActive ? 'opacity-100' : 'opacity-0'}`}
                style={{ zIndex: index + 1 }}
              >
                <div
                  className={`absolute inset-0 z-10 ${isTonedSoft ? 'bg-navy/30 mix-blend-multiply' : 'bg-navy/55 mix-blend-multiply'}`}
                />
                <JourneyPicture base={slide.image} alt={slide.region} />
              </div>
            );
          })}
        </div>

        <div
          className="absolute inset-0 z-[10]"
          style={{
            background:
              'linear-gradient(90deg, rgba(1,1,39,0.85) 0%, rgba(1,1,39,0.35) 45%, rgba(1,1,39,0) 70%), linear-gradient(180deg, rgba(1,1,39,0.35) 0%, rgba(1,1,39,0.55) 55%, rgba(1,1,39,0.92) 100%)',
          }}
          aria-hidden="true"
        />

        <div className="relative z-[11] h-full max-w-[var(--container-w)] mx-auto px-6 flex items-center gap-10 pb-24">
          <div
            className={`flex flex-col gap-3 min-w-[110px] transition-all duration-500 ${isChanging ? '-translate-y-3.5 opacity-0' : 'translate-y-0 opacity-100'}`}
          >
            <span className="font-mono text-red font-bold text-sm">
              {String(displayIndex + 1).padStart(2, '0')}
            </span>
            <span className="uppercase tracking-widest font-bold text-sm">{current.region}</span>
          </div>
          <div
            className={`max-w-2xl transition-all duration-500 ${isChanging ? '-translate-y-3.5 opacity-0' : 'translate-y-0 opacity-100'}`}
          >
            <p className="text-sm uppercase tracking-widest font-bold text-red mb-5">{current.eyebrow}</p>
            <h2 className="font-heading text-3xl md:text-5xl lg:text-6xl font-bold tracking-tight text-white-warm mb-6">
              {current.heading}
            </h2>
            <p className="text-lg text-white-warm/75 max-w-lg leading-relaxed">{current.description}</p>
          </div>
        </div>

        <div className="absolute left-0 right-0 bottom-0 z-[12] px-6 md:px-10 py-5 md:py-6 bg-navy/70 backdrop-blur-sm border-t border-white-warm/15">
          <div className="max-w-[var(--container-w)] mx-auto">
            <div className="flex justify-between items-baseline mb-3">
              <span className="font-bold uppercase tracking-widest text-sm">{current.region}</span>
              <span className="text-xs uppercase tracking-widest text-white-warm/50">Un territorio · una ruta</span>
            </div>
            <div className="relative h-0.5 bg-white-warm/20 mb-3">
              <motion.div
                className="absolute left-0 top-0 h-full bg-red"
                style={{ width: progressWidth }}
              />
              <motion.div
                className="absolute top-1/2 w-2.5 h-2.5 rounded-full bg-red border-2 border-white-warm -translate-x-1/2 -translate-y-1/2"
                style={{ left: dotLeft }}
              />
            </div>
            <div className="flex justify-between gap-2">
              {journey.map((slide, index) => (
                <span
                  key={slide.region}
                  className={`text-[0.7rem] uppercase tracking-wider font-semibold transition-colors duration-300 ${index === activeIndex ? 'text-white-warm' : 'text-white-warm/40'}`}
                >
                  {slide.region}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
