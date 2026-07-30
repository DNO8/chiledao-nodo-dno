import { testimonios } from '../../data';

export default function TestimonialCards() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-8">
      {testimonios.map((t) => {
        const videoName = t.hasShort ? `${t.id}-short` : t.id;
        const posterAvif = `/media/videos/${t.id}-poster.avif`;
        const webm = `/media/videos/${videoName}.webm`;
        const mp4 = `/media/videos/${videoName}.mp4`;

        return (
          <article
            key={t.id}
            className="mx-auto w-full max-w-sm rounded-2xl overflow-hidden bg-navy border border-line/20 shadow-xl focus-within:ring-2 focus-within:ring-red"
            tabIndex={0}
            aria-label={t.label}
          >
            <div className="relative aspect-[9/16] w-full bg-ink">
              <video
                poster={posterAvif}
                controls
                playsInline
                preload="metadata"
                aria-label={t.label}
                className="h-full w-full object-cover"
              >
                <source src={webm} type="video/webm" />
                <source src={mp4} type="video/mp4" />
                Tu navegador no soporta video HTML5.
              </video>
            </div>
            <div className="p-4 md:p-5">
              <p className="font-heading text-base md:text-lg font-semibold text-white-warm">
                {t.label}
              </p>
              <p className="text-sm text-muted mt-1">Participante de la comunidad</p>
            </div>
          </article>
        );
      })}
    </div>
  );
}
