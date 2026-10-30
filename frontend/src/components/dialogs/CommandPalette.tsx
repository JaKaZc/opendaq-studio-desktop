import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleHelp, Package, Plus, Puzzle, Radio, RefreshCw, Save, Search, Upload } from 'lucide-react';
import { actions } from '../../lib/actions';
import { shortenGlobalId } from '../../lib/format';
import { cn } from '../../lib/utils';
import { searchComponents } from '../../lib/views';
import { useHelp } from '../../store/useHelp';
import { go } from '../../store/useNav';
import { useTracks } from '../../store/useTracks';
import { useDialogs } from '../../store/useDialogs';
import { useSession } from '../../store/useSession';
import { NodeIcon } from '../tree/NodeIcon';
import { shortcutFor, WORKSPACES } from '../../lib/workspaces';

interface Entry {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  group: 'Components' | 'Actions' | 'Go to';
  run: () => void;
}

/**
 * Command palette.
 *
 * On an instance with a few hundred components, typing three letters beats
 * expanding four levels of tree. It searches components by name, id, description
 * and tag, and also carries the actions that would otherwise be buried in a menu.
 */
export function CommandPalette() {
  const open = useDialogs((state) => state.paletteOpen);
  // Mounting the contents only while open means the query and highlight start
  // fresh every time, with no effect resetting them after the fact.
  return open ? <PaletteContents /> : null;
}

