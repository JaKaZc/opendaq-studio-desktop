import { useEffect, useState } from 'react';
import { ArrowUpRight, X } from 'lucide-react';
import { api } from '../../lib/api';
import { useAsyncData } from '../../lib/useAsyncData';
import { cn } from '../../lib/utils';
import { findNode, pathTo } from '../../lib/views';
import { go } from '../../store/useNav';
import { useSession } from '../../store/useSession';
import { DetailPanel } from '../detail/DetailPanel';
import { Spinner } from '../ui/Feedback';

type Target = 'channel' | 'device' | 'signal';

const LABELS: Record<Target, string> = { channel: 'Channel', device: 'Device', signal: 'Signal' };

/**
 * A trace's settings without leaving the Scope.
 *
 * The channel that produces the signal, its device and the signal itself, each
 * with the same property cards as the Devices mode, so a sample rate or a range
 * can be changed while the trace it affects stays in view.
 */
export function ScopeSettings({ signalId, name, onClose }: { signalId: string; name: string; onClose: () => void }) {
  const select = useSession((state) => state.select);
  const tree = useSession((state) => state.tree);
  const signal = useAsyncData((abort) => api.signals.detail(signalId, abort), [signalId]);
  // The signal's direct parent is usually its signals folder ("Sig"); the
  // settings that shape it belong to the nearest channel or function block.
  const owner = tree
    ? [...pathTo(tree, signalId)].reverse().find((id) => {
        const kind = findNode(tree, id)?.kind;
        return kind === 'channel' || kind === 'functionBlock' || kind === 'recorder';
      }) ?? null
    : null;
  const [target, setTarget] = useState<Target>('channel');

  const ids: Record<Target, string | null> = {
    channel: owner,
    device: signal.data?.deviceId ?? null,
    signal: signalId,
  };
  // Only targets that exist, and the channel only when it is not the device itself.
  const targets = (['channel', 'device', 'signal'] as Target[]).filter(
    (entry) => ids[entry] && !(entry === 'channel' && ids.channel === ids.device),
  );
  const current = targets.includes(target) ? target : (targets[0] ?? 'signal');
  const componentId = ids[current];

  useEffect(() => {
    if (componentId) void select(componentId);
  }, [componentId, select]);

  return (
    <aside
      className="flex w-[min(440px,55%)] min-w-[280px] shrink-0 flex-col border-l border-border bg-surface"
      aria-label={`Settings of ${name}`}
    >
      <div className="flex items-center gap-2 border-b border-border bg-panel px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold">{name}</div>
          <div className="text-[11px] text-text-faint">Changes are written to the device at once.</div>
        </div>
        <button
          type="button"
          onClick={() => go('devices')}
          title="Open the same component in the Devices mode"
          className="inline-flex h-7 items-center gap-1 rounded-full border border-border px-2.5 text-[11.5px] font-medium hover:border-border-strong"
        >
          Devices <ArrowUpRight size={12} />
        </button>
        <button type="button" onClick={onClose} aria-label="Close the settings" className="rounded p-1 text-text-faint hover:bg-sunken hover:text-text">
          <X size={14} />
        </button>
      </div>
      {targets.length > 1 ? (
        <div role="tablist" aria-label="Which settings" className="flex gap-1 border-b border-border bg-panel px-3 py-1.5">
          {targets.map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={entry === current}
              onClick={() => setTarget(entry)}
              className={cn(
                'rounded-full px-3 py-1 text-[12px] font-medium',
                entry === current ? 'bg-accent-soft text-accent' : 'text-text-muted hover:bg-sunken hover:text-text',
              )}
            >
              {LABELS[entry]}
            </button>
          ))}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">{signal.loading && !signal.data ? <Spinner className="m-6" /> : <DetailPanel />}</div>
    </aside>
  );
}
