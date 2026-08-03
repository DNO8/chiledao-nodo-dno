import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { X } from 'lucide-react';

export interface Position3D {
  x: number;
  y: number;
  z: number;
}

export interface SphericalPosition {
  theta: number;
  phi: number;
  radius: number;
}

export interface WorldPosition extends Position3D {
  scale: number;
  zIndex: number;
  isVisible: boolean;
  fadeOpacity: number;
  originalIndex: number;
}

export interface ImageData {
  id: string;
  avif: string;
  webp: string;
  jpg: string;
  alt: string;
  title?: string;
  description?: string;
}

export interface SphereImageGridProps {
  images?: ImageData[];
  containerSize?: number;
  sphereRadius?: number;
  dragSensitivity?: number;
  momentumDecay?: number;
  maxRotationSpeed?: number;
  baseImageScale?: number;
  hoverScale?: number;
  perspective?: number;
  autoRotate?: boolean;
  autoRotateSpeed?: number;
  className?: string;
}

interface RotationState { x: number; y: number; z: number; }
interface VelocityState { x: number; y: number; }
interface MousePosition { x: number; y: number; }

const MAX_IMAGES = 20;

const SPHERE_MATH = {
  degreesToRadians: (degrees: number): number => degrees * (Math.PI / 180),
  radiansToDegrees: (radians: number): number => radians * (180 / Math.PI),
  sphericalToCartesian: (radius: number, theta: number, phi: number): Position3D => ({
    x: radius * Math.sin(phi) * Math.cos(theta),
    y: radius * Math.cos(phi),
    z: radius * Math.sin(phi) * Math.sin(theta)
  }),
  calculateDistance: (pos: Position3D, center: Position3D = { x: 0, y: 0, z: 0 }): number => {
    const dx = pos.x - center.x;
    const dy = pos.y - center.y;
    const dz = pos.z - center.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  },
  normalizeAngle: (angle: number): number => {
    while (angle > 180) angle -= 360;
    while (angle < -180) angle += 360;
    return angle;
  }
};

const seededRandom = (i: number): number => {
  return ((i * 2654435761) % 1000) / 1000;
};

const StaticGridFallback: React.FC<{
  images: ImageData[];
  onSelect?: (image: ImageData) => void;
}> = ({ images, onSelect }) => {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
      {images.map((image) => (
        <button
          key={image.id}
          type="button"
          onClick={() => onSelect?.(image)}
          className="block aspect-square w-full cursor-pointer overflow-hidden rounded-lg p-0 ring-1 ring-white/10 shadow-lg shadow-navy/60 transition-transform duration-200 hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red"
        >
          <picture className="block h-full w-full">
            <source srcSet={image.avif} type="image/avif" />
            <source srcSet={image.webp} type="image/webp" />
            <img
              src={image.jpg}
              alt={image.alt}
              className="h-full w-full object-cover"
              loading="lazy"
              decoding="async"
            />
          </picture>
        </button>
      ))}
    </div>
  );
};

