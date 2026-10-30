import { memo } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { usePicture } from '../../lib/pictures';
import { cn } from '../../lib/utils';
import type { TrackSize } from '../../store/useTracks';
import { HEADER_WIDTH } from './TrackRow';
import { openPictureWindow } from './PictureWindow';
import { PictureCanvas } from './PictureCanvas';
import { PlotCanvas } from './PlotCanvas';

/** Picture lanes are taller than signal lanes, so the picture stays readable. */
const PICTURE_HEIGHT: Record<TrackSize, number> = { compact: 120, normal: 220, large: 360 };

export interface PictureTrackRowProps {
  signalId: string;
  name: string;
  detail: string;
  /** The picture's width and height, from the descriptor's metadata, if known. */
  dimensions: { width: number; height: number } | null;
  selected: boolean;
  size: TrackSize;
  onSelect(signalId: string): void;
  onRemove(signalId: string): void;
}

/**
 * An image signal, such as a phone's camera, as a lane: its name and picture
 * rate on the left, its newest picture on the right. openDAQ's video
 * convention carries one picture per sample, so the lane shows the latest one
 * rather than a history.
 */
export const PictureTrackRow = memo(function PictureTrackRow(props: PictureTrackRowProps) {
  const { signalId, name, detail, dimensions, selected, size } = props;
  const picture = usePicture(signalId);
  const height = PICTURE_HEIGHT[size];

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
      <div className="flex min-w-0 flex-col justify-center border-r border-border/70 pr-2 pl-4">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className={cn('truncate text-[12.5px] font-semibold', selected && 'text-accent')}>{name}</span>
          <button
            type="button"
            title="Open in a new window"
            aria-label={`Open ${name} in a new window`}
            onClick={(event) => {
              event.stopPropagation();
              openPictureWindow(signalId, name, dimensions);
            }}
            className="ml-auto shrink-0 rounded p-0.5 text-text-faint hover:bg-sunken hover:text-accent"
          >
            <ExternalLink size={12} />
          </button>
          <span className="hidden shrink-0 items-center gap-0.5 group-hover/track:flex">
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
        <div className="truncate text-[11px] text-text-faint">{detail}</div>
        <div className="mt-0.5 flex items-baseline gap-1">
          <span className={cn('num tabular leading-none text-text', size === 'large' ? 'text-[22px]' : 'text-[16px]')}>
            {picture ? picture.rate.toFixed(1) : 'waiting'}
          </span>
          {picture ? <span className="text-[11px] text-text-faint">frames/s</span> : null}
        </div>
        <div className="mt-1 text-[11px] text-text-faint">
          {[dimensions ? `${dimensions.width} × ${dimensions.height}` : null, picture ? `${Math.round(picture.bytes / 1024)} kB` : null]
            .filter(Boolean)
            .join(' · ')}
        </div>
      </div>
      <div className="relative min-w-0 bg-[#101418]">
        {picture?.plot ? (
          <PlotCanvas data={picture.plot} label={`The newest plot of ${name}`} />
        ) : picture?.bitmap ? (
          <PictureCanvas bitmap={picture.bitmap} label={`The newest picture of ${name}`} />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center text-[12px] text-white/70">Waiting for the first frame</span>
        )}
      </div>
    </div>
  );
});
