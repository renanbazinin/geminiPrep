import { useEffect, useState, type ReactNode } from "react";

/**
 * The server's picture of a slide, as an image. It is an SVG whose text the browser sets with
 * its own fonts, so it is close to PowerPoint and not identical. When the server draws no
 * pictures, or cannot draw this one, `fallback` is shown in its place (the layout as boxes).
 */
export function SlidePicture({ src, alt, className, fallback, onAvailable }: {
  src: string;
  alt: string;
  className?: string;
  fallback: ReactNode;
  /** Told whether the picture could be shown, for a screen that draws differently without it. */
  onAvailable?(available: boolean): void;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) return <>{fallback}</>;
  return (
    <img
      className={`slide-picture${className ? ` ${className}` : ""}`}
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      onLoad={() => onAvailable?.(true)}
      onError={() => {
        setFailed(true);
        onAvailable?.(false);
      }}
    />
  );
}
