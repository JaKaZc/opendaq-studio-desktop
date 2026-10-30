import type { ColumnSeries } from '../../lib/trace';
import type { Range } from '../../lib/tracks';
import { tickStep } from '../../lib/tracks';
import type { Frame } from './trackLoop';

export interface TrackPicture {
  columns: ColumnSeries | null;
  range: Range | null;
  cursor: number | null;
  selected: boolean;
}

/**
 * Draw one track: the min-max envelope of every pixel column, so a 20 kHz
 * signal shows every spike, in a quiet grey that takes colour when the track
 * is selected.
 */
export function drawTrack(ctx: CanvasRenderingContext2D, width: number, height: number, ratio: number, frame: Frame, picture: TrackPicture): void {
  const { colors } = frame;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const span = frame.end - frame.start;
  const x = (time: number) => ((time - frame.start) / span) * width;

  // Time grid, in step with the ruler: a line every step back from the right edge.
  const step = tickStep(span, Math.max(2, Math.floor(width / 90)));
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let back = 0; back <= span; back += step) {
    const px = Math.round(x(frame.end - back)) + 0.5;
    ctx.moveTo(px, 0);
    ctx.lineTo(px, height);
  }
  ctx.stroke();

  const range = picture.range;
  const pad = 4;
  const y = range ? (value: number) => pad + ((range.max - value) / (range.max - range.min)) * (height - pad * 2) : () => height / 2;

  const tone = picture.selected ? colors.selected : colors.wave;
  const columns = picture.columns;
  if (columns && range) {
    const count = columns.count;
    const scale = width / count;
    // The envelope: a filled band between the lowest and highest sample of each column.
    ctx.fillStyle = tone;
    ctx.globalAlpha = 0.28;
    ctx.beginPath();
    let open = false;
    let runStart = 0;
    const closeRun = (end: number) => {
      for (let back = end; back >= runStart; back -= 1) {
        if (columns.filled[back]) ctx.lineTo(back * scale + scale / 2, y(columns.mins[back] as number) + 0.5);
      }
      ctx.closePath();
    };
    for (let index = 0; index < count; index += 1) {
      if (!columns.filled[index]) {
        if (open) {
          closeRun(index - 1);
          open = false;
        }
        continue;
      }
      const px = index * scale + scale / 2;
      const top = y(columns.maxs[index] as number) - 0.5;
      if (!open) {
        ctx.moveTo(px, top);
        open = true;
        runStart = index;
      } else {
        ctx.lineTo(px, top);
      }
    }
    if (open) closeRun(count - 1);
    ctx.fill();

    // And the line through the newest value of each column, for a crisp edge.
    // It bridges empty columns: a function block that gives one result a second
    // is a line through its results, not a row of isolated points.
    ctx.globalAlpha = 1;
    ctx.strokeStyle = tone;
    ctx.lineWidth = picture.selected ? 1.5 : 1.2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let drawing = false;
    let filled = 0;
    for (let index = 0; index < count; index += 1) {
      if (!columns.filled[index]) continue;
      filled += 1;
      const px = index * scale + scale / 2;
      const py = y(columns.lasts[index] as number);
      if (drawing) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
      drawing = true;
    }
    ctx.stroke();

    // Sparse results get a dot each, so every value can be seen.
    if (filled > 0 && filled < count / 4) {
      ctx.fillStyle = tone;
      for (let index = 0; index < count; index += 1) {
        if (!columns.filled[index]) continue;
        ctx.beginPath();
        ctx.arc(index * scale + scale / 2, y(columns.lasts[index] as number), 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  if (picture.cursor !== null && picture.cursor >= frame.start && picture.cursor <= frame.end) {
    ctx.strokeStyle = colors.text;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(Math.round(x(picture.cursor)) + 0.5, 0);
    ctx.lineTo(Math.round(x(picture.cursor)) + 0.5, height);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

/**
 * Draw one array value across the lane: element 0 at the left, the last
 * element at the right. Used for signals that carry an array per sample, such
 * as an FFT block's spectrum, where the horizontal axis is the element index
 * and not time.
 */
export function drawArray(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  ratio: number,
  frame: Frame,
  values: readonly number[] | null,
  range: Range | null,
  selected: boolean,
): void {
  const { colors } = frame;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const pad = 4;
  ctx.fillStyle = colors.text;
  ctx.font = '500 9.5px Roboto, system-ui, sans-serif';
  ctx.textBaseline = 'bottom';
  if (!values || values.length < 2 || !range) {
    ctx.textAlign = 'left';
    ctx.fillText('Waiting for the first array', 6, height - 4);
    return;
  }
  const span = range.max - range.min || 1;
  const x = (index: number) => (index / (values.length - 1)) * width;
  const y = (value: number) => pad + ((range.max - value) / span) * (height - pad * 2);
  const tone = selected ? colors.selected : colors.wave;

  ctx.beginPath();
  ctx.moveTo(0, height);
  for (let i = 0; i < values.length; i += 1) ctx.lineTo(x(i), y(values[i] as number));
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fillStyle = tone;
  ctx.globalAlpha = 0.18;
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.beginPath();
  for (let i = 0; i < values.length; i += 1) {
    if (i === 0) ctx.moveTo(x(i), y(values[i] as number));
    else ctx.lineTo(x(i), y(values[i] as number));
  }
  ctx.strokeStyle = tone;
  ctx.lineWidth = selected ? 1.5 : 1.2;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // The largest element, marked, so a single spike near an edge is not missed.
  let peak = -1;
  for (let i = 0; i < values.length; i += 1) {
    const item = values[i] as number;
    if (Number.isFinite(item) && (peak < 0 || item > (values[peak] as number))) peak = i;
  }
  if (peak >= 0) {
    const px = x(peak);
    const py = y(values[peak] as number);
    ctx.fillStyle = tone;
    ctx.beginPath();
    ctx.arc(px, py, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = colors.text;
    ctx.textBaseline = 'top';
    ctx.textAlign = px > width - 90 ? 'right' : 'left';
    ctx.fillText(`element ${peak}`, px > width - 90 ? px - 6 : px + 6, Math.max(2, py - 4));
    ctx.textBaseline = 'bottom';
  }

  // The axis is the element index, said in the lane so it is not read as time.
  ctx.fillStyle = colors.text;
  ctx.textAlign = 'left';
  ctx.fillText('0', 4, height - 2);
  ctx.textAlign = 'right';
  ctx.fillText(`${values.length - 1}`, width - 4, height - 2);
}
