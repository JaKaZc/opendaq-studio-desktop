/**
 * Signal processing for the spectrum view: window functions and an FFT.
 *
 * This is done in the browser rather than server-side on purpose.  The samples
 * are already in the client's ring buffer, so computing here costs no bandwidth,
 * adds no latency, and lets the window length, window function and averaging
 * change instantly as the user drags a control.
 *
 * The transform is an iterative radix-2 Cooley-Tukey FFT on Float64Arrays: no
 * dependency, no allocation per frame once the plan is reused, and fast enough
 * for the 1k-32k sizes a scope needs (a 16k transform is well under a
 * millisecond).
 */

export type WindowFunction = 'rectangular' | 'hann' | 'hamming' | 'blackman' | 'flatTop';

export const WINDOW_FUNCTIONS: { id: WindowFunction; label: string; note: string }[] = [
  { id: 'hann', label: 'Hann', note: 'Good general purpose balance' },
  { id: 'hamming', label: 'Hamming', note: 'Slightly narrower main lobe' },
  { id: 'blackman', label: 'Blackman', note: 'Lowest side lobes' },
  { id: 'flatTop', label: 'Flat top', note: 'Most accurate amplitude' },
  { id: 'rectangular', label: 'None', note: 'No windowing (leakage)' },
];

/** Window coefficients of length `size`, cached because they never change. */
const windowCache = new Map<string, Float64Array>();

export function windowCoefficients(kind: WindowFunction, size: number): Float64Array {
  const key = `${kind}:${size}`;
  const cached = windowCache.get(key);
  if (cached) return cached;

  const coefficients = new Float64Array(size);
  const last = Math.max(1, size - 1);
  for (let index = 0; index < size; index += 1) {
    const ratio = index / last;
    const angle = 2 * Math.PI * ratio;
    switch (kind) {
      case 'rectangular':
        coefficients[index] = 1;
        break;
      case 'hann':
        coefficients[index] = 0.5 - 0.5 * Math.cos(angle);
        break;
      case 'hamming':
        coefficients[index] = 0.54 - 0.46 * Math.cos(angle);
        break;
      case 'blackman':
        coefficients[index] = 0.42 - 0.5 * Math.cos(angle) + 0.08 * Math.cos(2 * angle);
        break;
      case 'flatTop':
        coefficients[index] =
          0.21557895 -
          0.41663158 * Math.cos(angle) +
          0.277263158 * Math.cos(2 * angle) -
          0.083578947 * Math.cos(3 * angle) +
          0.006947368 * Math.cos(4 * angle);
        break;
    }
  }
  windowCache.set(key, coefficients);
  return coefficients;
}

/**
 * Coherent gain of a window, used to undo the amplitude loss it introduces.
 *
 * Without this correction a Hann-windowed sine reads about 6 dB low, which makes
 * the spectrum useless for amplitude measurement.
 */
export function windowGain(coefficients: Float64Array): number {
  let sum = 0;
  for (let index = 0; index < coefficients.length; index += 1) sum += coefficients[index] as number;
  return sum / coefficients.length;
}

/** Largest power of two that is <= `value`, at least 2. */
export function floorPowerOfTwo(value: number): number {
  if (value < 2) return 2;
  return 2 ** Math.floor(Math.log2(value));
}

export function isPowerOfTwo(value: number): boolean {
  return value >= 2 && (value & (value - 1)) === 0;
}

/**
 * A reusable radix-2 FFT plan.
 *
 * Bit-reversal indices and twiddle factors are precomputed once per size, which
 * is what makes a 20 Hz spectrum update cheap.
 */
export class FftPlan {
  readonly size: number;
  private readonly reversed: Uint32Array;
  private readonly cosines: Float64Array;
  private readonly sines: Float64Array;
  private readonly real: Float64Array;
  private readonly imaginary: Float64Array;

