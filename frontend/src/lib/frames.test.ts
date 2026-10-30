import { describe, expect, it } from 'vitest';
import { decodeFrame, FrameDecodeError, FRAME_VERSION } from './frames';
import type { SampleBlock } from './types';

/**
 * Frame decoding.
 *
 * The wire format is the one place where backend and frontend agree on raw
 * bytes; a mistake here is silent corruption rather than an error, so the
 * encoder is reimplemented in the test and both directions are checked.
 */

function encodeFrame(header: unknown, payloads: Uint8Array[], version = FRAME_VERSION): ArrayBuffer {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const body = payloads.reduce((total, part) => total + part.byteLength, 0);
  const buffer = new ArrayBuffer(10 + json.byteLength + body);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  bytes.set(new TextEncoder().encode('ODQV'), 0);
  view.setUint16(4, version, true);
  view.setUint32(6, json.byteLength, true);
  bytes.set(json, 10);

  let offset = 10 + json.byteLength;
  for (const payload of payloads) {
    bytes.set(payload, offset);
    offset += payload.byteLength;
  }
  return buffer;
}

function floats(values: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(values).buffer);
}

function block(overrides: Partial<SampleBlock>): SampleBlock {
  return {
    signalId: '/x/Sig/AI0',
    mode: 'raw',
    reset: false,
    epoch: 0,
    startTime: 1000,
    sampleInterval: 0.001,
    count: 0,
    byteOffset: 0,
    byteLength: 0,
    ended: false,
    ...overrides,
  };
}

describe('decodeFrame', () => {
  it('recovers the header and the samples', () => {
    const payload = floats([1, 2, 3, 4]);
    const frame = encodeFrame(
      {
        type: 'samples',
        sentAt: 123.5,
        blocks: [block({ count: 4, byteOffset: 0, byteLength: payload.byteLength })],
      },
      [payload],
    );

    const decoded = decodeFrame(frame);
    expect(decoded.frame.type).toBe('samples');
    expect(decoded.frame.sentAt).toBe(123.5);
    expect(decoded.blocks).toHaveLength(1);
    expect([...decoded.blocks[0]!.values]).toEqual([1, 2, 3, 4]);
    expect(decoded.byteLength).toBe(frame.byteLength);
  });

  it('addresses each block by its own offset', () => {
    const first = floats([1, 2]);
    const second = floats([10, 20, 30]);
    const frame = encodeFrame(
      {
        type: 'samples',
        sentAt: 0,
        blocks: [
          block({ signalId: 'a', count: 2, byteOffset: 0, byteLength: first.byteLength }),
          block({
            signalId: 'b',
            count: 3,
            byteOffset: first.byteLength,
            byteLength: second.byteLength,
          }),
        ],
      },
      [first, second],
    );

    const decoded = decodeFrame(frame);
    expect(decoded.blocks.map((entry) => entry.block.signalId)).toEqual(['a', 'b']);
    expect([...decoded.blocks[0]!.values]).toEqual([1, 2]);
    expect([...decoded.blocks[1]!.values]).toEqual([10, 20, 30]);
  });

  it('handles a data-less reset block', () => {
    const frame = encodeFrame(
      {
        type: 'samples',
        sentAt: 0,
        blocks: [block({ mode: 'reset', reset: true, count: 0, byteLength: 0 })],
      },
      [],
    );

    const decoded = decodeFrame(frame);
    expect(decoded.blocks[0]!.values).toHaveLength(0);
    expect(decoded.blocks[0]!.block.reset).toBe(true);
  });

  it('reads a payload that lands on an unaligned offset', () => {
    // A header length that is not a multiple of four leaves the Float32 data
    // misaligned; the decoder has to copy rather than view it.
    const payload = floats([7, 8]);
    const frame = encodeFrame(
      {
        type: 'samples',
        sentAt: 0,
        pad: 'x', // nudges the header length off a 4-byte boundary
        blocks: [block({ count: 2, byteLength: payload.byteLength })],
      },
      [payload],
    );

    const decoded = decodeFrame(frame);
    expect([...decoded.blocks[0]!.values]).toEqual([7, 8]);
  });

  it('rejects a frame without the magic prefix', () => {
    const buffer = new ArrayBuffer(32);
    expect(() => decodeFrame(buffer)).toThrow(FrameDecodeError);
  });

  it('rejects a frame that is too short to hold a header', () => {
    expect(() => decodeFrame(new ArrayBuffer(4))).toThrow(FrameDecodeError);
  });

  it('names the version in the error when the contract moved', () => {
    const frame = encodeFrame({ type: 'samples', sentAt: 0, blocks: [] }, [], FRAME_VERSION + 1);
    expect(() => decodeFrame(frame)).toThrow(/unsupported frame version/i);
  });

  it('rejects a block pointing past the end of the body', () => {
    const payload = floats([1]);
    const frame = encodeFrame(
      {
        type: 'samples',
        sentAt: 0,
        blocks: [block({ count: 64, byteOffset: 0, byteLength: 4096 })],
      },
      [payload],
    );
    expect(() => decodeFrame(frame)).toThrow(/outside the frame body/i);
  });

  it('rejects a header that is not valid JSON', () => {
    const json = new TextEncoder().encode('{not json');
    const buffer = new ArrayBuffer(10 + json.byteLength);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    bytes.set(new TextEncoder().encode('ODQV'), 0);
    view.setUint16(4, FRAME_VERSION, true);
    view.setUint32(6, json.byteLength, true);
    bytes.set(json, 10);

    expect(() => decodeFrame(buffer)).toThrow(/not valid JSON/i);
  });
});
