/**
 * Decoder for the backend's binary sample frames.
 *
 * Layout (little endian), produced by `daq/streaming.py:encode_frame`:
 *
 * ```
 *   0  ..  3   magic  "ODQV"
 *   4  ..  5   uint16 version
 *   6  ..  9   uint32 header length
 *  10  ..  N   UTF-8 JSON header  -> SampleFrame
 *   N  ..      concatenated Float32 payloads, addressed by each block's
 *              byteOffset / byteLength
 * ```
 *
 * Keeping the samples out of JSON is the whole point: a 20 kHz trace is 80 kB/s
 * as Float32 and roughly 400 kB/s as JSON numbers.
 */

import type { SampleBlock, SampleFrame } from './types';

const MAGIC = 0x56_51_44_4f; // "ODQV" read as a little-endian uint32
export const FRAME_VERSION = 1;

export interface DecodedBlock {
  block: SampleBlock;
  /** Raw values, or interleaved [min, max, min, max, ...] in `minmax` mode. */
  values: Float32Array;
}

export interface DecodedFrame {
  frame: SampleFrame;
  blocks: DecodedBlock[];
  byteLength: number;
}

export class FrameDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameDecodeError';
  }
}

export function decodeFrame(buffer: ArrayBuffer): DecodedFrame {
  if (buffer.byteLength < 10) {
    throw new FrameDecodeError(`frame is too short (${buffer.byteLength} bytes)`);
  }
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC) {
    throw new FrameDecodeError('frame is missing the ODQV prefix');
  }
  const version = view.getUint16(4, true);
  if (version !== FRAME_VERSION) {
    throw new FrameDecodeError(
      `unsupported frame version ${version} (this build understands ${FRAME_VERSION}) - reload to pick up a matching UI`,
    );
  }

  const headerLength = view.getUint32(6, true);
  const headerEnd = 10 + headerLength;
  if (headerEnd > buffer.byteLength) {
    throw new FrameDecodeError('frame header runs past the end of the message');
  }

  const headerText = new TextDecoder().decode(new Uint8Array(buffer, 10, headerLength));
  let frame: SampleFrame;
  try {
    frame = JSON.parse(headerText) as SampleFrame;
  } catch (cause) {
    throw new FrameDecodeError(`frame header is not valid JSON: ${String(cause)}`);
  }

  const bodyLength = buffer.byteLength - headerEnd;
  const blocks: DecodedBlock[] = [];

  for (const block of frame.blocks ?? []) {
    if (block.byteLength === 0) {
      blocks.push({ block, values: EMPTY });
      continue;
    }
    if (block.byteOffset + block.byteLength > bodyLength) {
      throw new FrameDecodeError(`block for ${block.signalId} points outside the frame body`);
    }
    // Float32Array needs a 4-byte aligned offset; the header length makes no
    // such promise, so copy when the slice happens to land unaligned.
    const absolute = headerEnd + block.byteOffset;
    const count = block.byteLength >> 2;
    const values =
      absolute % 4 === 0
        ? new Float32Array(buffer, absolute, count)
        : new Float32Array(buffer.slice(absolute, absolute + block.byteLength));
    blocks.push({ block, values });
  }

  return { frame, blocks, byteLength: buffer.byteLength };
}

const EMPTY = new Float32Array(0);
