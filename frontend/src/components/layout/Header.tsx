import {
  CircleHelp,
  Bell,
  Command,
  Eye,
  EyeOff,
  Keyboard,
  Monitor,
  Moon,
  Package,
  Plus,
  Puzzle,
  Radio,
  Save,
  Settings,
  Sun,
  Upload,
} from 'lucide-react';
import { actions } from '../../lib/actions';
import { cn, MOD_KEY } from '../../lib/utils';
import { useDialogs } from '../../store/useDialogs';
import { useSession } from '../../store/useSession';
import { useSettings, type ThemeChoice, applyTheme } from '../../store/useSettings';
import { IconButton } from '../ui/Button';
import { Badge } from '../ui/Feedback';
import { MenuButton, type MenuItem } from '../ui/Menu';
import { shortcutFor, WORKSPACES } from '../../lib/workspaces';
import { useNav } from '../../store/useNav';
import { useHelp } from '../../store/useHelp';
import { walk } from '../../lib/views';
import { Brand } from './Brand';

/**
 * The one bar of the application.
 *
 * The modes sit on the left in plain words, so there is no menu to learn.
 * The command field in the middle reaches anything by typing. On the right is
 * what must be visible from every mode: a running recording, active alarms and
 * whether the data is live.
 */
export function Header() {
  const workspace = useNav((state) => state.workspace);
  const go = useNav((state) => state.go);
  const info = useSession((state) => state.info);
  const connection = useSession((state) => state.connection);
  const unreadLog = useSession((state) => state.unreadLog);
  const openDialog = useDialogs((state) => state.open);
  const togglePalette = useDialogs((state) => state.togglePalette);
  const helpOpen = useHelp((state) => state.open);
  const toggleHelp = useHelp((state) => state.toggle);

  const theme = useSettings((state) => state.theme);
  const includeHidden = useSettings((state) => state.includeHidden);
  const eventLogOpen = useSettings((state) => state.eventLogOpen);
  const setSetting = useSettings((state) => state.set);
  const toggleSetting = useSettings((state) => state.toggle);

  const readOnly = Boolean(info?.readOnly);

  const addMenu: MenuItem[] = [
    {
      id: 'device',
      label: 'Device…',
      icon: <Plus size={13} />,
      disabled: readOnly,
      onSelect: () => openDialog({ kind: 'addDevice', parentId: null }),
    },
    {
      id: 'functionBlock',
      label: 'Function block…',
      icon: <Package size={13} />,
      disabled: readOnly,
      onSelect: () => openDialog({ kind: 'addFunctionBlock', parentId: null }),
    },
    {
      id: 'server',
      label: 'Server…',
      icon: <Radio size={13} />,
      disabled: readOnly,
      onSelect: () => openDialog({ kind: 'addServer' }),
    },
  ];

  const fileMenu: MenuItem[] = [
    {
      id: 'save',
      label: 'Save configuration',
      icon: <Save size={13} />,
      hint: `${MOD_KEY}S`,
      onSelect: () => void actions.saveConfiguration(),
    },
    {
      id: 'load',
      label: 'Load configuration…',
      icon: <Upload size={13} />,
      disabled: readOnly,
      onSelect: () => openDialog({ kind: 'loadConfiguration' }),
    },
    {
      id: 'module',
      label: 'Load module…',
      icon: <Puzzle size={13} />,
      disabled: readOnly,
      separatorBefore: true,
      onSelect: () => openDialog({ kind: 'loadModule' }),
    },
  ];

  const settingsMenu: MenuItem[] = [
    { id: 'view', label: 'View', heading: true },
    {
      id: 'hidden',
      label: includeHidden ? 'Hide hidden components' : 'Show hidden components',
      icon: includeHidden ? <EyeOff size={13} /> : <Eye size={13} />,
      onSelect: () => {
        toggleSetting('includeHidden');
        void useSession.getState().refreshTree();
      },
    },
    {
      id: 'columns',
      label: 'Property metadata columns…',
      onSelect: () => openDialog({ kind: 'metadataColumns' }),
    },
    {
      id: 'confirm',
      label: useSettings.getState().confirmDestructive
        ? 'Stop confirming destructive actions'
        : 'Confirm destructive actions',
      onSelect: () => toggleSetting('confirmDestructive'),
    },
    { id: 'theme', label: 'Theme', heading: true, separatorBefore: true },
    ...(['light', 'dark', 'system'] as ThemeChoice[]).map((choice) => ({
      id: `theme-${choice}`,
      label: choice === 'system' ? 'Match the system' : choice === 'light' ? 'Light' : 'Dark',
      icon:
        choice === 'light' ? <Sun size={13} /> : choice === 'dark' ? <Moon size={13} /> : <Monitor size={13} />,
      hint: theme === choice ? '✓' : undefined,
      onSelect: () => {
        setSetting('theme', choice);
        applyTheme(choice);
      },
    })),
    {
      id: 'shortcuts',
      label: 'Keyboard shortcuts',
      icon: <Keyboard size={13} />,
      separatorBefore: true,
      hint: '?',
      onSelect: () => openDialog({ kind: 'shortcuts' }),
    },
    { id: 'about', label: 'About openDAQ Studio', onSelect: () => openDialog({ kind: 'about' }) },
  ];

  return (
    <header className="relative flex h-12 shrink-0 items-center gap-3 border-b border-border bg-panel px-3">
      {/* The manual's core graphic element as a hairline: brand, not decoration. */}
      <div className="brand-gradient absolute inset-x-0 top-0 h-0.5" aria-hidden />

      <Brand />
      <nav aria-label="Modes" className="flex items-center gap-0.5" role="tablist">
        {WORKSPACES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={entry.id === workspace}
            onClick={() => go(entry.id)}
            title={`${entry.hint} (${shortcutFor(entry.id)})`}
            className={cn(
              'relative inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors',
              entry.id === workspace ? 'bg-accent-soft text-accent' : 'text-text-muted hover:bg-sunken hover:text-text',
            )}
          >
            <entry.icon size={14} aria-hidden />
            {/* Between the two widths only the open mode keeps its name, so the bar fits. */}
            <span className={entry.id === workspace ? 'hidden lg:inline' : 'hidden xl:inline'}>{entry.label}</span>
          </button>
        ))}
      </nav>

      <div className="flex min-w-0 flex-1 justify-center">
        <button
          type="button"
          onClick={togglePalette}
          className={cn(
            'hidden h-9 w-full max-w-xl items-center gap-2.5 rounded-full border border-border bg-sunken px-4 text-[13px] text-text-faint md:flex',
            'transition-colors duration-150 hover:border-border-strong hover:text-text-muted',
          )}
          aria-label="Open the command bar"
        >
          <Command size={14} className="text-brand" />
          <span className="flex-1 truncate text-left">
            Find a device, signal, function block or command
          </span>
          <kbd className="rounded-md border border-border-strong bg-panel px-1.5 py-px text-[10px] font-medium">
            {MOD_KEY}K
          </kbd>
        </button>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <RecordingIndicator onOpen={() => go('signals')} />
        {readOnly ? <Badge tone="warn">read-only</Badge> : null}
        <ConnectionBadge state={connection} />

        <MenuButton
          items={fileMenu}
          ariaLabel="File"
          className="inline-flex h-8 items-center rounded-[var(--radius-control)] px-2.5 text-[12.5px] text-text-muted hover:bg-sunken hover:text-text"
        >
          File
        </MenuButton>

        <MenuButton
          items={addMenu}
          ariaLabel="Add"
          className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] bg-brand px-3 text-[12.5px] font-medium text-brand-contrast shadow-sm transition-colors hover:bg-brand-orange-600"
        >
          <Plus size={14} />
          Add
        </MenuButton>

        <span className="mx-0.5 h-5 w-px bg-border" aria-hidden />

        <IconButton label="Help for this mode (?)" active={helpOpen} onClick={toggleHelp}>
          <CircleHelp size={15} />
        </IconButton>
        <IconButton
          label={eventLogOpen ? 'Hide the event log' : 'Show the event log'}
          active={eventLogOpen}
          onClick={() => {
            toggleSetting('eventLogOpen');
            useSession.getState().markLogRead();
          }}
          className="relative"
        >
          <Bell size={15} />
          {unreadLog > 0 ? (
            <span className="absolute top-1.5 right-1.5 size-2 rounded-full border-2 border-panel bg-err" aria-hidden />
          ) : null}
        </IconButton>

        <MenuButton
          items={settingsMenu}
          ariaLabel="Settings"
          className="inline-flex size-8 items-center justify-center rounded-[var(--radius-control)] text-text-muted hover:bg-sunken hover:text-text"
        >
          <Settings size={15} />
        </MenuButton>
      </div>
    </header>
  );
}

