import { useMemo, useState } from 'react';
import { CircleDot, Link2, Minus, Pause, Play, Plus, Rows3, Settings2, Square } from 'lucide-react';
import { actions } from '../../lib/actions';
import { api } from '../../lib/api';
import type { ComponentNode } from '../../lib/types';
import { cn } from '../../lib/utils';
import { useDialogs } from '../../store/useDialogs';
import { go } from '../../store/useNav';
import { useSession } from '../../store/useSession';
import { stepWindow, useTracks, type TrackSize } from '../../store/useTracks';
import { traces } from '../../store/traceStore';
import { recorders, useSignalData } from './signalData';
import { TrackPicker } from './TrackPicker';
import { AlignToggle } from '../time/TimeSync';

const SIZES: { id: TrackSize; label: string }[] = [
  { id: 'compact', label: 'Compact tracks' },
  { id: 'normal', label: 'Normal tracks' },
  { id: 'large', label: 'Large tracks' },
];

/**
 * The bar above the tracks. On the left, the recorder function blocks of the
 * instance, such as the CSV and Parquet recorders, each started and stopped
 * through openDAQ's recorder interface. On the right, how much time the tracks
 * show and whether they follow live.
 */
export function TransportBar() {
  const tree = useSession((state) => state.tree);
  const readOnly = useSession((state) => Boolean(state.info?.readOnly));
  const openDialog = useDialogs((state) => state.open);
  const windowSeconds = useTracks((state) => state.windowSeconds);
  const frozenEnd = useTracks((state) => state.frozenEnd);
  const size = useTracks((state) => state.size);
  const { setWindow, pause, setSize } = useTracks.getState();
  const list = useMemo(() => recorders(tree), [tree]);

  return (
    <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-panel px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
        {list.length === 0 ? (
          <>
            <span className="truncate text-[12.5px] text-text-muted">No recorder function block is in the instance.</span>
            <button
              type="button"
              disabled={readOnly}
              onClick={() => openDialog({ kind: 'addFunctionBlock', parentId: null })}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-border px-3 text-[12.5px] font-medium hover:border-border-strong disabled:opacity-40"
            >
              <CircleDot size={13} className="text-err" /> Add a recorder
            </button>
          </>
        ) : (
          list.map((recorder) => <RecorderControl key={recorder.id} recorder={recorder} readOnly={readOnly} />)
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <AlignToggle />
        <TrackPicker />
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        <div className="inline-flex items-center rounded-full border border-border" role="group" aria-label="Time window">
          <button type="button" onClick={() => setWindow(stepWindow(windowSeconds, -1))} aria-label="Show less time" className="rounded-l-full px-2 py-1.5 text-text-muted hover:text-text">
            <Minus size={12} />
          </button>
          <span className="num min-w-12 text-center text-[12px] tabular">
            {windowSeconds >= 60 ? `${formatWindow(windowSeconds / 60)} min` : `${formatWindow(windowSeconds)} s`}
          </span>
          <button type="button" onClick={() => setWindow(stepWindow(windowSeconds, 1))} aria-label="Show more time" className="rounded-r-full px-2 py-1.5 text-text-muted hover:text-text">
            <Plus size={12} />
          </button>
        </div>
        <button
          type="button"
          onClick={() => pause(frozenEnd === null ? (traces.latestTime() ?? Date.now() / 1000) : null)}
          title={frozenEnd === null ? 'Pause the tracks (Space)' : 'Follow live again (Space)'}
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-medium',
            frozenEnd === null ? 'text-text-muted hover:bg-sunken hover:text-text' : 'bg-accent text-white',
          )}
        >
          {frozenEnd === null ? <Pause size={12} /> : <Play size={12} />}
          {frozenEnd === null ? 'Live' : 'Paused'}
        </button>
        <button
          type="button"
          onClick={() => setSize(SIZES[(SIZES.findIndex((entry) => entry.id === size) + 1) % SIZES.length]!.id)}
          title={`${SIZES.find((entry) => entry.id === size)?.label}. Click for the next size.`}
          aria-label="Change the track height"
          className="inline-flex size-7 items-center justify-center rounded-full text-text-muted hover:bg-sunken hover:text-text"
        >
          <Rows3 size={14} />
        </button>
      </div>
    </div>
  );
}

