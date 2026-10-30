import { useEffect, useRef, useState } from 'react';
import { drawPlot, PlotPictures } from '../../lib/plotData';

/** Plot data drawn on a canvas that fills its parent. */
export function PlotCanvas({ data, label }: { data: ArrayBuffer; label: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  // A picture in the plot, such as a camera's, is drawn again once decoded.
  const [decoded, setDecoded] = useState(0);
  const [pictures] = useState(() => new PlotPictures(() => setDecoded((n) => n + 1)));

  useEffect(() => () => pictures.close(), [pictures]);

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
    drawPlot(context, data, size.width, size.height, ratio, pictures);
  }, [data, size, pictures, decoded]);

  return <canvas ref={canvasRef} role="img" aria-label={label} className="absolute inset-0 size-full" />;
}
