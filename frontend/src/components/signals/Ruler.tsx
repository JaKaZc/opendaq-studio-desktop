import { useEffect, useRef } from 'react';
import { tickLabel, tickStep } from '../../lib/tracks';
import { useTracks } from '../../store/useTracks';
import { HEADER_WIDTH } from './TrackRow';
import { addPainter, invalidate } from './trackLoop';

function clock(epoch: number, withTenths: boolean): string {
  const date = new Date(epoch * 1000);
  const text = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  return withTenths ? `${text}.${Math.floor((epoch % 1) * 10)}` : text;
}

/**
 * The time axis above the tracks: seconds before now while live, the clock
 * when paused, and the time under the pointer.
 */
export function Ruler({ label }: { label: React.ReactNode }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const box = { width: 0, height: 0, ratio: 1 };
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      box.ratio = window.devicePixelRatio || 1;
      box.width = Math.floor(entry.contentRect.width);
      box.height = Math.floor(entry.contentRect.height);
      canvas.width = Math.round(box.width * box.ratio);
      canvas.height = Math.round(box.height * box.ratio);
      invalidate();
    });
    observer.observe(canvas);

    const stop = addPainter(({ start, end, colors }) => {
      if (!box.width) return;
      const { frozenEnd, cursor } = useTracks.getState();
      const span = end - start;
      const x = (time: number) => ((time - start) / span) * box.width;
      context.setTransform(box.ratio, 0, 0, box.ratio, 0, 0);
      context.clearRect(0, 0, box.width, box.height);
      context.font = '500 10.5px Roboto, system-ui, sans-serif';
      context.textBaseline = 'middle';
      // A label needs about 90 pixels, so a narrow window gets fewer of them.
      const step = tickStep(span, Math.max(2, Math.floor(box.width / 90)));
      for (let back = 0; back <= span; back += step) {
        const px = Math.round(x(end - back)) + 0.5;
        context.strokeStyle = colors.grid;
        context.beginPath();
        context.moveTo(px, box.height - 6);
        context.lineTo(px, box.height);
        context.stroke();
        const text = frozenEnd === null ? tickLabel(back, step) : clock(end - back, step < 1);
        // A label that would be cut off at the left edge is left out.
        if (back > 0 && px - context.measureText(text).width / 2 < 2) continue;
        context.fillStyle = colors.text;
        context.textAlign = back === 0 ? 'right' : 'center';
        context.fillText(text, back === 0 ? px - 4 : px, box.height / 2 - 2);
      }
      if (cursor !== null && cursor >= start && cursor <= end) {
        const px = x(cursor);
        const text = frozenEnd === null ? `${(cursor - end).toFixed(2)} s` : clock(cursor, true);
        const width = context.measureText(text).width + 10;
        const left = Math.min(Math.max(0, px - width / 2), box.width - width);
        context.fillStyle = colors.selected;
        context.beginPath();
        context.roundRect(left, 3, width, box.height - 8, 4);
        context.fill();
        context.fillStyle = colors.panel;
        context.textAlign = 'center';
        context.fillText(text, left + width / 2, box.height / 2 - 1);
      }
    });
    return () => {
      observer.disconnect();
      stop();
    };
  }, []);

  return (
    <div className="grid h-7 shrink-0 border-b border-border bg-panel" style={{ gridTemplateColumns: `${HEADER_WIDTH}px minmax(0,1fr)` }}>
      <div className="flex items-center border-r border-border/70 pl-4 text-[11px] text-text-faint">{label}</div>
      <div className="relative min-w-0">
        <canvas ref={canvasRef} data-track-plot className="absolute inset-0 block size-full" aria-hidden />
      </div>
    </div>
  );
}
