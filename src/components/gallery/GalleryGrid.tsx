import { useCallback, useEffect, useRef, useState } from 'react';
import { galeria } from '../../data';

function formatAlt(name: string) {
  return `ChileDAO - ${name}`;
}

export default function GalleryGrid() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousActiveElement = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setOpenIndex(null);
  }, []);

  const goNext = useCallback(() => {
    if (openIndex === null) return;
    setOpenIndex((openIndex + 1) % galeria.length);
  }, [openIndex]);

  const goPrev = useCallback(() => {
    if (openIndex === null) return;
    setOpenIndex((openIndex - 1 + galeria.length) % galeria.length);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (openIndex === null) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight') goNext();
      if (e.key === 'ArrowLeft') goPrev();

      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [close, goNext, goPrev, openIndex]);

  useEffect(() => {
    if (openIndex !== null) {
      previousActiveElement.current = document.activeElement as HTMLElement;
      dialogRef.current?.focus();
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
      previousActiveElement.current?.focus?.();
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [openIndex]);

  const openAt = (index: number) => {
    setOpenIndex(index);
  };

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6">
        {galeria.map((name, index) => {
          const avif = `/media/images/galeria/${name}.avif`;
          const webp = `/media/images/galeria/${name}.webp`;
          const jpg = `/media/images/galeria/${name}.jpg`;
          const loading = index < 4 ? 'eager' : 'lazy';

          return (
            <button
              key={name}
              type="button"
              onClick={() => openAt(index)}
              className="group relative aspect-square overflow-hidden rounded-lg border-2 border-transparent bg-line/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-red"
              aria-label={`Ampliar imagen: ${formatAlt(name)}`}
            >
              <img
                srcSet={`${avif} 1x, ${webp} 1x, ${jpg} 1x`}
                sizes="(max-width: 768px) 50vw, (max-width: 1024px) 33vw, 25vw"
                src={jpg}
                alt={formatAlt(name)}
                loading={loading}
                decoding="async"
                className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-[1.02] group-focus-visible:scale-[1.02]"
              />
              <span
                className="pointer-events-none absolute inset-0 rounded-lg border-2 border-transparent transition-colors duration-300 group-hover:border-red/60 group-focus-visible:border-red"
                aria-hidden="true"
              />
            </button>
          );
        })}
      </div>

      {openIndex !== null && (
        <div
          ref={dialogRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label="Vista ampliada de imagen"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/95 p-4"
          onClick={close}
        >
          <button
            type="button"
            onClick={close}
            className="absolute top-4 right-4 p-2 text-white-warm hover:text-red focus:outline-none focus-visible:ring-2 focus-visible:ring-red rounded"
            aria-label="Cerrar galería"
          >
            <svg className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              goPrev();
            }}
            className="absolute left-4 top-1/2 -translate-y-1/2 p-2 text-white-warm hover:text-red focus:outline-none focus-visible:ring-2 focus-visible:ring-red rounded"
            aria-label="Imagen anterior"
          >
            <svg className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>

          <img
            src={`/media/images/galeria/${galeria[openIndex]}.jpg`}
            alt={formatAlt(galeria[openIndex])}
            className="max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          />

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              goNext();
            }}
            className="absolute right-4 top-1/2 -translate-y-1/2 p-2 text-white-warm hover:text-red focus:outline-none focus-visible:ring-2 focus-visible:ring-red rounded"
            aria-label="Imagen siguiente"
          >
            <svg className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>

          <p className="absolute bottom-4 left-1/2 -translate-x-1/2 text-sm text-paper/80 font-mono">
            {openIndex + 1} / {galeria.length}
          </p>
        </div>
      )}
    </>
  );
}