function ConnectionBadge({ state }: { state: string }) {
  const label =
    state === 'open'
      ? 'Live'
      : state === 'connecting'
        ? 'Connecting'
        : state === 'reconnecting'
          ? 'Reconnecting'
          : 'Offline';
  const tone =
    state === 'open' ? 'text-ok' : state === 'reconnecting' || state === 'connecting' ? 'text-warn' : 'text-err';
  return (
    <span
      className="inline-flex h-7 items-center gap-2 rounded-full border border-border bg-sunken px-2.5 text-[11.5px] font-medium text-text-muted"
      title={`Realtime connection: ${label.toLowerCase()}`}
    >
      {/* Breathing while connected: the one element that is always moving says
          the data on screen is current. */}
      <span
        className={cn(state === 'open' ? 'live-dot' : 'size-[7px] animate-pulse rounded-full bg-current', tone)}
        aria-hidden
      />
      {label}
    </span>
  );
}

/**
 * Whether any recorder function block is recording, visible from every mode:
 * someone changing a device setting must still see that a recorder is writing.
 */
function RecordingIndicator({ onOpen }: { onOpen: () => void }) {
  const tree = useSession((state) => state.tree);
  let count = 0;
  if (tree) walk(tree, (node) => node.functionBlock?.isRecording && (count += 1));
  if (!count) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${count} recorder${count === 1 ? ' is' : 's are'} recording.`}
      className="inline-flex h-7 items-center gap-2 rounded-full bg-err px-3 text-[11.5px] font-semibold text-white"
    >
      <span className="live-dot text-white" aria-hidden />
      REC{count > 1 ? ` ${count}` : ''}
    </button>
  );
}
