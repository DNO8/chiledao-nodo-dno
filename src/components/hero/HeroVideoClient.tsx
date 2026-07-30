import { useEffect, useState } from 'react';

interface NavigatorWithConnection extends Navigator {
  connection?: {
    saveData?: boolean;
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  };
}

const nav = () => navigator as NavigatorWithConnection;

const prefersVideo = () => {
  if (typeof window === 'undefined') return false;
  const isDesktop = window.matchMedia('(min-width: 768px)').matches;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const saveData = nav().connection?.saveData === true;
  return isDesktop && !reducedMotion && !saveData;
};

export default function HeroVideoClient() {
  const [showVideo, setShowVideo] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setShowVideo(prefersVideo());

    const mqDesktop = window.matchMedia('(min-width: 768px)');
    const mqMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    const update = () => {
      const isDesktop = mqDesktop.matches;
      const reducedMotion = mqMotion.matches;
      const saveData = nav().connection?.saveData === true;
      setShowVideo(isDesktop && !reducedMotion && !saveData);
    };

    mqDesktop.addEventListener('change', update);
    mqMotion.addEventListener('change', update);
    const conn = nav().connection;
    if (conn && typeof conn.addEventListener === 'function') {
      conn.addEventListener('change', update);
    }

    return () => {
      mqDesktop.removeEventListener('change', update);
      mqMotion.removeEventListener('change', update);
      if (conn && typeof conn.removeEventListener === 'function') {
        conn.removeEventListener('change', update);
      }
    };
  }, []);

  if (!mounted) {
    return (
      <img
        src="/media/hero/chiledao-hero-poster.avif"
        onError={(e) => {
          e.currentTarget.src = '/media/hero/chiledao-hero-poster.jpg';
        }}
        alt=""
        className="absolute inset-0 w-full h-full object-cover z-0"
        aria-hidden="true"
        loading="eager"
        decoding="async"
      />
    );
  }

  if (!showVideo) {
    return (
      <img
        src="/media/hero/chiledao-hero-poster.avif"
        onError={(e) => {
          e.currentTarget.src = '/media/hero/chiledao-hero-poster.jpg';
        }}
        alt=""
        className="absolute inset-0 w-full h-full object-cover z-0"
        aria-hidden="true"
        loading="eager"
        decoding="async"
      />
    );
  }

  return (
    <video
      poster="/media/hero/chiledao-hero-poster.avif"
      muted
      loop
      playsInline
      autoPlay
      aria-hidden="true"
      className="absolute inset-0 w-full h-full object-cover z-0"
    >
      <source src="/media/hero/chiledao-hero.webm" type="video/webm" />
      <source src="/media/hero/chiledao-hero.mp4" type="video/mp4" />
    </video>
  );
}
