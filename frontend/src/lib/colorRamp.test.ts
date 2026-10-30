import { describe, expect, it } from 'vitest';
import { oklabToRgb, parseColor, rampLightness, rgbToOklab, sequentialRamp } from './colorRamp';

/**
 * The waterfall reads level as colour, so the ramp has to be *monotonic* in
 * lightness: any step that gets darker again where it should get lighter reads
 * as a dip in the signal that is not there.
 */

// The theme's own tokens, light and dark (index.css).
const LIGHT = { background: '#ffffff', brand: '#f15d31' };
const DARK = { background: '#0a141c', brand: '#ff7048' };

function isMonotonic(values: number[], direction: 'up' | 'down'): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const step = (values[index] as number) - (values[index - 1] as number);
    // A hair of tolerance for 8-bit rounding.
    if (direction === 'up' ? step < -0.002 : step > 0.002) return false;
  }
  return true;
}

describe('sequentialRamp', () => {
  it('starts at the plot background, so silence is invisible', () => {
    const table = sequentialRamp(DARK.background, DARK.brand);
    expect([table[0], table[1], table[2]]).toEqual(parseColor(DARK.background));
  });

  it('gets steadily lighter on a dark plot', () => {
    expect(isMonotonic(rampLightness(sequentialRamp(DARK.background, DARK.brand)), 'up')).toBe(true);
  });

  it('gets steadily darker on a light plot', () => {
    expect(isMonotonic(rampLightness(sequentialRamp(LIGHT.background, LIGHT.brand)), 'down')).toBe(true);
  });

  it('spans a usable range of lightness in both themes', () => {
    for (const theme of [LIGHT, DARK]) {
      const lightness = rampLightness(sequentialRamp(theme.background, theme.brand));
      const span = Math.abs((lightness.at(-1) as number) - (lightness[0] as number));
      expect(span).toBeGreaterThan(0.4);
    }
  });
});

describe('OKLab conversion', () => {
  it('round-trips a colour', () => {
    for (const colour of ['#f15d31', '#00335a', '#7fb2e5', '#ffffff', '#000000']) {
      expect(oklabToRgb(rgbToOklab(parseColor(colour)))).toEqual(parseColor(colour));
    }
  });

  it('parses the forms a computed style can return', () => {
    expect(parseColor('#fff')).toEqual([255, 255, 255]);
    expect(parseColor('rgb(10, 20, 30)')).toEqual([10, 20, 30]);
    expect(parseColor('not a colour')).toEqual([128, 128, 128]);
  });
});
