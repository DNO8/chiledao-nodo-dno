"use client"

import * as React from "react"
import {
  ContainerScroll,
  ContainerSticky,
  ContainerStagger,
  ContainerAnimated,
} from "../animated-gallery"
import { site } from "../../data/site"
import type { OptimizedImage } from "../../lib/optimized-images"

export default function HeroScrollClient({ poster }: { poster: OptimizedImage }) {
  const [isDesktop, setIsDesktop] = React.useState(false)
  const [reducedMotion, setReducedMotion] = React.useState(false)
  const [mounted, setMounted] = React.useState(false)

  React.useEffect(() => {
    setMounted(true)
    const desktopMq = window.matchMedia("(min-width: 768px)")
    const motionMq = window.matchMedia("(prefers-reduced-motion: reduce)")
    const updateDesktop = () => setIsDesktop(desktopMq.matches)
    const updateMotion = () => setReducedMotion(motionMq.matches)
    updateDesktop()
    updateMotion()
    desktopMq.addEventListener("change", updateDesktop)
    motionMq.addEventListener("change", updateMotion)
    return () => {
      desktopMq.removeEventListener("change", updateDesktop)
      motionMq.removeEventListener("change", updateMotion)
    }
  }, [])

  const showVideo = mounted && isDesktop && !reducedMotion

  return (
    <ContainerScroll className="relative h-[350vh]">
      <ContainerSticky className="h-svh">
        {showVideo ? (
          <video
            className="absolute inset-0 w-full h-full object-cover"
            autoPlay
            loop
            muted
            playsInline
            preload="none"
            poster={poster.avif}
          >
            <source src="/media/hero/chiledao-hero.webm" type="video/webm" />
            <source src="/media/hero/chiledao-hero.mp4" type="video/mp4" />
          </video>
        ) : (
          <picture className="absolute inset-0 w-full h-full">
            <source srcSet={poster.avif} type="image/avif" />
            <img
              src={poster.jpg}
              alt="ChileDAO"
              width={poster.width}
              height={poster.height}
              className="w-full h-full object-cover"
            />
          </picture>
        )}

        <div className="absolute inset-0 bg-navy/50" aria-hidden="true" />

        {reducedMotion ? (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center text-center px-6">
            <p className="font-mono text-sm uppercase tracking-widest text-red mb-4">
              Comunidad Blockchain Chile
            </p>
            <h1 className="font-heading text-5xl md:text-7xl lg:text-8xl font-bold tracking-tight text-white-warm mb-6">
              ChileDAO <span className="text-red">Nodo DNO</span>
            </h1>
            <p className="text-lg md:text-xl text-paper/90 max-w-2xl mx-auto leading-relaxed">
              {site.tagline}
            </p>
          </div>
        ) : (
          <ContainerStagger className="absolute inset-0 z-20 flex flex-col items-center justify-center text-center px-6">
            <ContainerAnimated>
              <p className="font-mono text-sm uppercase tracking-widest text-red mb-4">
                Comunidad Blockchain Chile
              </p>
            </ContainerAnimated>
            <ContainerAnimated>
              <h1 className="font-heading text-5xl md:text-7xl lg:text-8xl font-bold tracking-tight text-white-warm mb-6">
                ChileDAO <span className="text-red">Nodo DNO</span>
              </h1>
            </ContainerAnimated>
            <ContainerAnimated>
              <p className="text-lg md:text-xl text-paper/90 max-w-2xl mx-auto leading-relaxed">
                {site.tagline}
              </p>
            </ContainerAnimated>
          </ContainerStagger>
        )}

        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 z-20 motion-safe:animate-bounce" aria-hidden="true">
          <svg
            className="w-6 h-6 text-paper/70"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </ContainerSticky>
    </ContainerScroll>
  )
}
