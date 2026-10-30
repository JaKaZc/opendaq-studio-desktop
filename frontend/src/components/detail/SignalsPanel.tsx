import { useMemo, useState } from 'react';
import { Activity, Eye, FileText, LineChart, Radio, Settings2 } from 'lucide-react';
import { api } from '../../lib/api';
import { usePolling } from '../../lib/usePolling';
import { formatSampleRate } from '../../lib/format';
import { cn } from '../../lib/utils';
import type { LastValue, SignalInfo } from '../../lib/types';
import { useDialogs } from '../../store/useDialogs';
import { openInScope, showAsTrack, useTracks } from '../../store/useTracks';
import { useSettings } from '../../store/useSettings';
import { IconButton } from '../ui/Button';
import { Badge, EmptyState } from '../ui/Feedback';

/**
 * A component's output signals, with a live value column.
 *
 * Values are polled rather than streamed: `last_value` is one cheap call for the
 * whole list, and a table that ticks a few times a second reads better than one
 * that updates 20 times a second. A live waveform is a track on the Signals
 * page, one click away.
 */
export function SignalsPanel({ signals, readOnly }: { signals: SignalInfo[]; readOnly: boolean }) {
  const interval = useSettings((state) => state.lastValueInterval);
  const [values, setValues] = useState<Record<string, LastValue>>({});
  const ids = useMemo(() => signals.map((signal) => signal.id), [signals]);
  const idKey = ids.join('|');

  // One request covers the whole list, so a component with twenty signals costs
  // the same as one with two.
  usePolling(
    async (signal) => {
      const response = await api.signals.lastValues(ids, undefined, false, signal);
      const next: Record<string, LastValue> = {};
      for (const value of response.values) next[value.id] = value;
      setValues(next);
    },
    interval,
    [idKey],
    { enabled: ids.length > 0 },
  );

  if (signals.length === 0) {
    return (
      <section className="card">
        <EmptyState title="No output signals" description="This component does not publish any signals." />
      </section>
    );
  }

  // Near the top of the inspector on purpose: change a property below and the
  // reading it affects moves here, without leaving the page.
  return (
    <section className="animate-enter card @container overflow-hidden" aria-label="Live outputs">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Radio size={13} className="text-brand" aria-hidden />
        <h3 className="text-[13px] font-semibold">Live outputs</h3>
        <span className="text-[11.5px] text-text-faint">
          {signals.length} signal{signals.length === 1 ? '' : 's'} · updates as you configure
        </span>
      </div>
      <ul className="divide-y divide-border/70">
        {signals.map((signal) => (
          <SignalRow key={signal.id} signal={signal} value={values[signal.id]} readOnly={readOnly} />
        ))}
      </ul>
    </section>
  );
}

function SignalRow({
  signal,
  value,
  readOnly,
}: {
  signal: SignalInfo;
  value: LastValue | undefined;
  readOnly: boolean;
}) {
  const openDialog = useDialogs((state) => state.open);
  const isTrack = useTracks((state) => state.tracks.includes(signal.id));

  const display = value?.displayValue;

  return (
    <li className="px-3 py-1.5 transition-colors hover:bg-sunken/60">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="truncate text-[12.5px]" title={signal.id}>
            {signal.name}
          </span>
          {!signal.public ? <Badge>private</Badge> : null}
          {signal.sampleRate ? (
            <span className="hidden shrink-0 text-[10.5px] text-text-faint @sm:inline">
              {formatSampleRate(signal.sampleRate)}
            </span>
          ) : null}
        </div>

        <span
          className={cn(
            'num shrink-0 text-right tabular text-[13px] @md:min-w-[7.5rem]',
            value?.error ? 'text-err' : 'text-text',
            value?.kind === 'timestamp' && 'text-[11px] text-text-muted',
          )}
          title={value?.error ?? display ?? undefined}
        >
          {value?.error ? 'read error' : (display ?? '—')}
        </span>

        <div className="flex shrink-0 items-center gap-0.5">
          {value?.kind === 'struct' || value?.kind === 'string' ? (
            <IconButton
              label="View value"
              size="sm"
              onClick={() =>
                openDialog({
                  kind: 'viewValue',
                  title: `${signal.name} — last value`,
                  text: JSON.stringify(value.value, null, 2),
                })
              }
            >
              <FileText size={12} />
            </IconButton>
          ) : null}
          <IconButton
            label="Data descriptor"
            size="sm"
            onClick={() => openDialog({ kind: 'descriptor', signalId: signal.id })}
          >
            <Eye size={12} />
          </IconButton>
          <IconButton
            label={isTrack ? 'Show its track' : 'Show as a track'}
            size="sm"
            active={isTrack}
            disabled={!signal.chartable}
            onClick={() => showAsTrack(signal.id)}
          >
            <Activity size={12} />
          </IconButton>
          <IconButton
            label="Open in the Scope"
            size="sm"
            disabled={!signal.chartable}
            onClick={() => openInScope(signal.id, signal.name)}
          >
            <LineChart size={12} />
          </IconButton>
          <IconButton
            label="Edit attributes"
            size="sm"
            disabled={readOnly}
            onClick={() => openDialog({ kind: 'attributes', componentId: signal.id })}
          >
            <Settings2 size={12} />
          </IconButton>
        </div>
      </div>

    </li>
  );
}
