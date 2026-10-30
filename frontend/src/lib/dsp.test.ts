import { describe, expect, it } from 'vitest';
import {
  computeSpectrum,
  estimateThd,
  floorPowerOfTwo,
  getFftPlan,
  isPowerOfTwo,
  windowCoefficients,
  windowGain,
} from './dsp';

/**
 * The spectrum path.
 *
 * A wrong FFT still draws a plausible-looking curve, so these check the numbers
 * an engineer would actually read off the screen: peak frequency, peak
 * amplitude, and that windowing does not silently attenuate the result.
 */

function sine(frequency: number, amplitude: number, sampleRate: number, count: number): Float64Array {
  const values = new Float64Array(count);
  for (let index = 0; index < count; index += 1) {
    values[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / sampleRate);
  }
  return values;
}

describe('power-of-two helpers', () => {
  it('recognises powers of two', () => {
    expect(isPowerOfTwo(1024)).toBe(true);
    expect(isPowerOfTwo(1000)).toBe(false);
    expect(isPowerOfTwo(1)).toBe(false);
  });

  it('rounds down to the nearest power of two', () => {
    expect(floorPowerOfTwo(1000)).toBe(512);
    expect(floorPowerOfTwo(1024)).toBe(1024);
    expect(floorPowerOfTwo(0)).toBe(2);
  });
});

describe('window functions', () => {
  it('leaves the signal untouched with a rectangular window', () => {
    const coefficients = windowCoefficients('rectangular', 64);
    expect([...coefficients].every((value) => value === 1)).toBe(true);
    expect(windowGain(coefficients)).toBeCloseTo(1, 9);
  });

  it('has the textbook coherent gain for Hann', () => {
    // A Hann window's coherent gain is 0.5, which is exactly what the amplitude
    // correction has to divide out.
    expect(windowGain(windowCoefficients('hann', 4096))).toBeCloseTo(0.5, 3);
  });

  it('tapers to zero at both ends for Hann', () => {
    const coefficients = windowCoefficients('hann', 128);
    expect(coefficients[0]).toBeCloseTo(0, 9);
    expect(coefficients[127]).toBeCloseTo(0, 9);
    expect(coefficients[64]).toBeGreaterThan(0.9);
  });

  it('caches by kind and size', () => {
    expect(windowCoefficients('hann', 256)).toBe(windowCoefficients('hann', 256));
    expect(windowCoefficients('hann', 256)).not.toBe(windowCoefficients('hamming', 256));
  });
});

describe('FftPlan', () => {
  it('refuses a size that is not a power of two', () => {
    expect(() => getFftPlan(1000)).toThrow(/power of two/i);
  });

  it('reuses a plan for the same size', () => {
    expect(getFftPlan(512)).toBe(getFftPlan(512));
  });

  it('puts a DC input entirely in bin zero', () => {
    const plan = getFftPlan(64);
    const magnitudes = plan.magnitudes(new Float64Array(64).fill(2));
    expect(magnitudes[0]).toBeCloseTo(2, 6);
    for (let bin = 1; bin < magnitudes.length; bin += 1) {
      expect(magnitudes[bin]).toBeCloseTo(0, 6);
    }
  });

  it('reports the true amplitude of a bin-centred sine', () => {
    const size = 1024;
    // Exactly 16 periods in the frame, so the tone lands on bin 16 with no leakage.
    const plan = getFftPlan(size);
    const magnitudes = plan.magnitudes(sine(16, 3, size, size));
    expect(magnitudes[16]).toBeCloseTo(3, 4);
  });
});

