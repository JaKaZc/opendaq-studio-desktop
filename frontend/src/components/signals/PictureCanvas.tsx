import { useEffect, useRef, useState } from 'react';

/** A decoded picture drawn on a canvas that fills its parent, keeping its proportions. */
export function PictureCanvas({ bitmap, label }: { bitmap: ImageBitmap; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context || size.width === 0 || size.height === 0) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.round(size.width * ratio);
    const height = Math.round(size.height * ratio);
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    context.clearRect(0, 0, width, height);
    // A bitmap closed when the next picture replaced it has no size left.
    if (bitmap.width === 0 || bitmap.height === 0) return;
    const scale = Math.min(width / bitmap.width, height / bitmap.height);
    const drawnWidth = bitmap.width * scale;
    const drawnHeight = bitmap.height * scale;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, (width - drawnWidth) / 2, (height - drawnHeight) / 2, drawnWidth, drawnHeight);
  }, [bitmap, size]);

  return <canvas ref={canvasRef} role="img" aria-label={label} className="absolute inset-0 size-full" />;
}
