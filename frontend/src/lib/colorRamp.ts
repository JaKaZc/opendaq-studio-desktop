/**
 * A sequential colour ramp for magnitude, as a lookup table.
 *
 * The waterfall encodes level as colour, and the rule for magnitude is one hue,
 * lightness running monotonically from "nothing" to "most". A rainbow ramp is
 * the classic mistake here: its bright yellow band sits in the middle of the
 * scale and reads as a peak that is not there.
 *
 * So the ramp starts at the plot's own background - silence is invisible - runs
 * through the brand colour, and ends at a tint of it (lighter on a dark plot,
 * deeper on a light one). Interpolation is in OKLab, where equal steps look
 * equal; mixing in sRGB bunches the visible change into the middle of the scale.
 */

type Rgb = [number, number, number];
type Lab = [number, number, number];

/** `#rgb` / `#rrggbb` / `rgb(r, g, b)` to 0…255 channels; grey when unreadable. */
export function parseColor(input: string): Rgb {
  const text = input.trim();
  const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const digits = hex[1] as string;
    const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits;
    return [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16)) as Rgb;
  }
  const rgb = text.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return [128, 128, 128];
}

const toLinear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const fromLinear = (value: number) => {
  const c = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, c)) * 255);
};

export function rgbToOklab([r, g, b]: Rgb): Lab {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function oklabToRgb([L, a, b]: Lab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function mixLab(a: Lab, b: Lab, t: number): Lab {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Relative luminance, only to decide which way the far end of the ramp goes. */
function isDark(rgb: Rgb): boolean {
  return rgbToOklab(rgb)[0] < 0.5;
}

/** Where along the ramp the pure brand colour sits; the rest is its tint. */
const HUE_STOP = 0.62;

/**
 * `steps` RGB triples, packed, from the background (index 0) to the most
 * intense end. Cached per pair of colours: themes change rarely, frames often.
 */
const cache = new Map<string, Uint8ClampedArray>();

export function sequentialRamp(background: string, hue: string, steps = 256): Uint8ClampedArray {
  const key = `${background}|${hue}|${steps}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const low = parseColor(background);
  const mid = parseColor(hue);
  // Past the brand colour the ramp keeps going *away* from the background, so
  // lightness stays monotonic: towards white on a dark plot, towards black on a
  // light one.
  const far: Rgb = isDark(low) ? [255, 255, 255] : [0, 0, 0];
  const lowLab = rgbToOklab(low);
  const midLab = rgbToOklab(mid);
  const endLab = mixLab(midLab, rgbToOklab(far), isDark(low) ? 0.6 : 0.45);

  const table = new Uint8ClampedArray(steps * 3);
  for (let index = 0; index < steps; index += 1) {
    const t = index / (steps - 1);
    const lab = t <= HUE_STOP ? mixLab(lowLab, midLab, t / HUE_STOP) : mixLab(midLab, endLab, (t - HUE_STOP) / (1 - HUE_STOP));
    const [r, g, b] = oklabToRgb(lab);
    table[index * 3] = r;
    table[index * 3 + 1] = g;
    table[index * 3 + 2] = b;
  }
  cache.set(key, table);
  return table;
}

/** The OKLab lightness of each ramp step, for checking the ramp is monotonic. */
export function rampLightness(table: Uint8ClampedArray): number[] {
  const lightness: number[] = [];
  for (let index = 0; index < table.length; index += 3) {
    lightness.push(rgbToOklab([table[index] as number, table[index + 1] as number, table[index + 2] as number])[0]);
  }
  return lightness;
}