const SphereImageGrid: React.FC<SphereImageGridProps> = ({
  images = [],
  containerSize = 400,
  sphereRadius = 200,
  dragSensitivity = 0.5,
  momentumDecay = 0.95,
  maxRotationSpeed = 5,
  baseImageScale = 0.12,
  hoverScale = 1.2,
  perspective = 1000,
  autoRotate = false,
  autoRotateSpeed = 0.3,
  className = ''
}) => {
  const [isMounted, setIsMounted] = useState<boolean>(false);
  const [rotation, setRotation] = useState<RotationState>({ x: 15, y: 15, z: 0 });
  const [velocity, setVelocity] = useState<VelocityState>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [selectedImage, setSelectedImage] = useState<ImageData | null>(null);
  const [imagePositions, setImagePositions] = useState<SphericalPosition[]>([]);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [isVisible, setIsVisible] = useState<boolean>(false);
  const [reducedMotion, setReducedMotion] = useState<boolean>(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const lastMousePos = useRef<MousePosition>({ x: 0, y: 0 });
  const animationFrame = useRef<number | null>(null);

  const limitedImages = useMemo(() => images.slice(0, MAX_IMAGES), [images]);

  const actualSphereRadius = sphereRadius || containerSize * 0.5;
  const baseImageSize = containerSize * baseImageScale;

  const generateSpherePositions = useCallback((): SphericalPosition[] => {
    const positions: SphericalPosition[] = [];
    const imageCount = limitedImages.length;
    const goldenRatio = (1 + Math.sqrt(5)) / 2;
    const angleIncrement = 2 * Math.PI / goldenRatio;

    for (let i = 0; i < imageCount; i++) {
      const t = i / imageCount;
      const inclination = Math.acos(1 - 2 * t);
      const azimuth = angleIncrement * i;
      let phi = inclination * (180 / Math.PI);
      let theta = (azimuth * (180 / Math.PI)) % 360;
      const poleBonus = Math.pow(Math.abs(phi - 90) / 90, 0.6) * 35;
      if (phi < 90) { phi = Math.max(5, phi - poleBonus); } else { phi = Math.min(175, phi + poleBonus); }
      phi = 15 + (phi / 180) * 150;
      const randomOffset = (seededRandom(i) - 0.5) * 20;
      theta = (theta + randomOffset) % 360;
      phi = Math.max(0, Math.min(180, phi + (seededRandom(i + 1000) - 0.5) * 10));
      positions.push({ theta, phi, radius: actualSphereRadius });
    }
    return positions;
  }, [limitedImages.length, actualSphereRadius]);

  const calculateWorldPositions = useMemo((): WorldPosition[] => {
    const positions = imagePositions.map((pos, index) => {
      const thetaRad = SPHERE_MATH.degreesToRadians(pos.theta);
      const phiRad = SPHERE_MATH.degreesToRadians(pos.phi);
      const rotXRad = SPHERE_MATH.degreesToRadians(rotation.x);
      const rotYRad = SPHERE_MATH.degreesToRadians(rotation.y);
      let x = pos.radius * Math.sin(phiRad) * Math.cos(thetaRad);
      let y = pos.radius * Math.cos(phiRad);
      let z = pos.radius * Math.sin(phiRad) * Math.sin(thetaRad);
      const x1 = x * Math.cos(rotYRad) + z * Math.sin(rotYRad);
      const z1 = -x * Math.sin(rotYRad) + z * Math.cos(rotYRad);
      x = x1; z = z1;
      const y2 = y * Math.cos(rotXRad) - z * Math.sin(rotXRad);
      const z2 = y * Math.sin(rotXRad) + z * Math.cos(rotXRad);
      y = y2; z = z2;
      const worldPos: Position3D = { x, y, z };
      const fadeZoneStart = -10;
      const fadeZoneEnd = -30;
      const isVisible = worldPos.z > fadeZoneEnd;
      let fadeOpacity = 1;
      if (worldPos.z <= fadeZoneStart) {
        fadeOpacity = Math.max(0, (worldPos.z - fadeZoneEnd) / (fadeZoneStart - fadeZoneEnd));
      }
      const isPoleImage = pos.phi < 30 || pos.phi > 150;
      const distanceFromCenter = Math.sqrt(worldPos.x * worldPos.x + worldPos.y * worldPos.y);
      const maxDistance = actualSphereRadius;
      const distanceRatio = Math.min(distanceFromCenter / maxDistance, 1);
      const distancePenalty = isPoleImage ? 0.4 : 0.7;
      const centerScale = Math.max(0.3, 1 - distanceRatio * distancePenalty);
      const depthScale = (worldPos.z + actualSphereRadius) / (2 * actualSphereRadius);
      const scale = centerScale * Math.max(0.5, 0.8 + depthScale * 0.3);
      return { ...worldPos, scale, zIndex: Math.round(1000 + worldPos.z), isVisible, fadeOpacity, originalIndex: index };
    });

    const adjustedPositions = [...positions];
    for (let i = 0; i < adjustedPositions.length; i++) {
      const pos = adjustedPositions[i];
      if (!pos.isVisible) continue;
      let adjustedScale = pos.scale;
      const imageSize = baseImageSize * adjustedScale;
      for (let j = 0; j < adjustedPositions.length; j++) {
        if (i === j) continue;
        const other = adjustedPositions[j];
        if (!other.isVisible) continue;
        const otherSize = baseImageSize * other.scale;
        const dx = pos.x - other.x;
        const dy = pos.y - other.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const minDistance = (imageSize + otherSize) / 2 + 25;
        if (distance < minDistance && distance > 0) {
          const overlap = minDistance - distance;
          const reductionFactor = Math.max(0.4, 1 - (overlap / minDistance) * 0.6);
          adjustedScale = Math.min(adjustedScale, adjustedScale * reductionFactor);
        }
      }
      adjustedPositions[i] = { ...pos, scale: Math.max(0.25, adjustedScale) };
    }
    return adjustedPositions;
  }, [imagePositions, rotation, actualSphereRadius, baseImageSize]);

  const clampRotationSpeed = useCallback((speed: number): number => {
    return Math.max(-maxRotationSpeed, Math.min(maxRotationSpeed, speed));
  }, [maxRotationSpeed]);

  const updateMomentum = useCallback(() => {
    if (isDragging) return;
    setVelocity(prev => {
      const newVelocity = { x: prev.x * momentumDecay, y: prev.y * momentumDecay };
      if (!autoRotate && Math.abs(newVelocity.x) < 0.01 && Math.abs(newVelocity.y) < 0.01) {
        return { x: 0, y: 0 };
      }
      return newVelocity;
    });
    setRotation(prev => {
      let newY = prev.y;
      if (autoRotate && !reducedMotion) { newY += autoRotateSpeed; }
      newY += clampRotationSpeed(velocity.y);
      return { x: SPHERE_MATH.normalizeAngle(prev.x + clampRotationSpeed(velocity.x)), y: SPHERE_MATH.normalizeAngle(newY), z: prev.z };
    });
  }, [isDragging, momentumDecay, velocity, clampRotationSpeed, autoRotate, autoRotateSpeed, reducedMotion]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); setIsDragging(true); setVelocity({ x: 0, y: 0 });
    lastMousePos.current = { x: e.clientX, y: e.clientY };
  }, []);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDragging) return;
    const deltaX = e.clientX - lastMousePos.current.x;
    const deltaY = e.clientY - lastMousePos.current.y;
    const rotationDelta = { x: -deltaY * dragSensitivity, y: deltaX * dragSensitivity };
    setRotation(prev => ({
      x: SPHERE_MATH.normalizeAngle(prev.x + clampRotationSpeed(rotationDelta.x)),
      y: SPHERE_MATH.normalizeAngle(prev.y + clampRotationSpeed(rotationDelta.y)),
      z: prev.z
    }));
    setVelocity({ x: clampRotationSpeed(rotationDelta.x), y: clampRotationSpeed(rotationDelta.y) });
    lastMousePos.current = { x: e.clientX, y: e.clientY };
  }, [isDragging, dragSensitivity, clampRotationSpeed]);

  const handleMouseUp = useCallback(() => { setIsDragging(false); }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    e.preventDefault(); const touch = e.touches[0];
    setIsDragging(true); setVelocity({ x: 0, y: 0 });
    lastMousePos.current = { x: touch.clientX, y: touch.clientY };
  }, []);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!isDragging) return; e.preventDefault();
    const touch = e.touches[0];
    const deltaX = touch.clientX - lastMousePos.current.x;
    const deltaY = touch.clientY - lastMousePos.current.y;
    const rotationDelta = { x: -deltaY * dragSensitivity, y: deltaX * dragSensitivity };
    setRotation(prev => ({
      x: SPHERE_MATH.normalizeAngle(prev.x + clampRotationSpeed(rotationDelta.x)),
      y: SPHERE_MATH.normalizeAngle(prev.y + clampRotationSpeed(rotationDelta.y)),
      z: prev.z
    }));
    setVelocity({ x: clampRotationSpeed(rotationDelta.x), y: clampRotationSpeed(rotationDelta.y) });
    lastMousePos.current = { x: touch.clientX, y: touch.clientY };
  }, [isDragging, dragSensitivity, clampRotationSpeed]);

  const handleTouchEnd = useCallback(() => { setIsDragging(false); }, []);

  useEffect(() => { setIsMounted(true); }, []);
  useEffect(() => { setImagePositions(generateSpherePositions()); }, [generateSpherePositions]);

  useEffect(() => {
    if (!isMounted || reducedMotion) return;

    const animate = () => { updateMomentum(); animationFrame.current = requestAnimationFrame(animate); };
    if (isVisible) { animationFrame.current = requestAnimationFrame(animate); }
    return () => { if (animationFrame.current) { cancelAnimationFrame(animationFrame.current); } };
  }, [isMounted, isVisible, updateMomentum, reducedMotion]);

  useEffect(() => {
    if (!isMounted || reducedMotion) return;
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
    };
  }, [isMounted, handleMouseMove, handleMouseUp, handleTouchMove, handleTouchEnd, reducedMotion]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !containerRef.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsVisible(entry.isIntersecting);
      },
      { threshold: 0 }
    );

    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [isMounted]);

  const renderImageNode = useCallback((image: ImageData, index: number) => {
    const position = calculateWorldPositions[index];
    if (!position || !position.isVisible) return null;
    const imageSize = baseImageSize * position.scale;
    const isHovered = hoveredIndex === index;
    const finalScale = isHovered ? Math.min(hoverScale, hoverScale / position.scale) : 1;
    return (
      <div
        key={image.id}
        className="absolute cursor-pointer select-none transition-transform duration-200 ease-out"
        style={{
          width: `${imageSize}px`, height: `${imageSize}px`,
          left: `${containerSize/2 + position.x}px`, top: `${containerSize/2 + position.y}px`,
          opacity: position.fadeOpacity,
          transform: `translate(-50%, -50%) scale(${finalScale})`,
          zIndex: position.zIndex
        }}
        onMouseEnter={() => setHoveredIndex(index)}
        onMouseLeave={() => setHoveredIndex(null)}
        onClick={() => setSelectedImage(image)}
      >
        <div className="relative w-full h-full rounded-lg overflow-hidden shadow-lg border-2 border-white/20">
          <picture>
            <source srcSet={image.avif} type="image/avif" />
            <source srcSet={image.webp} type="image/webp" />
            <img
              src={image.jpg}
              alt={image.alt}
              className="w-full h-full object-cover"
              draggable={false}
              loading={index < 3 ? 'eager' : 'lazy'}
            />
          </picture>
        </div>
      </div>
    );
  }, [calculateWorldPositions, baseImageSize, containerSize, hoveredIndex, hoverScale]);

  const renderSpotlightModal = () => {
    if (!selectedImage) return null;
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/30" onClick={() => setSelectedImage(null)} style={{ animation: 'fadeIn 0.3s ease-out' }}>
        <div className="bg-navy rounded-xl max-w-md w-full overflow-hidden ring-1 ring-white/10" onClick={(e) => e.stopPropagation()} style={{ animation: 'scaleIn 0.3s ease-out' }}>
          <div className="relative aspect-square">
            <picture>
              <source srcSet={selectedImage.avif} type="image/avif" />
              <source srcSet={selectedImage.webp} type="image/webp" />
              <img src={selectedImage.jpg} alt={selectedImage.alt} className="w-full h-full object-cover" />
            </picture>
            <button onClick={() => setSelectedImage(null)} className="absolute top-2 right-2 w-8 h-8 bg-black bg-opacity-50 rounded-full text-white flex items-center justify-center hover:bg-opacity-70 transition-all cursor-pointer">
              <X size={16} />
            </button>
          </div>
          {(selectedImage.title || selectedImage.description) && (
            <div className="p-6">
              {selectedImage.title && <h3 className="text-xl font-bold mb-2 text-white-warm">{selectedImage.title}</h3>}
              {selectedImage.description && <p className="text-paper/70">{selectedImage.description}</p>}
            </div>
          )}
        </div>
      </div>
    );
  };

  if (!isMounted) {
    return <StaticGridFallback images={images} onSelect={setSelectedImage} />;
  }
  if (!limitedImages.length) {
    return <div className="bg-navy rounded-lg border-2 border-dashed border-red/50 flex items-center justify-center" style={{ width: containerSize, height: containerSize }}><div className="text-paper/60 text-center"><p>No images provided</p><p className="text-sm text-paper/40">Add images to the images prop</p></div></div>;
  }

  if (reducedMotion) {
    return (
      <>
        <style>{`@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } } @keyframes scaleIn { from { transform: scale(0.8); opacity: 0; } to { transform: scale(1); opacity: 1; } }`}</style>
        <StaticGridFallback images={images} onSelect={setSelectedImage} />
        {renderSpotlightModal()}
      </>
    );
  }

  return (
    <>
      <style>{`@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } } @keyframes scaleIn { from { transform: scale(0.8); opacity: 0; } to { transform: scale(1); opacity: 1; } }`}</style>
      <div ref={containerRef} className={`relative select-none cursor-grab active:cursor-grabbing ${className}`} style={{ width: containerSize, height: containerSize, perspective: `${perspective}px` }} onMouseDown={handleMouseDown} onTouchStart={handleTouchStart}>
        <div className="relative w-full h-full" style={{ zIndex: 10 }}>
          {limitedImages.map((image, index) => renderImageNode(image, index))}
        </div>
      </div>
      {renderSpotlightModal()}
    </>
  );
};

export default SphereImageGrid;