  constructor(size: number) {
    if (!isPowerOfTwo(size)) {
      throw new Error(`FFT size must be a power of two, got ${size}`);
    }
    this.size = size;
    this.real = new Float64Array(size);
    this.imaginary = new Float64Array(size);

    const bits = Math.log2(size);
    this.reversed = new Uint32Array(size);
    for (let index = 0; index < size; index += 1) {
      let value = index;
      let result = 0;
      for (let bit = 0; bit < bits; bit += 1) {
        result = (result << 1) | (value & 1);
        value >>= 1;
      }
      this.reversed[index] = result;
    }

    const half = size >> 1;
    this.cosines = new Float64Array(half);
    this.sines = new Float64Array(half);
    for (let index = 0; index < half; index += 1) {
      const angle = (-2 * Math.PI * index) / size;
      this.cosines[index] = Math.cos(angle);
      this.sines[index] = Math.sin(angle);
    }
  }

  /**
   * Magnitude spectrum of a real input.
   *
   * Returns amplitudes in input units for the bins `0 .. size/2`, already scaled
   * so a full-scale sine reads its true amplitude.
   */
  magnitudes(input: Float64Array, out?: Float64Array): Float64Array {
    const { size, real, imaginary, reversed, cosines, sines } = this;
    const bins = (size >> 1) + 1;
    const result = out && out.length === bins ? out : new Float64Array(bins);

    // Load in bit-reversed order so the butterflies can run in place.
    for (let index = 0; index < size; index += 1) {
      real[index] = input[reversed[index] as number] ?? 0;
      imaginary[index] = 0;
    }

    for (let span = 2; span <= size; span <<= 1) {
      const half = span >> 1;
      const stride = size / span;
      for (let start = 0; start < size; start += span) {
        for (let offset = 0; offset < half; offset += 1) {
          const twiddle = offset * stride;
          const cos = cosines[twiddle] as number;
          const sin = sines[twiddle] as number;
          const a = start + offset;
          const b = a + half;
          const realB = real[b] as number;
          const imaginaryB = imaginary[b] as number;
          const rotatedReal = realB * cos - imaginaryB * sin;
          const rotatedImaginary = realB * sin + imaginaryB * cos;
          real[b] = (real[a] as number) - rotatedReal;
          imaginary[b] = (imaginary[a] as number) - rotatedImaginary;
          real[a] = (real[a] as number) + rotatedReal;
          imaginary[a] = (imaginary[a] as number) + rotatedImaginary;
        }
      }
    }

    // Single-sided amplitude: DC and Nyquist keep 1/N, the rest double.
    for (let bin = 0; bin < bins; bin += 1) {
      const magnitude = Math.hypot(real[bin] as number, imaginary[bin] as number);
      const isEdge = bin === 0 || bin === size >> 1;
      result[bin] = (magnitude / size) * (isEdge ? 1 : 2);
    }
    return result;
  }
}

const planCache = new Map<number, FftPlan>();

export function getFftPlan(size: number): FftPlan {
  let plan = planCache.get(size);
  if (!plan) {
    plan = new FftPlan(size);
    planCache.set(size, plan);
  }
  return plan;
}

export interface SpectrumResult {
  /** Amplitude per bin, in signal units (or dB when `decibels` was set). */
  magnitudes: Float64Array;
  /** Hz per bin. */
  binWidth: number;
  /** Bin count, i.e. `size / 2 + 1`. */
  bins: number;
  size: number;
  sampleRate: number;
  peak: { frequency: number; amplitude: number } | null;
}

export interface SpectrumOptions {
  windowFunction?: WindowFunction;
  /** Convert amplitudes to dB relative to `dbReference`. */
  decibels?: boolean;
  dbReference?: number;
  /** Exponential averaging across calls, 0 = none, 0.9 = heavy smoothing. */
  smoothing?: number;
  previous?: Float64Array | null;
}

/** Amplitude floor for the dB conversion: about -300 dBFS, well below any real noise. */
const DB_FLOOR = 1e-15;

/**
 * Compute a single-sided amplitude spectrum.
 *
 * `samples` must be uniformly sampled - the caller checks that its trace is in
 * raw (undecimated) mode, because min/max buckets have no usable sample grid.
 */
