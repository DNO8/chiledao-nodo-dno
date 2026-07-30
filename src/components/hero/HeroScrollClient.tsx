"use client"

import * as React from "react"
import {
  ContainerScroll,
  ContainerSticky,
  GalleryContainer,
  GalleryCol,
} from "../animated-gallery"

const col1 = ["avalanche-chiledao", "avalanche-chiledao-2", "avalanche-chiledao-grupal"]
const col2 = [
  "polkadot-chiledao",
  "polkadot-chiledao-2",
  "polkadot-chiledao-grupal",
  "polkadot-chiledao-grupal-2",
]
const col3 = ["vendimiatech-chiledao", "vendimiatech-chiledao-grupal", "vendimiatech-workshop-chiledao"]

function Picture({ base, loading }: { base: string; loading?: "eager" | "lazy" }) {
  return (
    <picture className="block aspect-video rounded-md overflow-hidden shadow">
      <source srcSet={`/media/images/galeria/${base}.avif`} type="image/avif" />
      <source srcSet={`/media/images/galeria/${base}.webp`} type="image/webp" />
      <img
        src={`/media/images/galeria/${base}.jpg`}
        alt={`ChileDAO - ${base}`}
        className="w-full h-full object-cover"
        loading={loading ?? "lazy"}
        decoding="async"
      />
    </picture>
  )
}

export default function HeroScrollClient() {
  return (
    <ContainerScroll className="relative h-[350vh]">
      <ContainerSticky className="h-svh">
        <div className="absolute inset-0 bg-navy" aria-hidden="true" />

        <div className="absolute inset-0 flex items-center justify-center p-4 md:p-8">
          <GalleryContainer className="max-w-6xl w-full h-[70vh] md:h-[80vh]">
            <GalleryCol yRange={["0%", "-15%"]}>
              {col1.map((base, i) => (
                <Picture key={base} base={base} loading={i === 0 ? "eager" : "lazy"} />
              ))}
            </GalleryCol>
            <GalleryCol yRange={["0%", "-8%"]}>
              {col2.map((base, i) => (
                <Picture key={base} base={base} loading={i === 0 ? "eager" : "lazy"} />
              ))}
            </GalleryCol>
            <GalleryCol yRange={["0%", "-12%"]}>
              {col3.map((base, i) => (
                <Picture key={base} base={base} loading={i === 0 ? "eager" : "lazy"} />
              ))}
            </GalleryCol>
          </GalleryContainer>
        </div>

        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center text-center px-6">
          <p className="font-mono text-sm uppercase tracking-widest text-red mb-4">
            Comunidad Blockchain Chile
          </p>
          <h1 className="font-heading text-5xl md:text-7xl lg:text-8xl font-bold tracking-tight text-white-warm mb-6">
            ChileDAO <span className="text-red">Nodo DNO</span>
          </h1>
          <p className="text-lg md:text-xl lg:text-2xl text-paper/90 max-w-2xl mx-auto leading-relaxed">
            ChileDAO educa, incuba y articula comunidad para conectar el talento chileno con la Web3.
          </p>
        </div>

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
