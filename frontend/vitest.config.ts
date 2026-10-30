import { defineConfig } from 'vitest/config';

/**
 * Unit tests cover the pure logic - frame decoding, ring buffers, the FFT, tree
 * projections and formatting - which is where a subtle bug would be invisible in
 * the UI. Component rendering is verified against the real backend instead.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    reporters: 'dot',
  },
});
