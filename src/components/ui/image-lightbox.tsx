import { useEffect, useId, useRef } from 'react';

export type LightboxImage = {
  fullSrc: string;
  fullWidth: number;
  fullHeight: number;
  alt: string;
  caption: string;
};

export default function ImageLightbox({ image, invoker, onClose }: {
  image: LightboxImage | null;
  invoker: HTMLElement | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const title = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!image || !dialog) return;
    const x = scrollX, y = scrollY;
    const owner = invoker?.closest('[data-timeline]');
    const imageId = invoker?.getAttribute('data-timeline-image');
    // Restore individual declarations and their priorities, including empty ones.
    const declarations = [
      [document.body, 'position', 'fixed'], [document.body, 'top', `${-y}px`],
      [document.body, 'left', `${-x}px`], [document.body, 'width', '100%'],
      [document.body, 'overflow', 'hidden'], [document.documentElement, 'overflow', 'hidden'],
    ] as const;
    const previous = declarations.map(([element, property]) => ({ element, property,
      value: element.style.getPropertyValue(property), priority: element.style.getPropertyPriority(property) }));
    dialog.showModal();
    declarations.forEach(([element, property, value]) => element.style.setProperty(property, value));
    return () => {
      dialog.close();
      previous.forEach(({ element, property, value, priority }) => {
        if (value) element.style.setProperty(property, value, priority);
        else element.style.removeProperty(property);
      });
      window.scrollTo({ left: x, top: y, behavior: 'instant' });
      // A responsive consumer may replace the original link while open.
      const target = invoker?.isConnected ? invoker : imageId
        ? owner?.querySelector<HTMLElement>(`[data-timeline-image="${CSS.escape(imageId)}"]`) : null;
      target?.focus({ preventScroll: true });
    };
  }, [image, invoker]);

  return <dialog ref={ref} data-image-lightbox aria-labelledby={title}
    onCancel={event => { event.preventDefault(); onClose(); }}
    onKeyDown={event => {
      if (event.key === 'Escape') event.stopPropagation();
      if (event.key !== 'Tab') return;
      // Native modal inertness blocks page controls, but Chrome can still Tab
      // into browser UI. Keep the requested keyboard cycle inside this viewer.
      const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
        'button, a[href], input, select, textarea, [tabindex]')].filter(element =>
        element.tabIndex >= 0 && !element.matches(':disabled, [hidden], [inert], [inert] *')
        && element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible');
      const first = focusable[0], last = focusable.at(-1);
      if (!first) { event.preventDefault(); event.currentTarget.focus(); return; }
      if (!event.currentTarget.contains(document.activeElement)
        || (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus({ preventScroll: true });
      }
    }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const r = event.currentTarget.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) onClose();
    }}>
    <style>{`
      [data-image-lightbox] { border:1px solid #f8f6ee66; border-radius:12px; padding:16px; margin:auto; width:min(1100px,calc(100vw - 32px)); max-width:calc(100vw - 32px); max-height:calc(100dvh - 32px); color:#f8f6ee; background:#0e1320; overflow:auto; }
      [data-image-lightbox]::backdrop { background:#000b; }
      [data-image-lightbox] figure { margin:0; }
      [data-image-lightbox] img { display:block; width:100%; height:min(70dvh,760px); object-fit:contain; }
      [data-image-lightbox] figcaption { margin-top:12px; font-size:16px; line-height:1.4; }
      [data-image-lightbox] button { display:block; min-width:44px; min-height:44px; margin-left:auto; padding:8px 12px; border:1px solid #f8f6ee88; border-radius:6px; }
      [data-image-lightbox] button:focus-visible { outline:2px solid #f8f6ee; outline-offset:2px; }
      @media(max-width:599px) { [data-image-lightbox] { padding:12px; } [data-image-lightbox] img { height:58dvh; } }
    `}</style>
    <button type="button" autoFocus onClick={onClose} aria-label="Cerrar imagen">Cerrar ×</button>
    {image && <figure>
      <img src={image.fullSrc} width={image.fullWidth} height={image.fullHeight} alt={image.alt} decoding="async" />
      <figcaption id={title}>{image.caption}</figcaption>
    </figure>}
  </dialog>;
}
