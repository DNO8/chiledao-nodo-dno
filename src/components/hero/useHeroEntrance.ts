import * as React from 'react';

/** Own only the intro split; photo readiness belongs to the early inline script. */
export function useHeroEntrance(root: React.RefObject<HTMLDivElement | null>, mounted: boolean) {
  React.useEffect(() => {
    const owner = root.current;
    if (!mounted || !owner) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let disposed = false;
    let finished = false;
    let frame = 0;
    let context: gsap.Context | undefined;
    let split: { revert(): void } | undefined;
    let resolvePaint: (() => void) | undefined;
    const readiness = new Set<() => void>();
    const finish = () => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(frame);
      resolvePaint?.();
      readiness.forEach(resolve => resolve());
      context?.revert();
      split?.revert();
      owner.dataset.heroEntrance = 'complete';
    };
    const changeMotion = () => { if (motion.matches) finish(); };
    const inputs = ['pointerdown', 'keydown', 'wheel'] as const;
    inputs.forEach(event => owner.addEventListener(event, finish, { capture: true, passive: true }));
    window.addEventListener('scroll', finish, { passive: true });
    window.addEventListener('resize', finish, { passive: true });
    motion.addEventListener('change', changeMotion);
    owner.dataset.heroEntrance = 'waiting';

    const paint = () => new Promise<void>(resolve => {
      resolvePaint = resolve;
      frame = requestAnimationFrame(() => { resolvePaint = undefined; resolve(); });
    });
    const start = async () => {
      if (motion.matches) { finish(); return; }
      try {
        const [{ gsap }, { SplitText }] = await Promise.all([import('gsap'), import('gsap/SplitText')]);
        if (disposed || finished) return;
        const bounded = (promise: Promise<unknown>) => new Promise<void>(resolve => {
          const done = () => { window.clearTimeout(timer); readiness.delete(done); resolve(); };
          const timer = window.setTimeout(done, 400);
          readiness.add(done);
          void promise.then(done, done);
        });
        await bounded(document.fonts.ready);
        // The wheel's first owned draw proves placement, not a zero-size mount.
        const stage = owner.querySelector<HTMLElement>('[data-works-stage]');
        const deadline = performance.now() + 400;
        while (!disposed && !finished && performance.now() < deadline && (!stage?.clientHeight || !stage.dataset.draws)) await paint();
        if (!stage?.dataset.draws) { finish(); return; }
        if (disposed || finished) return;
        await paint();
        if (disposed || finished || motion.matches) { finish(); return; }
        const heading = owner.querySelector<HTMLElement>('[data-hero-intro] h1');
        if (!heading || !stage || Number(stage.dataset.turn) !== 0) { finish(); return; }
        const wordPoses = [...heading.querySelectorAll<HTMLElement>('[data-hero-word]')].map(element => getComputedStyle(element));
        const wordAlpha = wordPoses.map(pose => Number(pose.opacity));
        const reveals = [...owner.querySelectorAll<HTMLElement>('[data-hero-reveal]')];
        const revealAlpha = reveals.map(element => Number(getComputedStyle(element).opacity));
        // A cold/delayed module must not hide a composition already painted.
        // Adopt only the remaining first-paint reveal; no late entrance replay.
        if ([...wordAlpha, ...revealAlpha].every(alpha => alpha === 1)) { finish(); return; }
        gsap.registerPlugin(SplitText);
        owner.dataset.heroEntrance = 'running';
        context = gsap.context(() => {
          const words = SplitText.create(heading, {
            type: 'words,lines', mask: 'lines', aria: 'auto', wordsClass: 'hero-entrance-word',
          });
          split = words;
          const timeline = gsap.timeline({ onComplete: finish });
          timeline
            .fromTo(words.words, { opacity: index => wordAlpha[index] ?? 1, y: index => (1 - (wordAlpha[index] ?? 1)) * 32 },
              { opacity: 1, y: 0, duration: .55, stagger: .055, ease: 'power2.out' }, 0)
            .fromTo(reveals, { opacity: index => revealAlpha[index], y: index => (1 - revealAlpha[index]) * 32 },
               { opacity: 1, y: 0, duration: .45, stagger: .08 }, 0);
        }, owner);
        owner.dataset.heroEntrance = 'running';
        owner.dataset.heroEntranceStarts = '1';
      } catch {
        // Imports and media can fail: SSR-visible content must stay readable.
        finish();
      }
    };
    void start();
    return () => {
      disposed = true;
      finish();
      inputs.forEach(event => owner.removeEventListener(event, finish, true));
      window.removeEventListener('scroll', finish);
      window.removeEventListener('resize', finish);
      motion.removeEventListener('change', changeMotion);
    };
  }, [mounted, root]);
}
