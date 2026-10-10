import type { Work } from '@/data/works';

export function ProductDetails({ work }: { work: Work }) {
  return (
    <div data-product-details data-work-id={work.id} aria-live="polite" aria-atomic="true"
      className="rounded-xl border border-paper/20 p-4 text-paper bg-navy/95">
      <p className="text-sm font-semibold">Experiencia en formación y comunidad</p>
      <h2 className="mt-2 text-xl font-heading font-bold" data-work-title>{work.title}</h2>
      <p className="mt-2 text-sm" data-work-category>{work.category}</p>
      {work.period && <p className="mt-1 text-sm text-paper/80">{work.period}</p>}
      <p className="mt-3 leading-relaxed" data-work-description>{work.description}</p>
      <p className="mt-2 text-sm text-paper/80">Afiche de archivo; no es una convocatoria vigente.</p>
      <a href="#contacto" className="mt-3 inline-flex min-h-11 items-center underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-paper">
        Consultar formación
      </a>
    </div>
  );
}
