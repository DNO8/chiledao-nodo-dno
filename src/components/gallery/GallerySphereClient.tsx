"use client"

import * as React from "react"
import SphereImageGrid from "../sphere-image-grid"
import type { GalleryImage } from "../../lib/optimized-images"

export default function GallerySphereClient({ images }: { images: GalleryImage[] }) {
  const [containerSize, setContainerSize] = React.useState(300)

  React.useEffect(() => {
    const update = () => {
      const isDesktop = window.matchMedia("(min-width: 768px)").matches
      setContainerSize(isDesktop ? 500 : 300)
    }
    update()
    const mq = window.matchMedia("(min-width: 768px)")
    mq.addEventListener("change", update)
    return () => mq.removeEventListener("change", update)
  }, [])

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