export function computeSpectrum(
  samples: Float64Array,
  sampleRate: number,
  options: SpectrumOptions = {},
): SpectrumResult | null {
  const {
    windowFunction = 'hann',
    decibels = true,
    dbReference = 1,
    smoothing = 0,
    previous = null,
  } = options;

  const size = floorPowerOfTwo(samples.length);
  if (size < 8 || !Number.isFinite(sampleRate) || sampleRate <= 0) return null;

  // Use the newest `size` samples so the spectrum tracks the live trace.
  const framed = new Float64Array(size);
  framed.set(samples.subarray(samples.length - size));

  // Removing the mean keeps a large DC offset from swamping the low bins.
  let mean = 0;
  for (let index = 0; index < size; index += 1) mean += framed[index] as number;
  mean /= size;

  const coefficients = windowCoefficients(windowFunction, size);
  for (let index = 0; index < size; index += 1) {
    framed[index] = ((framed[index] as number) - mean) * (coefficients[index] as number);
  }

  const plan = getFftPlan(size);
  const magnitudes = plan.magnitudes(framed);

  const gain = windowGain(coefficients) || 1;
  for (let bin = 0; bin < magnitudes.length; bin += 1) {
    magnitudes[bin] = (magnitudes[bin] as number) / gain;
  }

  // Find the peak on the linear amplitudes, before any dB conversion.
  let peak: SpectrumResult['peak'] = null;
  const binWidth = sampleRate / size;
  for (let bin = 1; bin < magnitudes.length; bin += 1) {
    const amplitude = magnitudes[bin] as number;
    if (!peak || amplitude > peak.amplitude) {
      peak = { frequency: bin * binWidth, amplitude };
    }
  }

  const reference = dbReference > 0 ? dbReference : 1;

  if (smoothing > 0 && previous && previous.length === magnitudes.length) {
    const alpha = Math.min(0.95, Math.max(0, smoothing));
    // Average in linear amplitude, which is what `magnitudes` holds here.
    // `previous` is the last *result*, so with `decibels` set it is in dB and
    // has to come back out of them first. Blending the two directly averaged
    // -40 (dB) with 0.01 (volts), clamped the negative result to the -300 dB
    // floor, and fed that back in: after one frame every bin but the strongest
    // sat at -300 dB for good.
    for (let bin = 0; bin < magnitudes.length; bin += 1) {
      const last = previous[bin] as number;
      const lastLinear = decibels ? reference * 10 ** (last / 20) : last;
      magnitudes[bin] = lastLinear * alpha + (magnitudes[bin] as number) * (1 - alpha);
    }
  }

  if (decibels) {
    for (let bin = 0; bin < magnitudes.length; bin += 1) {
      magnitudes[bin] = 20 * Math.log10(Math.max(DB_FLOOR, (magnitudes[bin] as number) / reference));
    }
  }

  return {
    magnitudes,
    binWidth,
    bins: magnitudes.length,
    size,
    sampleRate,
    peak,
  };
}

/** Total harmonic distortion estimate, as a fraction of the fundamental. */
export function estimateThd(
  magnitudes: Float64Array,
  binWidth: number,
  fundamental: number,
  harmonics = 5,
): number | null {
  if (fundamental <= 0 || binWidth <= 0) return null;
  const at = (frequency: number): number => {
    const bin = Math.round(frequency / binWidth);
    if (bin < 1 || bin >= magnitudes.length) return 0;
    // Take the local maximum so a small frequency error does not read as zero.
    let best = 0;
    for (let offset = -1; offset <= 1; offset += 1) {
      const value = magnitudes[bin + offset];
      if (value !== undefined && value > best) best = value;
    }
    return best;
  };

  const base = at(fundamental);
  if (base <= 0) return null;
  let sumSquares = 0;
  for (let order = 2; order <= harmonics + 1; order += 1) {
    const amplitude = at(fundamental * order);
    sumSquares += amplitude * amplitude;
  }
  return Math.sqrt(sumSquares) / base;
}
