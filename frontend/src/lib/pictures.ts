/**
 * The newest picture of an image signal, such as a phone's camera, fetched
 * from `GET /api/signals/picture` while a component shows it.
 *
 * The backend numbers the pictures as they arrive. It holds a request for a
 * newer picture than the caller's up to 50 ms and answers it as soon as one
 * arrives, or with 204, so polling often costs little and misses nothing.
 *
 * A Universal renderer can send plot data instead of pictures; that is kept
 * as bytes, for the component to draw.
 */

import { useEffect, useState } from 'react';
import { API_BASE } from './api';

export interface Picture {
  /** The picture, decoded; closed when the next picture replaces it. */
  bitmap: ImageBitmap | null;
  /** Plot data to draw, instead of a picture. */
  plot: ArrayBuffer | null;
  bytes: number;
  /** Pictures per second over the last two seconds. */
  rate: number;
}


export function usePicture(signalId: string, enabled = true): Picture | null {
  const [picture, setPicture] = useState<Picture | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let sequence = 0;
    // The sequence and the bitmap of the picture shown.
    let shown = 0;
    let bitmap: ImageBitmap | null = null;
    let frame: number | undefined;
    const arrivals: number[] = [];
    const controller = new AbortController();

    const show = (next: Omit<Picture, 'rate'>) => {
      const now = performance.now();
      arrivals.push(now);
      while (arrivals.length && now - (arrivals[0] ?? now) > 2000) arrivals.shift();
      const first = arrivals[0] ?? now;
      const rate = arrivals.length < 2 || now === first ? 0 : ((arrivals.length - 1) * 1000) / (now - first);
      setPicture({ ...next, rate });
    };

    const poll = async () => {
      try {
        const query = new URLSearchParams({ id: signalId, after: String(sequence) });
        const response = await fetch(`${API_BASE}/api/signals/picture?${query}`, { signal: controller.signal, cache: 'no-store' });
        sequence = Number(response.headers.get('X-Picture-Sequence') ?? sequence);
        if (response.status === 200) {
          const isPlot = (response.headers.get('Content-Type') ?? '').startsWith('application/x-opendaq-plot');
          if (isPlot) {
            const body = await response.arrayBuffer();
            if (!stopped) show({ bitmap: null, plot: body, bytes: body.byteLength });
          } else {
            // A picture is decoded off the page's thread, which a large PNG
            // needs to keep up with the screen, and the next request goes
            // out meanwhile. A decoded picture older than the one shown is
            // dropped.
            const body = await response.blob();
            const number = sequence;
            void createImageBitmap(body).then(
              (decoded) => {
                if (stopped || number <= shown) {
                  decoded.close();
                  return;
                }
                bitmap?.close();
                bitmap = decoded;
                shown = number;
                show({ bitmap: decoded, plot: null, bytes: body.size });
              },
              () => undefined,
            );
          }
        }
      } catch {
        // A failed or aborted request is retried at the next tick.
      }
      // The next request goes out at the next screen refresh, so pictures
      // arrive as fast as the screen can show them, 60 or 120 a second.
      if (!stopped) frame = requestAnimationFrame(() => void poll());
    };
    void poll();

    return () => {
      stopped = true;
      controller.abort();
      if (frame !== undefined) cancelAnimationFrame(frame);
      bitmap?.close();
      setPicture(null);
    };
  }, [signalId, enabled]);

  return picture;
}
