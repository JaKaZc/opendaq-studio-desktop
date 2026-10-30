import { memo, useEffect, useRef } from 'react';
import { LineChart, X } from 'lucide-react';
import { formatNumber } from '../../lib/format';
import type { ColumnSeries } from '../../lib/trace';
import { cleanValue, nextRange, type Range } from '../../lib/tracks';
import { cn } from '../../lib/utils';
import { traces } from '../../store/traceStore';
import { useTracks, type TrackSize } from '../../store/useTracks';
import { arrayReading, peakOf } from './arrayValues';
import { drawArray, drawTrack } from './drawTrack';
import { addPainter, invalidate } from './trackLoop';

export const TRACK_HEIGHT: Record<TrackSize, number> = { compact: 44, normal: 76, large: 132 };
export const HEADER_WIDTH = 232;

export interface TrackRowProps {
  signalId: string;
  name: string;
  /** Device and unit, or the signal a function block output is computed from. */
  detail: string;
  unit: string;
  /** Produced by a function block from another signal. */
  derived: boolean;
  /** An array per sample, such as a spectrum, drawn as its latest array. */
  isArray: boolean;
  selected: boolean;
  size: TrackSize;
  onSelect(signalId: string): void;
  onRemove(signalId: string): void;
  onScope(signalId: string): void;
}

/**
 * One channel as a lane: its name and live value on the left, its history on
 * the right, drawn by the shared loop. React renders the row when its name or
 * selection changes; the samples never go through React.
 */
export const TrackRow = memo(function TrackRow(props: TrackRowProps) {
  const { signalId, name, detail, unit, derived, isArray, selected, size } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const valueRef = useRef<HTMLSpanElement | null>(null);
  const pictureRef = useRef(props);
  const height = TRACK_HEIGHT[size];

  useEffect(() => {
    pictureRef.current = props;
    invalidate();
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext('2d');
    if (!context) return;
    const box = { width: 0, height: 0, ratio: 1 };
    let range: Range | null = null;
    let columns: ColumnSeries | undefined;
    let shown = '';

    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      box.ratio = window.devicePixelRatio || 1;
      box.width = Math.max(1, Math.floor(entry.contentRect.width));
      box.height = Math.max(1, Math.floor(entry.contentRect.height));
      canvas.width = Math.round(box.width * box.ratio);
      canvas.height = Math.round(box.height * box.ratio);
      invalidate();
    });
    observer.observe(canvas);

    const stop = addPainter((frame) => {
      if (!box.width) return;
      const picture = pictureRef.current;
      if (picture.isArray) {
        const reading = arrayReading(signalId);
        let low = Infinity;
        let high = -Infinity;
        for (const item of reading?.values ?? []) {
          if (!Number.isFinite(item)) continue;
          low = Math.min(low, item);
          high = Math.max(high, item);
        }
        range = nextRange(range, low <= high ? { min: low, max: high } : null);
        drawArray(context, box.width, box.height, box.ratio, frame, reading?.values ?? null, range, picture.selected);
        const peak = reading ? peakOf(reading.values) : null;
        const text = peak ? formatNumber(peak.value, 5) : 'waiting';
        if (text !== shown && valueRef.current) {
          valueRef.current.textContent = text;
          shown = text;
        }
        return;
      }
      const buffer = traces.buffer(signalId);
      const cursor = useTracks.getState().cursor;
      if (buffer) {
        columns = buffer.toColumns(frame.start, frame.end, Math.max(1, Math.round(box.width / 1.5)), columns);
        range = nextRange(range, buffer.extent(frame.start, frame.end));
      }
      drawTrack(context, box.width, box.height, box.ratio, frame, {
        columns: buffer ? (columns ?? null) : null,
        range,
        cursor,
        selected: picture.selected,
      });

      // The value beside the lane: at the cursor while it is over the tracks, else the newest.
      let value: number | null = null;
      if (buffer) {
        if (cursor !== null) {
          const tolerance = ((frame.end - frame.start) / box.width) * 4 + (traces.get(signalId)?.sampleInterval ?? 0);
          value = buffer.valueAt(cursor, tolerance)?.value ?? null;
        } else {
          value = buffer.latestValue();
        }
      }
      const text = value === null ? (buffer ? '-' : 'waiting') : formatNumber(cleanValue(value, range ? range.max - range.min : 0), 5);
      if (text !== shown && valueRef.current) {
        valueRef.current.textContent = text;
        shown = text;
      }
    });

    return () => {
      observer.disconnect();
      stop();
    };
  }, [signalId]);

  return (
    <div
      role="row"
      aria-selected={selected}
      onClick={() => props.onSelect(signalId)}
      className={cn(
        'group/track relative grid cursor-default border-b border-border/70',
        selected ? 'bg-accent-soft/60' : 'hover:bg-sunken/50',
      )}
      style={{ gridTemplateColumns: `${HEADER_WIDTH}px minmax(0,1fr)`, height }}
    >
      {selected ? <span className="absolute inset-y-0 left-0 w-[3px] bg-accent" aria-hidden /> : null}
      <div
        className={cn('flex min-w-0 border-r border-border/70 pr-2 pl-4', size === 'compact' ? 'items-center gap-2' : 'flex-col justify-center')}
      >
        <div className="flex min-w-0 items-center gap-1.5">
          {derived ? <span className="shrink-0 text-[10px] text-text-faint" aria-label="Computed by a function block">↳</span> : null}
          <span className={cn('truncate text-[12.5px] font-semibold', selected && 'text-accent')}>{name}</span>
          <span className="ml-auto hidden shrink-0 items-center gap-0.5 group-hover/track:flex">
            {!isArray ? (
            <button
              type="button"
              title="Open in the Scope"
              aria-label={`Open ${name} in the Scope`}
              onClick={(event) => {
                event.stopPropagation();
                props.onScope(signalId);
              }}
              className="rounded p-0.5 text-text-faint hover:bg-sunken hover:text-text"
            >
              <LineChart size={12} />
            </button>
            ) : null}
            <button
              type="button"
              title="Remove the track"
              aria-label={`Remove the ${name} track`}
              onClick={(event) => {
                event.stopPropagation();
                props.onRemove(signalId);
              }}
              className="rounded p-0.5 text-text-faint hover:bg-sunken hover:text-err"
            >
              <X size={12} />
            </button>
          </span>
        </div>
        {size !== 'compact' ? <div className="truncate text-[11px] text-text-faint">{detail}</div> : null}
        <div className={cn('flex items-baseline gap-1', size === 'compact' ? 'ml-auto shrink-0' : 'mt-0.5')}>
          {isArray ? <span className="text-[11px] text-text-faint">peak</span> : null}
          <span
            ref={valueRef}
            className={cn(
              'num tabular leading-none text-text',
              size === 'large' ? 'text-[22px]' : size === 'normal' ? 'text-[16px]' : 'text-[13px]',
            )}
          >
            waiting
          </span>
          <span className="text-[11px] text-text-faint">{unit}</span>
        </div>
      </div>
      {/* Positioned, so the canvas size never feeds back into the row height. */}
      <div className="relative min-w-0">
        <canvas ref={canvasRef} className="absolute inset-0 block size-full" aria-label={isArray ? `The latest array of ${name}` : `${name} over the window`} />
      </div>
    </div>
  );
});
