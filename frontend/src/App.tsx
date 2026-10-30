import { useEffect } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { actions } from './lib/actions';
import { isTypingTarget } from './lib/utils';
import { DialogHost } from './components/dialogs/DialogHost';
import { CommandPalette } from './components/dialogs/CommandPalette';
import { EventLogDrawer } from './components/layout/EventLogDrawer';
import { StatusBar } from './components/layout/StatusBar';
import { Header } from './components/layout/Header';
import { SignalsPage } from './components/signals/SignalsPage';
import { ScopePage } from './components/scope/ScopePage';
import { ViewerPage } from './components/pages/ViewerPage';
import { TopologyPage } from './components/topology/TopologyPage';
import { FleetPage } from './components/pages/FleetPage';
import { ModulesPage } from './components/pages/ModulesPage';
import { HelpPanel } from './components/layout/HelpPanel';
import { useHelp } from './store/useHelp';
import { Button } from './components/ui/Button';
import { Spinner } from './components/ui/Feedback';
import { Toasts } from './components/ui/Toasts';
import { useDialogs } from './store/useDialogs';
import { useSession } from './store/useSession';
import { applyTheme, useSettings } from './store/useSettings';
import { Brand } from './components/layout/Brand';
import { workspaceForKey } from './lib/workspaces';
import { useNav } from './store/useNav';
import { resumeTrackSubscription } from './store/useTracks';

export function App() {
  const bootstrap = useSession((state) => state.bootstrap);
  const info = useSession((state) => state.info);
  const fatalError = useSession((state) => state.fatalError);
  const eventLogOpen = useSettings((state) => state.eventLogOpen);
  const theme = useSettings((state) => state.theme);
  const workspace = useNav((state) => state.workspace);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // The saved tracks start streaming as soon as the instance is reachable.
  useEffect(() => {
    if (info) resumeTrackSubscription();
  }, [info]);

  // Re-apply on change, and follow the system when "system" is selected.
  useEffect(() => {
    applyTheme(theme);
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => applyTheme('system');
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [theme]);

  useGlobalShortcuts();
  const helpOpen = useHelp((state) => state.open);

  if (fatalError) {
    return <StartupError message={fatalError} onRetry={() => void bootstrap()} />;
  }

  if (!info) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-text-muted">
        <Brand />
        <span className="flex items-center gap-2 text-[12.5px]">
          <Spinner size={14} /> Starting the openDAQ instance…
        </span>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <Header />

      {/* Keyed, so the arrival animation replays on every switch. */}
      <main key={workspace} className="animate-workspace flex min-h-0 flex-1 flex-col">
        {workspace === 'signals' ? <SignalsPage /> : null}
        {workspace === 'scope' ? <ScopePage /> : null}
        {workspace === 'devices' ? <ViewerPage /> : null}
        {workspace === 'flow' ? <TopologyPage /> : null}
        {workspace === 'fleet' ? <FleetPage /> : null}
        {workspace === 'modules' ? <ModulesPage /> : null}
      </main>
      {helpOpen ? <HelpPanel /> : null}

      {eventLogOpen ? <EventLogDrawer /> : null}
      <StatusBar />

      <DialogHost />
      <CommandPalette />
      <Toasts />
    </div>
  );
}

function StartupError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="panel max-w-lg p-5">
        <div className="flex items-start gap-3">
          <AlertCircle size={20} className="mt-0.5 shrink-0 text-err" aria-hidden />
          <div className="min-w-0">
            <h1 className="text-[15px] font-semibold">Cannot reach the openDAQ Studio backend</h1>
            <p className="mt-1 text-[12.5px] leading-relaxed text-text-muted">{message}</p>
            <p className="mt-3 text-[12.5px] leading-relaxed text-text-muted">
              Start it with <code className="rounded bg-sunken px-1 py-0.5 font-mono">opendaq-studio</code>,
              then reload. If the backend runs on another host or port, set{' '}
              <code className="rounded bg-sunken px-1 py-0.5 font-mono">VITE_API_BASE</code> when building the
              UI.
            </p>
            <div className="mt-4 flex gap-2">
              <Button variant="primary" icon={<RefreshCw size={12} />} onClick={onRetry}>
                Try again
              </Button>
              <Button onClick={() => window.location.reload()}>Reload the page</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Application-wide keyboard shortcuts.
 *
 * A measurement tool is used with one hand on the keyboard, so the things done
 * repeatedly (switching mode, saving a configuration, opening the command
 * palette) all have a key. Every handler bails out while the user is
 * typing in a field.
 */
function useGlobalShortcuts() {
  const togglePalette = useDialogs((state) => state.togglePalette);
  const openDialog = useDialogs((state) => state.open);
  const refreshTree = useSession((state) => state.refreshTree);
  const toggleSetting = useSettings((state) => state.toggle);

  useEffect(() => {
    const onKeyDown = async (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;

      if (modifier && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        togglePalette();
        return;
      }

      if (isTypingTarget(event.target)) return;

      if (modifier && event.key.toLowerCase() === 's') {
        event.preventDefault();
        await actions.saveConfiguration();
        return;
      }

      if (modifier) return;

      switch (event.key) {
        case '?':
          event.preventDefault();
          useHelp.getState().toggle();
          break;
        case 'Escape':
          useHelp.getState().close();
          break;
        // Digits select a mode by its position in the header.
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '6': {
          const target = workspaceForKey(event.key);
          if (target) useNav.getState().go(target);
          break;
        }
        case 'r':
          void refreshTree();
          break;
        case 'h':
          toggleSetting('includeHidden');
          void refreshTree();
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [openDialog, refreshTree, toggleSetting, togglePalette]);
}
