import { useEffect, useState } from 'react';
import { Pause, Power, Radio, RefreshCw, Snowflake, Target } from 'lucide-react';
import { actions as componentActions } from '../../lib/actions';
import { formatDuration } from '../../lib/format';
import { cn } from '../../lib/utils';
import { findNode, pathTo } from '../../lib/views';
import { useSession } from '../../store/useSession';
import { traces } from '../../store/traceStore';
import { liveEdge, useScope } from '../../store/useScope';

/** No frame for this long from a plotted signal means its stream has stopped. */
const STALL_MS = 3000;

interface Stall {
  signalId: string;
  name: string;
  seconds: number;
}

/**
 * The component that was switched off, above a signal or the signal itself.
 * Searched from the top down: openDAQ reports everything below an inactive
 * component as inactive too, and the one to switch on is the highest.
 */
function inactiveOwner(signalId: string): { id: string; name: string } | null {
  const tree = useSession.getState().tree;
  if (!tree) return null;
  for (const id of [...pathTo(tree, signalId), signalId]) {
    const node = findNode(tree, id);
    if (node && !node.active) return { id: node.id, name: node.displayName || node.name };
  }
  return null;
}

/**
 * Why the plot is not moving, and the one action that gets it going again.
 *
 * A Scope stops for several reasons that look the same: it was paused,
 * dragging or zooming froze it, a single trigger is holding its capture, or a
 * signal stopped delivering samples. Each gets a sentence and a button here,
 * and `L` jumps back to live from any of them.
 */
export function ScopeStatus() {
  const paused = useScope((state) => state.paused);
  const xMode = useScope((state) => state.xMode);
  const frozenEnd = useScope((state) => state.frozenEnd);
  const triggerMode = useScope((state) => state.trigger.mode);
  const triggerStatus = useScope((state) => state.triggerStatus);
  const scopeTraces = useScope((state) => state.traces);
  const goLive = useScope((state) => state.goLive);
  const restartStream = useScope((state) => state.restartStream);
  const armTrigger = useScope((state) => state.armTrigger);
  const [stall, setStall] = useState<Stall | null>(null);
  const [behind, setBehind] = useState<number | null>(null);

  // Checked twice a second: whether a plotted signal stopped arriving, and how
  // far behind the newest samples a frozen view is.
  useEffect(() => {
    const check = () => {
      const now = Date.now();
      let worst: Stall | null = null;
      if (!paused) {
        for (const trace of scopeTraces) {
          if (!trace.visible) continue;
          const state = traces.get(trace.signalId);
          if (!state || state.ended || !state.lastFrameAt) continue;
          const silent = now - state.lastFrameAt;
          if (silent > STALL_MS && (!worst || silent / 1000 > worst.seconds)) worst = { signalId: trace.signalId, name: trace.name, seconds: silent / 1000 };
        }
      }
      setStall(worst);
      const edge = liveEdge(useScope.getState());
      setBehind(xMode === 'frozen' && frozenEnd !== null && edge !== null ? Math.max(0, edge - frozenEnd) : null);
    };
    const first = window.setTimeout(check, 0);
    const timer = window.setInterval(check, 500);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [paused, scopeTraces, xMode, frozenEnd]);

  let tone: 'info' | 'warn' = 'info';
  let icon = <Snowflake size={13} />;
  let text: string | null = null;
  let actions: { label: string; onClick: () => void; primary?: boolean; icon: React.ReactNode }[] = [];
  const live = { label: 'Jump to live', onClick: goLive, primary: true, icon: <Radio size={12} /> };

  if (scopeTraces.length === 0) {
    text = null;
  } else if (stall) {
    tone = 'warn';
    icon = <RefreshCw size={13} />;
    const off = inactiveOwner(stall.signalId);
    if (off) {
      // openDAQ says why: the signal or a component above it is switched off.
      text = `No new samples from ${stall.name} for ${Math.round(stall.seconds)} s, because ${off.name} is not active.`;
      actions = [
        {
          label: `Switch ${off.name} on`,
          onClick: () => void componentActions.setActive(off.id, true).then(() => restartStream()),
          primary: true,
          icon: <Power size={12} />,
        },
      ];
    } else {
      text = `No new samples from ${stall.name} for ${Math.round(stall.seconds)} s. The device may have stopped or been reconfigured; restarting the stream asks for its samples again.`;
      actions = [{ label: 'Restart the stream', onClick: restartStream, primary: true, icon: <RefreshCw size={12} /> }];
    }
  } else if (paused) {
    icon = <Pause size={13} />;
    text = 'Paused. The Scope is not receiving samples, so the plot holds still.';
    actions = [live];
  } else if (triggerMode !== 'off' && triggerStatus === 'stopped') {
    icon = <Target size={13} />;
    text = 'The single trigger captured an event and is holding it.';
    actions = [
      { label: 'Arm again', onClick: armTrigger, primary: true, icon: <Target size={12} /> },
      { label: 'Free run', onClick: goLive, icon: <Radio size={12} /> },
    ];
  } else if (xMode === 'frozen') {
    text = `The view is frozen${behind !== null && behind > 0.0005 ? `, ${formatDuration(behind)} behind the newest samples` : ''}. Dragging or zooming the plot freezes it.`;
    actions = [live];
  }

  if (!text) return null;
  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1.5 text-[12px]',
        tone === 'warn' ? 'border-warn/40 bg-warn-soft text-warn' : 'border-accent/30 bg-accent-soft text-text',
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2">
        <span className="shrink-0">{icon}</span>
        <span className="min-w-0">{text}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            onClick={action.onClick}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-full px-3 font-medium',
              action.primary ? 'bg-accent text-white hover:brightness-110' : 'border border-border bg-panel hover:border-border-strong',
            )}
          >
            {action.icon}
            {action.label}
          </button>
        ))}
        <kbd className="hidden rounded border border-border-strong bg-panel px-1.5 text-[10.5px] text-text-faint sm:inline" title="Press L to jump back to live">
          L
        </kbd>
      </span>
    </div>
  );
}
