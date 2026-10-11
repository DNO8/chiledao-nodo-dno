import * as React from 'react';
import { WorksWheel, type WorksWheelItem } from '@/components/ui/works-wheel';
import type { Work } from '@/data/works';
import { ProductDetails } from './ProductDetails';
import { HeroIntro } from './HeroIntro';
import { useHeroEntrance } from './useHeroEntrance';

export type ShowcaseWork = Work & WorksWheelItem;

export default function WorksWheelShowcase({ items }: { items: ShowcaseWork[] }) {
  const [mounted, setMounted] = React.useState(false);
  const root = React.useRef<HTMLDivElement>(null);
  useHeroEntrance(root, mounted);
  const [active, setActive] = React.useState(0);
  const [mode, setMode] = React.useState<'ring' | 'drum'>('ring');
  const [detailsHeight, setDetailsHeight] = React.useState(300);
  const intro = React.useRef<HTMLDivElement>(null);
  const details = React.useRef<HTMLDivElement>(null);
  const [introSize, setIntroSize] = React.useState({ w: 260, h: 380 });
  React.useEffect(() => setMounted(true), []);
  React.useEffect(() => {
    const element = details.current;
    if (!element || typeof ResizeObserver !== 'function') return;
    const read = () => setDetailsHeight(element.offsetHeight);
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  React.useEffect(() => {
    const element = intro.current;
    if (!element || typeof ResizeObserver !== 'function') return;
    const read = () => setIntroSize({ w: element.offsetWidth, h: element.offsetHeight });
    read();
    const observer = new ResizeObserver(read);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const changeMode = React.useCallback((next: 'ring' | 'drum') => {
    if ((next === 'drum' && intro.current?.contains(document.activeElement))
      || (next === 'ring' && details.current?.contains(document.activeElement))) {
      document.querySelector<HTMLElement>('[data-works-stage]')?.focus({ preventScroll: true });
    }
    setMode(next);
  }, []);
  const first = items[0];
  if (!first) return null;
  return (
    <div ref={root} className="relative min-w-0" data-works-showcase data-mode={mode}>
      <style>{`
        [data-details-overlay].selected-details { position:absolute; z-index:10; right:24px; top:50%; transform:translateY(-50%); width:min(30%,26rem); }
        @media(max-width:899px) { [data-details-overlay].selected-details { right:16px; left:16px; top:auto; bottom:16px; transform:none; width:auto; } }
      `}</style>
      <div ref={intro} data-hero-overlay
        className="pointer-events-none absolute z-10 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(66%,36rem)]"
        style={{ top: '50%' }}>
        <HeroIntro inactive={mode !== 'ring'} />
      </div>
      <WorksWheel items={items} label="Chile DAO" action="Ver" introSize={introSize} showControls={false} detailsHeight={detailsHeight}
        onModeChange={changeMode} onActiveIndexChange={setActive} />
      <div ref={details} data-details-overlay inert={mode === 'ring'}
        className="selected-details"
        style={{ visibility: mode === 'ring' ? 'hidden' : 'visible' }}>
        <ProductDetails work={items[active]} />
      </div>
    </div>
  );
}
