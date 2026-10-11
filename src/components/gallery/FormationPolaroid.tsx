import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import PolaroidLineCarousel, { SlideImage, type Slide } from '../ui/polaroid-line-carousel';

export default function FormationPolaroid({ slides }: { slides: Slide[] }) {
  const [initialIndex, setInitialIndex] = useState<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const fallbackRef = useRef<HTMLDivElement>(null);
  const fallbackFocus = useRef<Element | null>(null);
  const id = useId();
  useEffect(() => {
    const root = rootRef.current, viewport = fallbackRef.current;
    if (!root || !viewport || typeof ResizeObserver !== 'function' || typeof IntersectionObserver !== 'function') return;
    // Adopt the actual native viewport, including scrolling without a number link.
    const left = viewport.getBoundingClientRect().left;
    const figures = [...viewport.querySelectorAll('figure')];
    let nearest = 0, distance = Infinity;
    figures.forEach((figure, index) => {
      const next = Math.abs(figure.getBoundingClientRect().left - left);
      if (next < distance) { nearest = index; distance = next; }
    });
    fallbackFocus.current = root.contains(document.activeElement) ? document.activeElement : null;
    setInitialIndex(nearest);
  }, []);
  useLayoutEffect(() => {
    const focused = fallbackFocus.current;
    if (initialIndex === null || !focused) return;
    fallbackFocus.current = null;
    // Do not override focus moved outside during the enhancement commit.
    if (!focused.isConnected && document.activeElement === document.body) {
      rootRef.current?.querySelector<HTMLElement>('.pl-root')?.focus({ preventScroll: true });
    }
  }, [initialIndex]);
  return <div ref={rootRef} data-formation-polaroid role="region" aria-label="Encuentros de formación" aria-roledescription="carrusel">
    <style>{`
        [data-formation-polaroid] { --formation-height:540px; height:var(--formation-height); display:flex; flex-direction:column; }
        [data-polaroid-fallback] { display:flex; flex:1; min-height:0; overflow-x:auto; scroll-snap-type:x mandatory; position:relative; border-radius:12px; background:#efece6; }
        [data-polaroid-fallback] figure { flex:0 0 100%; min-width:0; scroll-snap-align:start; margin:0; padding:12px; display:flex; flex-direction:column; }
        [data-polaroid-fallback] picture { display:block; flex:1; min-height:0; position:relative; }
        [data-polaroid-fallback] img { position:absolute; inset:0; width:100%; height:100%; object-fit:contain; }
        [data-polaroid-fallback] figcaption { padding:12px; color:#161513; font-size:16px; }
        [data-formation-polaroid] .fallback-links { display:flex; flex:none; flex-wrap:wrap; gap:8px; padding:8px; }
        [data-formation-polaroid] .fallback-links a { display:grid; place-items:center; min-width:44px; min-height:44px; border:1px solid #80776b; border-radius:6px; }
    `}</style>
    {initialIndex !== null ? <PolaroidLineCarousel slides={slides} initialIndex={initialIndex} autoplay={0} height="var(--formation-height)" /> : <>
      <div ref={fallbackRef} data-polaroid-fallback tabIndex={0} aria-label="Fotos desplazables de formación">
        {slides.map((slide, index) => <figure key={slide.image} id={`${id}-photo-${index}`}>
          <SlideImage slide={slide} /><figcaption>{slide.caption}</figcaption>
        </figure>)}
      </div>
      <nav className="fallback-links" aria-label="Elegir foto de formación">
        {slides.map((slide, index) => <a key={slide.image} href={`#${id}-photo-${index}`} aria-label={`Ver foto ${index + 1}: ${slide.caption}`}>{index + 1}</a>)}
      </nav>
    </>}
  </div>;
}