/**
 * One recorder: its name, how many signals its input ports read, Record and
 * Stop, and a way to connect the tracks shown to its input ports.
 */
function RecorderControl({ recorder, readOnly }: { recorder: ComponentNode; readOnly: boolean }) {
  const notify = useSession((state) => state.notify);
  const select = useSession((state) => state.select);
  const tracks = useTracks((state) => state.tracks);
  const byId = useSignalData((state) => state.byId);
  const [busy, setBusy] = useState(false);
  const recording = Boolean(recorder.functionBlock?.isRecording);
  const ports = recorder.children.flatMap((child) => (child.kind === 'inputPort' ? [child] : child.children.filter((inner) => inner.kind === 'inputPort')));
  const connected = new Set(ports.map((port) => port.inputPort?.signalId).filter((id): id is string => Boolean(id)));
  // Array tracks (spectra) are left to the user: recorders write one value per sample.
  const missing = tracks.filter((id) => byId.get(id)?.chartable && !connected.has(id));

  // Connect each track to the next free input port. Recorders such as the CSV
  // recorder add a new free port whenever one is connected.
  const connectTracks = async () => {
    setBusy(true);
    try {
      for (const signalId of missing) {
        const { ports: current } = await api.topology.inputPorts(recorder.id);
        const free = current.find((port) => !port.signalId);
        if (!free) {
          notify('warning', `${recorder.name} has no free input port`, 'It records the signals that are already connected.');
          break;
        }
        await api.topology.connectPort(free.id, signalId);
      }
      await useSession.getState().refreshTree({ silent: true });
    } catch (error) {
      notify('error', 'The tracks were not connected', error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn('flex shrink-0 items-center gap-2 rounded-full border py-1 pr-1 pl-3', recording ? 'border-err/40 bg-err-soft' : 'border-border')}>
      {recording ? <span className="live-dot text-err" aria-hidden /> : <CircleDot size={13} className="text-text-faint" aria-hidden />}
      <span className="max-w-40 truncate text-[12.5px] font-medium" title={recorder.id}>
        {recorder.displayName || recorder.name}
      </span>
      <span className="text-[11.5px] text-text-faint">
        {connected.size} signal{connected.size === 1 ? '' : 's'}
      </span>
      {missing.length && !recording ? (
        <button
          type="button"
          disabled={readOnly || busy}
          onClick={() => void connectTracks()}
          title={`Connect the ${missing.length} track${missing.length === 1 ? '' : 's'} not yet recorded to free input ports.`}
          className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-[12px] text-accent hover:bg-accent-soft disabled:opacity-40"
        >
          <Link2 size={12} /> Connect the tracks
        </button>
      ) : null}
      <button
        type="button"
        disabled={readOnly || (!recording && connected.size === 0)}
        onClick={() => void actions.setRecording(recorder.id, !recording)}
        title={connected.size === 0 && !recording ? 'Connect at least one signal first.' : undefined}
        className={cn(
          'inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] font-semibold text-white transition-transform active:scale-[0.97] disabled:opacity-40',
          'bg-err',
        )}
      >
        {recording ? <Square size={10} fill="currentColor" /> : <CircleDot size={12} />}
        {recording ? 'Stop' : 'Record'}
      </button>
      <button
        type="button"
        onClick={() => {
          void select(recorder.id);
          go('devices');
        }}
        aria-label={`Configure ${recorder.name}`}
        title="Open the recorder's properties, such as where it writes its files."
        className="inline-flex size-7 items-center justify-center rounded-full text-text-muted hover:bg-sunken hover:text-text"
      >
        <Settings2 size={13} />
      </button>
    </div>
  );
}

function formatWindow(value: number): string {
  return String(Number(value.toPrecision(3)));
}