describe('computeSpectrum', () => {
  const sampleRate = 1000;
  const samples = sine(10, 5, sampleRate, 4096);

  it('finds the tone at the right frequency and amplitude', () => {
    const result = computeSpectrum(samples, sampleRate, { decibels: false, smoothing: 0 });
    expect(result).not.toBeNull();
    expect(result!.sampleRate).toBe(sampleRate);
    expect(result!.size).toBe(4096);
    expect(result!.binWidth).toBeCloseTo(sampleRate / 4096, 9);

    expect(result!.peak).not.toBeNull();
    expect(result!.peak!.frequency).toBeCloseTo(10, 0);
    // Window gain is corrected, so a 5 V sine reads 5 V and not 2.5 V.
    expect(result!.peak!.amplitude).toBeCloseTo(5, 1);
  });

  it('converts to dB relative to the reference', () => {
    const result = computeSpectrum(samples, sampleRate, { decibels: true, smoothing: 0 });
    const peakDb = Math.max(...result!.magnitudes.slice(1));
    // 20*log10(5) = 13.98 dB
    expect(peakDb).toBeCloseTo(20 * Math.log10(5), 1);
  });

  it('reports the peak in linear units even when the output is dB', () => {
    const result = computeSpectrum(samples, sampleRate, { decibels: true, smoothing: 0 });
    expect(result!.peak!.amplitude).toBeCloseTo(5, 1);
  });

  it('removes a DC offset so it does not swamp the low bins', () => {
    const offset = samples.map((value) => value + 100) as unknown as Float64Array;
    const result = computeSpectrum(Float64Array.from(offset), sampleRate, {
      decibels: false,
      smoothing: 0,
    });
    expect(result!.peak!.frequency).toBeCloseTo(10, 0);
    expect(result!.peak!.amplitude).toBeCloseTo(5, 1);
  });

  it('uses the newest samples when given more than the transform length', () => {
    const long = sine(10, 5, sampleRate, 5000);
    const result = computeSpectrum(long, sampleRate, { decibels: false, smoothing: 0 });
    expect(result!.size).toBe(4096);
  });

  it('refuses input that is too short or has no rate', () => {
    expect(computeSpectrum(new Float64Array(4), sampleRate)).toBeNull();
    expect(computeSpectrum(samples, 0)).toBeNull();
  });

  it('averages towards the previous frame when smoothing is on', () => {
    const first = computeSpectrum(samples, sampleRate, { decibels: false, smoothing: 0 })!;
    const previous = new Float64Array(first.magnitudes.length).fill(0);
    const smoothed = computeSpectrum(samples, sampleRate, {
      decibels: false,
      smoothing: 0.9,
      previous,
    })!;
    const peakBin = Math.round(10 / first.binWidth);
    // Nine parts of a zeroed history to one part new data.
    expect(smoothed.magnitudes[peakBin]!).toBeLessThan(first.magnitudes[peakBin]! * 0.2);
  });

  it('settles on the unsmoothed spectrum when averaging in dB, rather than collapsing', () => {
    // The default settings: dB on, averaging on, each frame fed the last
    // result. A tone plus a little noise, so there are quiet bins to lose.
    const noisy = samples.map((value, index) => value + 0.05 * ((Math.sin(index * 12.9898) * 43758.5453) % 1));
    const reference = computeSpectrum(noisy, sampleRate, { decibels: true, smoothing: 0 })!;

    let previous: Float64Array | null = null;
    let result = reference;
    for (let frame = 0; frame < 20; frame += 1) {
      result = computeSpectrum(noisy, sampleRate, { decibels: true, smoothing: 0.3, previous })!;
      previous = result.magnitudes.slice();
    }

    // Same input every frame, so the average converges to the plain spectrum -
    // including the quiet bins, which used to be pinned at the -300 dB floor.
    const quietBin = Math.round(200 / reference.binWidth);
    expect(reference.magnitudes[quietBin]!).toBeGreaterThan(-200);
    expect(result.magnitudes[quietBin]!).toBeCloseTo(reference.magnitudes[quietBin]!, 1);
    const peakBin = Math.round(10 / reference.binWidth);
    expect(result.magnitudes[peakBin]!).toBeCloseTo(reference.magnitudes[peakBin]!, 1);
  });
});

describe('estimateThd', () => {
  it('is near zero for a pure tone', () => {
    const result = computeSpectrum(sine(50, 1, 4096, 4096), 4096, { decibels: false, smoothing: 0 })!;
    const thd = estimateThd(result.magnitudes, result.binWidth, 50);
    expect(thd).not.toBeNull();
    expect(thd!).toBeLessThan(0.01);
  });

  it('measures a deliberately added harmonic', () => {
    const size = 4096;
    const rate = 4096;
    const fundamental = sine(50, 1, rate, size);
    const harmonic = sine(100, 0.1, rate, size);
    const mixed = Float64Array.from(fundamental, (value, index) => value + harmonic[index]!);

    const result = computeSpectrum(mixed, rate, { decibels: false, smoothing: 0 })!;
    const thd = estimateThd(result.magnitudes, result.binWidth, 50);
    // A second harmonic at 10% of the fundamental is 10% distortion.
    expect(thd!).toBeCloseTo(0.1, 1);
  });

  it('returns null when the fundamental is not present', () => {
    const result = computeSpectrum(new Float64Array(1024), 1000, { decibels: false })!;
    expect(estimateThd(result.magnitudes, result.binWidth, 50)).toBeNull();
  });
});
