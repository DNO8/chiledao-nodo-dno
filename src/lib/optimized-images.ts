import { getImage } from 'astro:assets';
import type { ImageMetadata } from 'astro';

/**
 * Build-time image optimization for media assets.
 *
 * The .jpg files under src/assets/images are the masters; AVIF/WebP variants
 * are derived here via astro:assets (the pre-existing .avif/.webp files are
 * kept on disk but are not used as sources). Everything returned is plain
 * serializable data so React islands only need type imports from this module.
 */
export interface OptimizedImage {
  /** AVIF variant URL (hashed, emitted at build time). */
  avif: string;
  /** WebP variant URL (hashed, emitted at build time). */
  webp: string;
  /** Optimized JPEG fallback URL. */
  jpg: string;
  /** Intrinsic width in pixels. */
  width: number;
  /** Intrinsic height in pixels. */
  height: number;
}

export interface GalleryImage extends OptimizedImage {
  id: string;
  alt: string;
}

const galleryMasters = import.meta.glob<{ default: ImageMetadata }>(
  '../assets/images/galeria/*.jpg',
  { eager: true },
);
const journeyMasters = import.meta.glob<{ default: ImageMetadata }>(
  '../assets/images/journey/*.jpg',
  { eager: true },
);
const testimonialMasters = import.meta.glob<{ default: ImageMetadata }>(
  '../assets/images/testimonios/*.jpg',
  { eager: true },
);
const heroMasters = import.meta.glob<{ default: ImageMetadata }>(
  '../assets/images/hero/*.jpg',
  { eager: true },
);

async function optimize(master: ImageMetadata): Promise<OptimizedImage> {
  const [avif, webp, jpg] = await Promise.all([
    getImage({ src: master, format: 'avif' }),
    getImage({ src: master, format: 'webp' }),
    getImage({ src: master, format: 'jpg' }),
  ]);
  return {
    avif: avif.src,
    webp: webp.src,
    jpg: jpg.src,
    width: master.width,
    height: master.height,
  };
}

function masterFor(
  masters: Record<string, { default: ImageMetadata }>,
  dir: string,
  name: string,
): ImageMetadata {
  const master = masters[`../assets/images/${dir}/${name}.jpg`]?.default;
  if (!master) {
    throw new Error(`[optimized-images] Missing master: src/assets/images/${dir}/${name}.jpg`);
  }
  return master;
}

/** Optimized gallery photos, in the order given by `names`. */
export async function getGalleryImages(names: readonly string[]): Promise<GalleryImage[]> {
  return Promise.all(
    names.map(async (name) => ({
      ...(await optimize(masterFor(galleryMasters, 'galeria', name))),
      id: name,
      alt: `ChileDAO - ${name}`,
    })),
  );
}

/** Optimized journey photos keyed by base name (matches each slide's `image` field). */
export async function getJourneyImages(
  names: readonly string[],
): Promise<Record<string, OptimizedImage>> {
  const entries = await Promise.all(
    names.map(
      async (name) => [name, await optimize(masterFor(journeyMasters, 'journey', name))] as const,
    ),
  );
  return Object.fromEntries(entries);
}

/** Optimized hero poster (AVIF + JPEG fallback). */
export async function getHeroPoster(): Promise<OptimizedImage> {
  return optimize(masterFor(heroMasters, 'hero', 'chiledao-hero-poster'));
}

/** Optimized poster for a testimonial video, by testimonial id. */
export async function getTestimonialPoster(id: string): Promise<OptimizedImage> {
  return optimize(masterFor(testimonialMasters, 'testimonios', `${id}-poster`));
}
