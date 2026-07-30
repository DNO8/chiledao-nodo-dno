"use client"

import * as React from "react"
import SphereImageGrid, { type ImageData } from "../sphere-image-grid"
import { galeria } from "../../data"

function formatAlt(name: string) {
  return `ChileDAO - ${name}`
}

export default function GallerySphereClient() {
  const [containerSize, setContainerSize] = React.useState(320)

  React.useEffect(() => {
    const update = () => {
      const isDesktop = window.matchMedia("(min-width: 768px)").matches
      setContainerSize(isDesktop ? 600 : 320)
    }
    update()
    const mq = window.matchMedia("(min-width: 768px)")
    mq.addEventListener("change", update)
    return () => mq.removeEventListener("change", update)
  }, [])

  const images: ImageData[] = React.useMemo(
    () =>
      galeria.slice(0, 20).map((name) => ({
        id: name,
        src: `/media/images/galeria/${name}.jpg`,
        alt: formatAlt(name),
      })),
    []
  )

  return (
    <SphereImageGrid
      images={images}
      containerSize={containerSize}
      autoRotate={true}
      autoRotateSpeed={0.15}
      sphereRadius={200}
    />
  )
}
