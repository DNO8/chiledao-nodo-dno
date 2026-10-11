import type { CSSProperties } from 'react';

export function HeroIntro({ inactive = false }: { inactive?: boolean }) {
  // Keep the heading accessible and all intro dimensions stable in archive mode.
  const secondaryStyle: CSSProperties = { visibility: inactive ? 'hidden' : 'visible' };
  return (
    <div data-hero-intro className="text-center text-paper">
      <p data-hero-reveal inert={inactive} style={secondaryStyle} className="font-mono text-xs uppercase tracking-widest text-paper/80">Chile DAO · Educación</p>
      <h1 id="inicio-heading" style={{ clipPath: inactive ? 'inset(50%)' : undefined }}
        className="mt-4 font-heading text-[clamp(1.625rem,3vw,3rem)] font-bold tracking-tight text-white-warm leading-tight">
        {'Aprende sobre Blockchain e Inteligencia Artificial'.split(' ').map((word, index) => (
          <span key={word}>{index > 0 ? ' ' : ''}<span data-hero-word style={{ '--entrance-index': index } as CSSProperties}>{word}</span></span>
        ))}
      </h1>
      <p data-hero-reveal inert={inactive} style={secondaryStyle} className="mt-4 text-base text-paper/80 leading-relaxed">
        Comprende las tecnologías que están cambiando el mundo digital. Explora sus fundamentos, usos y límites con una comunidad en Chile.
      </p>
      <div data-hero-actions inert={inactive} style={secondaryStyle} className="pointer-events-auto mt-5 flex flex-col sm:flex-row justify-center gap-3">
        <a href="#formacion" className="inline-flex min-h-11 items-center justify-center px-5 py-3 bg-[#c8172a] text-white-warm font-semibold rounded-lg hover:bg-[#a91424] focus:outline-none focus-visible:ring-2 focus-visible:ring-red focus-visible:ring-offset-2 focus-visible:ring-offset-navy transition-colors">
          Explorar formación
        </a>
        <a href="https://linktr.ee/web3chile" target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center justify-center px-5 py-3 border border-paper/30 text-paper font-semibold rounded-lg hover:bg-paper/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-red transition-colors">
          Conocer la comunidad
        </a>
      </div>
    </div>
  );
}
