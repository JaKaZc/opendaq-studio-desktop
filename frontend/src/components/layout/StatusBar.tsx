import { useEffect, useState } from 'react';
import { Activity, Cpu, Gauge, HardDrive } from 'lucide-react';
import { formatBytes, formatEngineering, shortenGlobalId } from '../../lib/format';
import { realtime } from '../../lib/realtime';
import { traces } from '../../store/traceStore';
import { useTracks } from '../../store/useTracks';
import { useSession } from '../../store/useSession';

/**
 * The bottom strip: what is connected, what is streaming, and how fast.
 *
 * It reads the realtime counters directly on a timer, so the numbers stay live
 * without the rest of the app re-rendering.
 */
export function StatusBar() {
  const info = useSession((state) => state.info);
  const selectedId = useSession((state) => state.selectedId);
  const tree = useSession((state) => state.tree);
  const trackCount = useTracks((state) => state.tracks.length);
  const [metrics, setMetrics] = useState({ frames: 0, bytesPerSecond: 0, samplesPerSecond: 0 });

  useEffect(() => {
    let previousBytes = realtime.stats.bytes;
    let previousSamples = traces.stats.samples;
    let previousAt = Date.now();

    const timer = window.setInterval(() => {
      const now = Date.now();
      const elapsed = (now - previousAt) / 1000 || 1;
      setMetrics({
        frames: realtime.stats.frames,
        bytesPerSecond: (realtime.stats.bytes - previousBytes) / elapsed,
        samplesPerSecond: (traces.stats.samples - previousSamples) / elapsed,
      });
      previousBytes = realtime.stats.bytes;
      previousSamples = traces.stats.samples;
      previousAt = now;
    }, 1000);

    return () => window.clearInterval(timer);
  }, []);

  const deviceCount = tree
    ? countKind(tree, (node) => node.kind === 'device')
    : 0;
  const signalCount = tree ? countKind(tree, (node) => node.kind === 'signal') : 0;

  return (
    <footer className="flex shrink-0 items-center gap-4 border-t border-border bg-panel px-3 py-1 text-[11px] text-text-muted">
      <span className="flex items-center gap-1.5" title="Connected devices">
        <HardDrive size={11} aria-hidden />
        {deviceCount} device{deviceCount === 1 ? '' : 's'}
      </span>
      <span className="flex items-center gap-1.5" title="Signals in the instance">
        <Activity size={11} aria-hidden />
        {signalCount} signal{signalCount === 1 ? '' : 's'}
      </span>
      <span className="flex items-center gap-1.5" title="Traces subscribed by this browser">
        <Gauge size={11} aria-hidden />
        {trackCount} track{trackCount === 1 ? '' : 's'}
      </span>

      {metrics.samplesPerSecond > 0 ? (
        <span className="num flex items-center gap-1.5" title="Sample throughput into this browser">
          {formatEngineering(metrics.samplesPerSecond, 'Sa/s', 3)}
          <span className="text-text-faint">·</span>
          {formatBytes(metrics.bytesPerSecond)}/s
        </span>
      ) : null}

      {selectedId ? (
        <span className="ml-auto min-w-0 truncate font-mono text-[10.5px]" title={selectedId}>
          {shortenGlobalId(selectedId)}
        </span>
      ) : (
        <span className="ml-auto" />
      )}

      <span className="flex shrink-0 items-center gap-1.5" title="openDAQ SDK version">
        <Cpu size={11} aria-hidden />
        SDK {info?.sdkVersion ?? '—'}
      </span>
      <span className="shrink-0 text-text-faint">v{info?.appVersion ?? '—'}</span>
    </footer>
  );
}

function countKind(
  node: { kind: string; children: { kind: string; children: unknown[] }[] },
  predicate: (node: { kind: string }) => boolean,
): number {
  let total = predicate(node) ? 1 : 0;
  for (const child of node.children) {
    total += countKind(child as never, predicate);
  }
  return total;
}
