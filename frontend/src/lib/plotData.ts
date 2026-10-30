/**
 * The Universal renderer's plot data: the lines, filled areas, texts and
 * pictures of a plot, which the UI draws itself instead of showing a picture
 * of it. Sharp at any size and a fraction of a picture's bytes. The format is
 * described in the README of opendaq-universal-function-blocks.
 */

const OP_POLYLINE = 1;
const OP_FILL = 2;
const OP_TEXT = 3;
const OP_PICTURE = 4;

/** The plot's own font size; texts are scaled with the plot. */
const FONT_SIZE = 16;
/** The distance from the top of a text's line to its baseline, in that font. */
const ASCENT = 15;

const decoder = new TextDecoder();

export function isPlotData(data: ArrayBuffer): boolean {
  const bytes = new Uint8Array(data, 0, Math.min(4, data.byteLength));
  return bytes.length === 4 && bytes[0] === 0x4f && bytes[1] === 0x44 && bytes[2] === 0x50 && bytes[3] === 0x4c;
}

/**
 * The pictures in a stream of plot data, such as a camera's, decoded once
 * each. A plot carries its pictures in every frame; each has an id, and a new
 * id is decoded in the background while the slot keeps showing the previous
 * one, so the picture never blanks.
 */
export class PlotPictures {
  private readonly slots = new Map<number, { id: number; image: ImageBitmap }>();
  private readonly pending = new Set<number>();

  constructor(private readonly onReady: () => void) {}

  /** The picture to draw in the plot's `slot`-th picture place. */
  get(slot: number, id: number, bytes: Uint8Array, type: string): ImageBitmap | undefined {
    const current = this.slots.get(slot);
    if (current?.id === id) return current.image;
    if (!this.pending.has(id)) {
      this.pending.add(id);
      createImageBitmap(new Blob([bytes.slice()], { type }))
        .then((image) => {
          this.pending.delete(id);
          const shown = this.slots.get(slot);
          if (shown && shown.id > id) {
            image.close();
            return;
          }
          shown?.image.close();
          this.slots.set(slot, { id, image });
          this.onReady();
        })
        .catch(() => this.pending.delete(id));
    }
    return current?.image;
  }

  close() {
    for (const { image } of this.slots.values()) image.close();
    this.slots.clear();
  }
}

/** The plot's own width and height, from its header. */
export function plotSize(data: ArrayBuffer): { width: number; height: number } {
  const view = new DataView(data);
  return { width: view.getUint16(8, true), height: view.getUint16(10, true) };
}

/**
 * Draws plot data on a 2D canvas context, scaled to fit `width` by `height`
 * CSS pixels and centred, for a screen with `ratio` device pixels per CSS
 * pixel.
 */
export function drawPlot(
  context: CanvasRenderingContext2D,
  data: ArrayBuffer,
  width: number,
  height: number,
  ratio: number,
  pictures?: PlotPictures,
) {
  const view = new DataView(data);
  if (!isPlotData(data) || view.getUint8(4) !== 1) return;
  const plotWidth = view.getUint16(8, true);
  const plotHeight = view.getUint16(10, true);
  const background = `rgb(${view.getUint8(12)},${view.getUint8(13)},${view.getUint8(14)})`;
  const count = view.getUint32(16, true);

  const scale = Math.min(width / plotWidth, height / plotHeight);
  const left = (width - plotWidth * scale) / 2;
  const top = (height - plotHeight * scale) / 2;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  context.setTransform(ratio * scale, 0, 0, ratio * scale, ratio * left, ratio * top);
  context.fillStyle = background;
  context.fillRect(0, 0, plotWidth, plotHeight);
  context.lineJoin = 'round';
  context.lineCap = 'round';
  context.textBaseline = 'alphabetic';

  let at = 20;
  const color = () => `rgb(${view.getUint8(at)},${view.getUint8(at + 1)},${view.getUint8(at + 2)})`;
  const coordinate = (offset: number) => view.getInt16(offset, true) / 8;
  const path = (moveFirst: boolean) => {
    const points = view.getUint32(at, true);
    at += 4;
    for (let i = 0; i < points; i++) {
      const x = coordinate(at);
      const y = coordinate(at + 2);
      if (i === 0 && moveFirst) context.moveTo(x, y);
      else context.lineTo(x, y);
      at += 4;
    }
    return points;
  };

  let slot = 0;
  for (let op = 0; op < count && at < data.byteLength; op++) {
    const type = view.getUint8(at);
    at += 1;
    const rgb = color();
    at += 3;
    if (type === OP_POLYLINE) {
      const dashed = view.getUint8(at) === 1;
      const thickness = view.getUint16(at + 1, true) / 16;
      at += 3;
      context.beginPath();
      path(true);
      context.strokeStyle = rgb;
      context.lineWidth = Math.max(thickness, 0.5);
      context.setLineDash(dashed ? [6, 4] : []);
      context.stroke();
    } else if (type === OP_FILL) {
      const alpha = view.getUint8(at) / 255;
      const baseline = coordinate(at + 1);
      at += 3;
      const start = at;
      const firstX = coordinate(start + 4);
      context.beginPath();
      context.moveTo(firstX, baseline);
      const points = path(false);
      const lastX = coordinate(start + 4 + (points - 1) * 4);
      context.lineTo(lastX, baseline);
      context.closePath();
      context.globalAlpha = alpha;
      context.fillStyle = rgb;
      context.fill();
      context.globalAlpha = 1;
    } else if (type === OP_TEXT) {
      const flags = view.getUint8(at);
      const x = coordinate(at + 1);
      const y = coordinate(at + 3);
      const length = view.getUint16(at + 5, true);
      const text = decoder.decode(new Uint8Array(data, at + 7, length));
      at += 7 + length;
      context.font = `${flags & 1 ? 'bold ' : ''}${FONT_SIZE}px "DejaVu Sans", Verdana, "Segoe UI", sans-serif`;
      context.textAlign = (['left', 'center', 'right'] as const)[(flags >> 1) & 3] ?? 'left';
      context.fillStyle = rgb;
      context.fillText(text, x, y + ASCENT);
    } else if (type === OP_PICTURE) {
      const format = view.getUint8(at);
      const id = view.getUint32(at + 1, true);
      const x = coordinate(at + 5);
      const y = coordinate(at + 7);
      const w = coordinate(at + 9);
      const h = coordinate(at + 11);
      const length = view.getUint32(at + 13, true);
      const bytes = new Uint8Array(data, at + 17, length);
      at += 17 + length;
      const image = pictures?.get(slot, id, bytes, format === 2 ? 'image/png' : 'image/jpeg');
      slot++;
      if (image) context.drawImage(image, x, y, w, h);
    } else {
      return;
    }
  }
}
