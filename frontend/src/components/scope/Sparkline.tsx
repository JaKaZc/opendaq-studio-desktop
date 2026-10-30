import { useEffect, useRef, useState } from 'react';
import { formatEngineering } from '../../lib/format';
import { traces } from '../../store/traceStore';
import { useElementSize } from '../ui/Layout';
import {
  drawColumnSeries,
  drawEmptyMessage,
  gapToleranceColumns,
  drawFrame,
  makeYMapper,
  padScale,
  readPlotTheme,
  setupCanvas,
  type PlotBox,
} from './plotting';
import type { ColumnSeries } from '../../lib/trace';

/**
 * A compact live trace for the signal list.
 *
 * It reads the shared trace buffers directly inside `requestAnimationFrame`, so
 * the whole signal list can show sparklines without a single React render per
 * frame.  The column series is reused between frames to avoid allocating arrays
 * 60 times a second.
 */
export function Sparkline({
  signalId,
  unit,
  height = 64,
  windowSeconds = 1,
}: {
  signalId: string;
  unit?: string;
  height?: number;
  windowSeconds?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const seriesRef = useRef<ColumnSeries | undefined>(undefined);
  const { ref: boxRef, width } = useElementSize<HTMLDivElement>();
  const [readout, setReadout] = useState<{ value: number | null; waiting: boolean }>({
    value: null,
    waiting: true,
  });

  useEffect(() => {
    let frame = 0;
    let lastVersion = -1;
    let lastReadout = 0;

    const render = () => {
      frame = requestAnimationFrame(render);
      const canvas = canvasRef.current;
      const container = boxRef.current;
      if (!canvas || !container) return;

      // Nothing new to draw: skip the work entirely.
      if (traces.dataVersion === lastVersion) return;
      lastVersion = traces.dataVersion;

      const setup = setupCanvas(canvas, container.clientWidth, height);
      if (!setup) return;
      const { context } = setup;
      const theme = readPlotTheme(container);

      context.fillStyle = theme.background;
      context.fillRect(0, 0, setup.width, setup.height);

      const box: PlotBox = { left: 0.5, top: 0.5, width: setup.width - 1, height: setup.height - 1 };
      const trace = traces.get(signalId);
      const latest = trace?.buffer.latestTime() ?? null;

      if (!trace || latest === null || trace.buffer.isEmpty) {
        drawEmptyMessage(context, box, 'waiting for samples…', theme.text);
        drawFrame(context, box, theme.grid);
        if (Date.now() - lastReadout > 250) {
          lastReadout = Date.now();
          setReadout({ value: null, waiting: true });
        }
        return;
      }

      const start = latest - windowSeconds;
      const extent = trace.buffer.extent(start, latest) ?? { min: -1, max: 1 };
      const scale = padScale(extent.min, extent.max, 0.12);
      const columns = Math.max(2, Math.floor(box.width));
      const series = trace.buffer.toColumns(start, latest, columns, seriesRef.current);
      seriesRef.current = series;

      const toY = makeYMapper(box, scale);

      // A zero line, when zero is inside the visible range.
      if (scale.min < 0 && scale.max > 0) {
        context.save();
        context.strokeStyle = theme.grid;
        context.lineWidth = 1;
        context.beginPath();
        const zero = Math.round(toY(0)) + 0.5;
        context.moveTo(box.left, zero);
        context.lineTo(box.left + box.width, zero);
        context.stroke();
        context.restore();
      }

      const secondsPerColumn = windowSeconds / columns;
      drawColumnSeries(
        context,
        series,
        box,
        toY,
        brandColor(container),
        1.2,
        gapToleranceColumns(trace.sampleInterval, secondsPerColumn),
      );
      drawFrame(context, box, theme.grid);

      if (Date.now() - lastReadout > 200) {
        lastReadout = Date.now();
        setReadout({ value: trace.buffer.latestValue(), waiting: false });
      }
    };

    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signalId, height, windowSeconds, width]);

  return (
    <div ref={boxRef} className="relative w-full">
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height }}
        className="block rounded border border-border"
        role="img"
        aria-label={`Live preview of ${signalId}`}
      />
      <span className="num pointer-events-none absolute top-1 right-1.5 rounded bg-panel/80 px-1 text-[10.5px] text-text-muted">
        {readout.waiting || readout.value === null ? '—' : formatEngineering(readout.value, unit, 4)}
      </span>
    </div>
  );
}

/** The brand colour, resolved from CSS so it follows the theme. */
function brandColor(element: HTMLElement): string {
  return getComputedStyle(element).getPropertyValue('--color-brand').trim() || '#f15d31';
}
