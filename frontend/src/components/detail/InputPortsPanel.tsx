import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link2, Link2Off, Search, Settings2 } from 'lucide-react';
import { actions } from '../../lib/actions';
import { api } from '../../lib/api';
import { useAsyncData } from '../../lib/useAsyncData';
import { cn } from '../../lib/utils';
import { shortenGlobalId } from '../../lib/format';
import type { InputPortInfo } from '../../lib/types';
import { useDialogs } from '../../store/useDialogs';
import { useSession } from '../../store/useSession';
import { useSettings } from '../../store/useSettings';
import { IconButton } from '../ui/Button';
import { Badge, Spinner } from '../ui/Feedback';
import { Input } from '../ui/Field';

/** A function block's input ports and what is connected to them. */
export function InputPortsPanel({
  ports,
  readOnly,
}: {
  ports: InputPortInfo[];
  readOnly: boolean;
}) {
  if (ports.length === 0) return null;

  return (
    <section className="animate-enter card overflow-hidden" aria-label="Input ports">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <h3 className="text-[13px] font-semibold">Inputs</h3>
        <span className="text-[11.5px] text-text-faint">
          {ports.length} port{ports.length === 1 ? '' : 's'} · what this block reads
        </span>
      </div>
      <ul className="divide-y divide-border/70">
        {ports.map((port) => (
          <PortRow key={port.id} port={port} readOnly={readOnly} />
        ))}
      </ul>
    </section>
  );
}

function PortRow({ port, readOnly }: { port: InputPortInfo; readOnly: boolean }) {
  const openDialog = useDialogs((state) => state.open);
  const connected = Boolean(port.signalId);

  return (
    <li className="flex items-center gap-2 px-4 py-2 transition-colors hover:bg-sunken/60">
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="truncate text-[12.5px]" title={port.id}>
          {port.name}
        </span>
        {port.requiresSignal && !connected ? <Badge tone="warn">needs a signal</Badge> : null}
      </span>

      <div className="min-w-0 flex-1">
        <SignalPicker port={port} disabled={readOnly} />
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton
          label={connected ? 'Disconnect' : 'Not connected'}
          size="sm"
          disabled={!connected || readOnly}
          onClick={() => void actions.connectPort(port.id, null)}
        >
          {connected ? <Link2Off size={12} /> : <Link2 size={12} className="opacity-40" />}
        </IconButton>
        <IconButton
          label="Edit attributes"
          size="sm"
          disabled={readOnly}
          onClick={() => openDialog({ kind: 'attributes', componentId: port.id })}
        >
          <Settings2 size={12} />
        </IconButton>
      </div>
    </li>
  );
}

/**
 * A searchable signal picker.
 *
 * Candidates are fetched on first open rather than up front: an instance with
 * several devices can expose hundreds of signals, and most ports are never
 * rewired.  Signals on the port's own device sort first, because that is nearly
 * always what someone is reaching for.
 */
function SignalPicker({ port, disabled }: { port: InputPortInfo; disabled: boolean }) {
  const includeHidden = useSettings((state) => state.includeHidden);
  const reportError = useSession((state) => state.reportError);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
  } | null>(null);

  // Only fetched once the picker is opened: an instance with several devices can
  // expose hundreds of signals, and most ports are never rewired.
  const { data: candidates, loading } = useAsyncData(
    (signal) => api.topology.portCandidates(port.id, includeHidden, signal).then((r) => r.signals),
    [port.id, includeHidden],
    {
      enabled: open,
      onError: (error) => reportError(error, 'Could not list signals'),
    },
  );

  // The list opens in a portal, anchored to the button, so the card it sits in
  // cannot cut it off. It opens upwards when there is more room above.
  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 8;
    const wanted = 330;
    const width = Math.max(rect.width, 256);
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
    const below = window.innerHeight - rect.bottom - margin;
    const above = rect.top - margin;
    setPlacement(
      below >= wanted || below >= above
        ? { left, width, top: rect.bottom + 4 }
        : { left, width, bottom: window.innerHeight - rect.top + 4 },
    );
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !popupRef.current?.contains(target))
        setOpen(false);
    };
    // A scroll would leave the list behind its button, so it closes, as menus do.
    const close = (event: Event) => {
      if (!popupRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeNow = () => setOpen(false);
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', closeNow);
    return () => {
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', closeNow);
    };
  }, [open]);

  const filtered = useMemo(() => {
    if (!candidates) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return candidates.slice(0, 100);
    return candidates
      .filter(
        (signal) =>
          signal.name.toLowerCase().includes(needle) || signal.id.toLowerCase().includes(needle),
      )
      .slice(0, 100);
  }, [candidates, query]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
        className={cn(
          'flex h-6.5 w-full items-center gap-1.5 rounded-[var(--radius-control)] border border-border-strong',
          'bg-panel px-2 text-left text-[12px] hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-60',
        )}
        title={port.signalId ?? 'No signal connected'}
      >
        <Link2 size={11} className={port.signalId ? 'text-ok' : 'text-text-faint'} />
        <span className={cn('min-w-0 flex-1 truncate', !port.signalId && 'text-text-faint')}>
          {port.signalName ??
            (port.signalId ? shortenGlobalId(port.signalId) : 'Connect a signal…')}
        </span>
      </button>

      {open && placement
        ? createPortal(
            <div
              ref={popupRef}
              style={placement}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.stopPropagation();
                  setOpen(false);
                }
              }}
              className="fixed z-60 overflow-hidden rounded-[var(--radius-panel)] border border-border bg-elevated shadow-[var(--shadow-popover)]"
            >
              <div className="relative border-b border-border p-1.5">
                <Search
                  size={12}
                  aria-hidden
                  className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-text-faint"
                />
                <Input
                  size="sm"
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search signals…"
                  aria-label="Search signals"
                  className="pl-6.5"
                />
              </div>

              <div className="max-h-64 overflow-y-auto py-1" role="listbox">
                {loading ? (
                  <div className="flex items-center justify-center gap-2 py-4 text-[12px] text-text-muted">
                    <Spinner size={13} /> Loading signals…
                  </div>
                ) : filtered.length === 0 ? (
                  <p className="px-3 py-3 text-[12px] text-text-muted">No matching signals.</p>
                ) : (
                  filtered.map((signal) => (
                    <button
                      key={signal.id}
                      type="button"
                      role="option"
                      aria-selected={signal.id === port.signalId}
                      onClick={() => {
                        setOpen(false);
                        void actions.connectPort(port.id, signal.id);
                      }}
                      className={cn(
                        'flex w-full items-baseline gap-2 px-2.5 py-1 text-left text-[12px] hover:bg-sunken',
                        signal.id === port.signalId && 'bg-accent-soft',
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate">{signal.name}</span>
                      {signal.local ? <Badge tone="info">same device</Badge> : null}
                      <span className="shrink-0 font-mono text-[10px] text-text-faint">
                        {shortenGlobalId(signal.id)}
                      </span>
                    </button>
                  ))
                )}
              </div>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
