import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Bug, Power, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { formatTimeOfDay } from '../../lib/format';
import { useDebouncedValue } from '../../lib/useDebouncedValue';
import { usePolling } from '../../lib/usePolling';
import { cn } from '../../lib/utils';
import type { LogEntry, LogLevel } from '../../lib/types';
import { useSession } from '../../store/useSession';
import { IconButton } from '../ui/Button';
import { Input, Select, Switch } from '../ui/Field';
import { Badge, EmptyState } from '../ui/Feedback';

const LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'warning', 'error', 'critical'];

const LEVEL_TONE: Record<LogLevel, string> = {
  trace: 'text-text-faint',
  debug: 'text-text-faint',
  info: 'text-text-muted',
  warning: 'text-warn',
  error: 'text-err',
  critical: 'text-err',
};

/** How many records the panel keeps on screen. Beyond this, older ones scroll off. */
const KEEP = 2000;

/**
 * The log: this backend's own records and openDAQ's, in one list.
 *
 * The event log above it is a summary written for people — "Connected RefDev0".
 * This is the raw account underneath, which is what a device that will not
 * connect or a stream that stalls actually needs. openDAQ's half normally goes to
 * stderr, which in the desktop application means nowhere, so the backend tails
 * its log file and merges it in here.
 *
 * **Debug** turns both up. The viewer's half changes immediately; openDAQ's takes
 * effect on the next start, because its logger components take their level when
 * they are created and connecting a device creates more of them — so the panel
 * says so rather than pretending the change already applied.
 */
