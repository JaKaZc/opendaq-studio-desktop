import { useEffect, useState } from 'react';
import { Eye, EyeOff, Settings2, X } from 'lucide-react';
import { formatDuration, formatEngineering, formatRelative } from '../../lib/format';
import { cn } from '../../lib/utils';
import type { WindowStats } from '../../lib/trace';
import { traces } from '../../store/traceStore';
import { useScope, visibleWindow } from '../../store/useScope';
import { IconButton } from '../ui/Button';
import { Badge, EmptyState } from '../ui/Feedback';
import type { Readout } from './ScopeCanvas';

interface Row {
  signalId: string;
  name: string;
  color: string;
  visible: boolean;
  unit: string;
  mode: 'raw' | 'minmax' | 'none';
  samplesPerSecond: number | null;
  stats: WindowStats | null;
  ended: boolean;
}

/**
 * Legend and measurement table.
 *
 * Statistics are computed from the client's own buffer over exactly the visible
 * window, so the numbers always describe what is on screen - including after the
 * view is frozen and panned.
 */
export function ScopeLegend({
  readout,
  onSettings,
}: {
  readout: Readout | null;
  /** Open a trace's channel and device settings beside the plot. */
  onSettings?: (signalId: string, name: string) => void;
}) {
  const traceConfigs = useScope((state) => state.traces);
  const showStatistics = useScope((state) => state.showStatistics);
  const removeTrace = useScope((state) => state.removeTrace);
  const updateTrace = useScope((state) => state.updateTrace);
  const [rows, setRows] = useState<Row[]>([]);

  // Recompute a few times a second: statistics over a long window are not free,
  // and nobody reads a mean that changes 60 times a second.
  useEffect(() => {
    let timer = 0;
    const tick = () => {
      const state = useScope.getState();
      const window_ = visibleWindow(state);
      setRows(
        state.traces.map((trace) => {
          const entry = traces.get(trace.signalId);
          return {
            signalId: trace.signalId,
            name: trace.name,
            color: trace.color,
            visible: trace.visible,
            unit: entry?.meta?.unit ?? '',
            mode: entry?.mode ?? 'none',
            samplesPerSecond: entry?.meta?.sampleRate ?? null,
            stats: entry?.buffer.stats(window_.start, window_.end) ?? null,
            ended: entry?.ended ?? false,
          };
        }),
      );
      timer = window.setTimeout(tick, 300);
    };
    tick();
    return () => window.clearTimeout(timer);
  }, [traceConfigs]);

  if (traceConfigs.length === 0) {
    return (
      <EmptyState
        title="No traces"
        description="Pick signals on the left, or use the Add to scope action in the navigator."
      />
    );
  }

  const deltaByTrace = new Map(readout?.deltaValues?.map((entry) => [entry.signalId, entry.delta]) ?? []);
  const valueByTrace = new Map(readout?.values.map((entry) => [entry.signalId, entry.value]) ?? []);

  return (
    <div className="min-h-0 overflow-auto">
      {readout?.deltaTime !== null && readout?.deltaTime !== undefined ? (
        <div className="flex items-center gap-3 border-b border-border bg-accent-soft px-2.5 py-1.5 text-[11.5px]">
          <span className="font-medium text-accent">Cursor A → B</span>
          <span className="num">Δt {formatDuration(Math.abs(readout.deltaTime))}</span>
          <span className="num text-text-muted">
            1/Δt {readout.deltaTime !== 0 ? formatEngineering(1 / Math.abs(readout.deltaTime), 'Hz', 4) : '—'}
          </span>
        </div>
      ) : null}

      <table className="w-full border-collapse text-[11.5px] whitespace-nowrap">
        <thead className="sticky top-0 z-10">
          <tr className="bg-sunken text-left text-[10.5px] font-semibold tracking-wide text-text-muted uppercase">
            <th scope="col" className="px-2 py-1">
              Trace
            </th>
            <th scope="col" className="px-2 py-1 text-right">
              {readout?.deltaTime != null ? 'A' : 'Now'}
            </th>
            {readout?.deltaTime != null ? (
              <th scope="col" className="px-2 py-1 text-right">
                Δ
              </th>
            ) : null}
            {showStatistics ? (
              <>
                <th scope="col" className="px-2 py-1 text-right">
                  Min
                </th>
                <th scope="col" className="px-2 py-1 text-right">
                  Max
                </th>
                <th scope="col" className="px-2 py-1 text-right">
                  Mean
                </th>
                <th scope="col" className="px-2 py-1 text-right">
                  RMS
                </th>
                <th scope="col" className="px-2 py-1 text-right">
                  Pk-Pk
                </th>
                <th scope="col" className="px-2 py-1 text-right">
                  σ
                </th>
                <th scope="col" className="px-2 py-1 text-right">
                  N
                </th>
              </>
            ) : null}
            <th scope="col" className="w-20 px-1 py-1" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const stats = row.stats;
            // Values are scaled against the trace's own peak-to-peak, so a mean
            // that is really zero does not surface as a femtovolt reading.
            const reference = stats?.peakToPeak || stats?.max || 1;
            const cell = (value: number | null | undefined) =>
              value === null || value === undefined ? '—' : formatRelative(value, reference, row.unit, 4);
            return (
              <tr key={row.signalId} className={cn('border-b border-border/60', !row.visible && 'opacity-50')}>
                <th scope="row" className="max-w-0 px-2 py-1 text-left font-normal">
                  {/* Wide enough for a channel and a signal, such as Accelerometer · X. */}
                  <div className="flex min-w-40 items-center gap-1.5">
                    <span
                      className="size-2.5 shrink-0 rounded-sm"
                      style={{ backgroundColor: row.color }}
                      aria-hidden
                    />
                    <span className="truncate" title={row.signalId}>
                      {row.name}
                    </span>
                    {row.mode === 'minmax' ? (
                      <Badge title="The backend is sending min/max pairs for this window">decimated</Badge>
                    ) : null}
                    {row.ended ? <Badge tone="err">ended</Badge> : null}
                  </div>
                </th>
                <td className="num px-2 py-1 text-right">{cell(valueByTrace.get(row.signalId))}</td>
                {readout?.deltaTime != null ? (
                  <td className="num px-2 py-1 text-right text-accent">{cell(deltaByTrace.get(row.signalId))}</td>
                ) : null}
                {showStatistics ? (
                  <>
                    <td className="num px-2 py-1 text-right">{cell(stats?.min)}</td>
                    <td className="num px-2 py-1 text-right">{cell(stats?.max)}</td>
                    <td className="num px-2 py-1 text-right">{cell(stats?.mean)}</td>
                    <td className="num px-2 py-1 text-right">{cell(stats?.rms)}</td>
                    <td className="num px-2 py-1 text-right">{cell(stats?.peakToPeak)}</td>
                    <td className="num px-2 py-1 text-right">{cell(stats?.stdDev)}</td>
                    <td className="num px-2 py-1 text-right text-text-muted">{stats?.count ?? '—'}</td>
                  </>
                ) : null}
                <td className="px-1 py-0.5">
                  <div className="flex items-center justify-end gap-0.5">
                    {onSettings ? (
                      <IconButton label="Channel and device settings" size="sm" onClick={() => onSettings(row.signalId, row.name)}>
                        <Settings2 size={12} />
                      </IconButton>
                    ) : null}
                    <IconButton
                      label={row.visible ? 'Hide trace' : 'Show trace'}
                      size="sm"
                      onClick={() => updateTrace(row.signalId, { visible: !row.visible })}
                    >
                      {row.visible ? <Eye size={12} /> : <EyeOff size={12} />}
                    </IconButton>
                    <IconButton
                      label="Remove trace"
                      size="sm"
                      onClick={() => removeTrace(row.signalId)}
                    >
                      <X size={12} />
                    </IconButton>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