function PaletteContents() {
  const setOpen = useDialogs((state) => state.setPaletteOpen);
  const openDialog = useDialogs((state) => state.open);
  const tree = useSession((state) => state.tree);
  const select = useSession((state) => state.select);
  const refreshTree = useSession((state) => state.refreshTree);
  const readOnly = useSession((state) => state.info?.readOnly ?? false);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const entries = useMemo<Entry[]>(() => {
    const list: Entry[] = [];
    const needle = query.trim().toLowerCase();

    // Components first: that is what the palette is mostly used for.
    if (tree) {
      const hits = searchComponents(tree, query, needle ? 25 : 8);
      for (const hit of hits) {
        list.push({
          id: `component:${hit.node.id}`,
          label: hit.node.displayName || hit.node.localId,
          hint: shortenGlobalId(hit.node.id) || hit.node.id,
          icon: <NodeIcon kind={hit.node.kind} />,
          group: 'Components',
          run: () => {
            // A signal from the palette almost always means "show me this", so
            // it becomes a selected track; anything else opens in Devices.
            if (hit.node.kind === 'signal' && hit.node.signal?.hasDescriptor) {
              useTracks.getState().addTracks([hit.node.id]);
              useTracks.getState().select({ kind: 'track', id: hit.node.id });
              go('signals');
              return;
            }
            go('devices');
            void select(hit.node.id);
          },
        });
      }
    }

    const allCommands: Entry[] = [
      {
        id: 'add-device',
        label: 'Add device…',
        icon: <Plus size={13} />,
        group: 'Actions',
        run: () => openDialog({ kind: 'addDevice', parentId: null }),
      },
      {
        id: 'add-fb',
        label: 'Add function block…',
        icon: <Package size={13} />,
        group: 'Actions',
        run: () => openDialog({ kind: 'addFunctionBlock', parentId: null }),
      },
      {
        id: 'add-server',
        label: 'Add server…',
        icon: <Radio size={13} />,
        group: 'Actions',
        run: () => openDialog({ kind: 'addServer' }),
      },
      {
        id: 'save-config',
        label: 'Save the configuration',
        icon: <Save size={13} />,
        group: 'Actions',
        run: () => void actions.saveConfiguration(),
      },
      {
        id: 'load-config',
        label: 'Load a configuration…',
        icon: <Upload size={13} />,
        group: 'Actions',
        run: () => openDialog({ kind: 'loadConfiguration' }),
      },
      {
        id: 'load-module',
        label: 'Load a module…',
        icon: <Puzzle size={13} />,
        group: 'Actions',
        run: () => openDialog({ kind: 'loadModule' }),
      },
      {
        id: 'help',
        label: 'Help for this mode',
        icon: <CircleHelp size={13} />,
        group: 'Actions',
        run: () => useHelp.getState().toggle(),
      },
      {
        id: 'refresh',
        label: 'Refresh the component tree',
        icon: <RefreshCw size={13} />,
        group: 'Actions',
        run: () => void refreshTree(),
      },
    ];
    // In read-only mode only the harmless commands are offered.
    const commands = allCommands.filter(
      (entry) => !readOnly || ['refresh', 'save-config', 'help'].includes(entry.id),
    );

    // Derived from the header's own list, so a new mode is reachable here too.
    const destinations: Entry[] = WORKSPACES.map((mode) => ({
      id: `go-${mode.id}`,
      label: mode.label,
      icon: <mode.icon size={13} />,
      group: 'Go to',
      hint: shortcutFor(mode.id),
      run: () => go(mode.id),
    }));

    const matches = (entry: Entry) => !needle || entry.label.toLowerCase().includes(needle);
    return [...list, ...commands.filter(matches), ...destinations.filter(matches)];
  }, [openDialog, query, readOnly, refreshTree, select, tree]);

  // Clamped on read rather than corrected in an effect: typing a narrower query
  // shortens the list, and the highlight should follow immediately.
  const activeIndex = Math.min(active, Math.max(0, entries.length - 1));

  useEffect(() => {
    const element = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    element?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const run = (entry: Entry | undefined) => {
    if (!entry) return;
    setOpen(false);
    entry.run();
  };

  let lastGroup = '';

  return createPortal(
    <div className="fixed inset-0 z-70 flex items-start justify-center p-4 pt-[12vh]">
      <div
        className="fixed inset-0 bg-[color-mix(in_oklab,var(--color-brand-navy)_50%,transparent)] backdrop-blur-[2px]"
        onClick={() => setOpen(false)}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="panel relative z-10 flex max-h-[64vh] w-full max-w-2xl flex-col overflow-hidden shadow-[var(--shadow-popover)]"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
          <Search size={16} className="shrink-0 text-brand" aria-hidden />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a component, or a command…"
            aria-label="Find a component or a command"
            className="min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-text-faint"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setOpen(false);
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((current) => Math.min(entries.length - 1, current + 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((current) => Math.max(0, current - 1));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                run(entries[activeIndex]);
              }
            }}
          />
          <kbd className="shrink-0 rounded border border-border-strong bg-sunken px-1 text-[10px] text-text-faint">
            esc
          </kbd>
        </div>

        <ul ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1" role="listbox">
          {entries.length === 0 ? (
            <li className="px-3 py-4 text-center text-[12px] text-text-muted">Nothing matches.</li>
          ) : (
            entries.map((entry, index) => {
              const showGroup = entry.group !== lastGroup;
              lastGroup = entry.group;
              return (
                <li key={entry.id}>
                  {showGroup ? (
                    <p className="px-3 pt-2 pb-1 text-[10px] font-semibold tracking-wide text-text-faint uppercase">
                      {entry.group}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    data-active={index === activeIndex}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => run(entry)}
                    className={cn(
                      'flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[12.5px]',
                      index === activeIndex ? 'bg-accent-soft' : 'hover:bg-sunken',
                    )}
                  >
                    <span className="flex w-4 shrink-0 justify-center text-text-muted">{entry.icon}</span>
                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                    {entry.hint ? (
                      <span className="min-w-0 shrink truncate font-mono text-[10.5px] text-text-faint">
                        {entry.hint}
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>

        <footer className="flex items-center gap-3 border-t border-border bg-sunken px-3 py-1.5 text-[10.5px] text-text-faint">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span className="ml-auto">
            {entries.length} result{entries.length === 1 ? '' : 's'}
          </span>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