export function LogPanel() {
  const reportError = useSession((state) => state.reportError);
  const notify = useSession((state) => state.notify);

  const [level, setLevel] = useState<LogLevel>('info');
  const [source, setSource] = useState<'all' | 'viewer' | 'sdk'>('all');
  const [search, setSearch] = useState('');
  const [follow, setFollow] = useState(true);
  const [viewerLevel, setViewerLevel] = useState<LogLevel>('info');
  const [sdkLevel, setSdkLevel] = useState<LogLevel>('info');
  const [restartNeeded, setRestartNeeded] = useState(false);

  const settledSearch = useDebouncedValue(search.trim(), 300);
  const list = useRef<HTMLDivElement | null>(null);

  /**
   * What is on screen, and how far the backend has been read.
   *
   * They are one piece of state on purpose. Polling is incremental - each request
   * asks only for records after `since` - so the cursor and the records it
   * produced must be replaced together, or a filter change would leave the new
   * filter's older matches permanently unread.
   */
  const filterKey = `${level}|${source}|${settledSearch}`;
  const [feed, setFeed] = useState<{ key: string; since: number; entries: LogEntry[] }>({
    key: filterKey,
    since: 0,
    entries: [],
  });
  if (feed.key !== filterKey) {
    setFeed({ key: filterKey, since: 0, entries: [] });
  }

  usePolling(
    async (signal) => {
      try {
        const response = await api.system.logs(
          {
            level,
            source: source === 'all' ? undefined : source,
            search: settledSearch || undefined,
            since: feed.key === filterKey ? feed.since : 0,
            limit: 500,
          },
          signal,
        );
        setViewerLevel(response.viewerLevel);
        setSdkLevel(response.sdkLevel);
        if (response.entries.length === 0) return;
        setFeed((current) => {
          // A response that arrived after the filter moved on is not ours.
          if (current.key !== filterKey) return current;
          return {
            key: current.key,
            since: response.entries[response.entries.length - 1]!.seq,
            entries: [...current.entries, ...response.entries].slice(-KEEP),
          };
        });
      } catch (cause) {
        if (!(cause instanceof ApiError)) throw cause;
      }
    },
    700,
    [level, source, settledSearch],
  );

  useEffect(() => {
    if (!follow) return;
    const element = list.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [feed.entries, follow]);

  const debugOn = viewerLevel === 'debug' || viewerLevel === 'trace';

  const setDebug = useCallback(
    async (enabled: boolean) => {
      const next: LogLevel = enabled ? 'debug' : 'info';
      try {
        const result = await api.system.setLogLevel({ viewer: next, sdk: next });
        setViewerLevel(result.viewerLevel);
        setSdkLevel(result.sdkLevel);
        setRestartNeeded(result.restartRequired);
        setLevel(enabled ? 'debug' : 'info');
        if (!result.restartRequired) {
          notify('info', enabled ? 'Debug logging is on' : 'Debug logging is off');
        }
      } catch (cause) {
        reportError(cause, 'Could not change the log level');
      }
    },
    [notify, reportError],
  );

  const visible = feed.entries;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-2.5 py-1.5">
        <label className="flex items-center gap-1.5 text-[11.5px] text-text-muted">
          <Switch checked={debugOn} onChange={(value) => void setDebug(value)} label="Debug" />
          <Bug size={12} className={cn('shrink-0', debugOn ? 'text-brand' : 'text-text-faint')} aria-hidden />
          Debug
        </label>

        <span className="mx-1 h-4 w-px bg-border" />

        <span className="w-32">
          <Select
            value={level}
            onChange={(event) => setLevel(event.target.value as LogLevel)}
            aria-label="Quietest level to show"
            className="h-6.5 text-[11.5px]"
          >
            {LEVELS.map((entry) => (
              <option key={entry} value={entry}>
                {entry} and up
              </option>
            ))}
          </Select>
        </span>

        <span className="w-28">
          <Select
            value={source}
            onChange={(event) => setSource(event.target.value as typeof source)}
            aria-label="Which log to show"
            className="h-6.5 text-[11.5px]"
          >
            <option value="all">both</option>
            <option value="viewer">Studio</option>
            <option value="sdk">openDAQ</option>
          </Select>
        </span>

        <span className="w-44">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter…"
            className="h-6.5 text-[11.5px]"
            aria-label="Filter the log"
          />
        </span>

        <div className="ml-auto flex items-center gap-1">
          <Badge
            tone="neutral"
            title="openDAQ's own verbosity, fixed at start-up. How much it adds depends on the component: the protocol modules say a great deal more, the reference device says nothing below info."
          >
            SDK {sdkLevel}
          </Badge>
          <IconButton
            label={follow ? 'Stop following new records' : 'Follow new records'}
            active={follow}
            onClick={() => setFollow((value) => !value)}
          >
            <ArrowDownToLine size={13} />
          </IconButton>
          <IconButton
            label="Clear what is on screen"
            onClick={() => setFeed((current) => ({ ...current, entries: [] }))}
          >
            <Trash2 size={13} />
          </IconButton>
        </div>
      </div>

      {restartNeeded ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-warn/40 bg-warn-soft px-2.5 py-1.5 text-[11.5px]">
          <Power size={12} className="shrink-0 text-warn" aria-hidden />
          <span className="min-w-0 flex-1">
            openDAQ fixes each component's log level when it is created, so <strong>SDK {sdkLevel}</strong> applies
            when openDAQ Studio starts again. Studio's own records are already at {viewerLevel}.
          </span>
          <IconButton label="Dismiss" onClick={() => setRestartNeeded(false)}>
            <Trash2 size={12} />
          </IconButton>
        </div>
      ) : null}

      <div ref={list} className="min-h-0 flex-1 overflow-y-auto px-2.5 py-1 font-mono text-[11px]">
        {visible.length === 0 ? (
          <EmptyState
            className="h-full"
            title="Nothing at this level"
            description="Turn Debug on, or lower the level, to see more of what Studio and the SDK are doing."
          />
        ) : (
          visible.map((entry) => (
            <div key={`${entry.source}-${entry.seq}`} className="flex gap-2 py-px leading-relaxed">
              <span className="shrink-0 text-text-faint">{formatTimeOfDay(entry.at, 3)}</span>
              <span className={cn('w-14 shrink-0 uppercase', LEVEL_TONE[entry.level])}>{entry.level}</span>
              <span
                className={cn('w-12 shrink-0', entry.source === 'sdk' ? 'text-info' : 'text-text-faint')}
                title={entry.source === 'sdk' ? 'from openDAQ' : 'from Studio'}
              >
                {entry.source === 'sdk' ? 'openDAQ' : 'Studio'}
              </span>
              <span className="w-40 shrink-0 truncate text-text-muted" title={entry.origin}>
                {entry.origin}
              </span>
              <span className="min-w-0 flex-1 break-words whitespace-pre-wrap text-text">{entry.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
