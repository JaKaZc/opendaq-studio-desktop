import { useMemo, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { formatIsoTimestamp, formatRelativeTime } from '../../lib/format';
import { cn } from '../../lib/utils';
import type { NotificationLevel } from '../../lib/types';
import { useSession } from '../../store/useSession';
import { useSettings } from '../../store/useSettings';
import { IconButton } from '../ui/Button';
import { Segment, ButtonGroup } from '../ui/Button';
import { EmptyState, LevelIcon } from '../ui/Feedback';
import { LogPanel } from './LogPanel';

const FILTERS: { id: 'all' | NotificationLevel; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'error', label: 'Errors' },
  { id: 'warning', label: 'Warnings' },
  { id: 'info', label: 'Info' },
];

/**
 * The drawer, with two views of what is happening.
 *
 * **Events** is the summary written for people - "Connected RefDev0", "Load
 * failed" - which is what belongs beside a measurement. **Log** is the raw
 * account underneath it, this backend's records merged with openDAQ's own, and
 * it is where a device that will not connect is actually diagnosed.
 */
export function EventLogDrawer() {
  const [view, setView] = useState<'events' | 'log'>('events');
  return (
    <aside className="flex h-72 shrink-0 flex-col border-t border-border bg-panel" aria-label="Log">
      <DrawerHeader view={view} onView={setView} />
      {view === 'events' ? <EventList /> : <LogPanel />}
    </aside>
  );
}

function DrawerHeader({
  view,
  onView,
}: {
  view: 'events' | 'log';
  onView: (view: 'events' | 'log') => void;
}) {
  const toggleSetting = useSettings((state) => state.toggle);
  return (
    <div className="flex items-center gap-2 border-b border-border px-2.5 py-1">
      <ButtonGroup>
        <Segment active={view === 'events'} onClick={() => onView('events')}>
          Events
        </Segment>
        <Segment active={view === 'log'} onClick={() => onView('log')}>
          Log
        </Segment>
      </ButtonGroup>
      <span className="flex-1" />
      <IconButton label="Close the log" onClick={() => toggleSetting('eventLogOpen')}>
        <X size={14} />
      </IconButton>
    </div>
  );
}

function EventList() {
  const log = useSession((state) => state.log);
  const clearLog = useSession((state) => state.clearLog);
  const select = useSession((state) => state.select);
  const [filter, setFilter] = useState<'all' | NotificationLevel>('all');

  const entries = useMemo(
    () => (filter === 'all' ? log : log.filter((entry) => entry.level === filter)),
    [filter, log],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5">
        <ButtonGroup>
          {FILTERS.map((entry) => (
            <Segment key={entry.id} active={filter === entry.id} onClick={() => setFilter(entry.id)}>
              {entry.label}
            </Segment>
          ))}
        </ButtonGroup>
        <span className="text-[11px] text-text-faint">{entries.length}</span>

        <div className="ml-auto flex items-center gap-1">
          <IconButton label="Clear the log" size="sm" onClick={clearLog} disabled={log.length === 0}>
            <Trash2 size={13} />
          </IconButton>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <EmptyState
            title="Nothing logged yet"
            description="Device changes, connection status and failed operations appear here."
          />
        ) : (
          <ul className="divide-y divide-border/60">
            {entries.map((entry) => (
              <li key={entry.id} className="flex items-start gap-2 px-2.5 py-1.5">
                <span className="mt-0.5 shrink-0">
                  <LevelIcon level={entry.level} size={12} />
                </span>
                <span
                  className="num w-14 shrink-0 text-[10.5px] text-text-faint"
                  title={formatIsoTimestamp(new Date(entry.at * 1000).toISOString())}
                >
                  {formatRelativeTime(entry.at)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] leading-snug break-words">{entry.message}</p>
                  {entry.detail ? (
                    <p className="mt-0.5 font-mono text-[10.5px] leading-snug break-words text-text-muted">
                      {entry.detail}
                    </p>
                  ) : null}
                </div>
                <span className="shrink-0 text-[10px] text-text-faint">{entry.source}</span>
                {entry.componentId ? (
                  <button
                    type="button"
                    onClick={() => void select(entry.componentId)}
                    className={cn('shrink-0 text-[10.5px] text-accent underline decoration-dotted')}
                  >
                    show
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
