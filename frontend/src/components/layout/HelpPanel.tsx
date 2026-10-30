import { CircleHelp, Keyboard, X } from 'lucide-react';
import { HELP } from '../../lib/help';
import { shortcutFor, WORKSPACES, workspaceEntry } from '../../lib/workspaces';
import { useDialogs } from '../../store/useDialogs';
import { useHelp } from '../../store/useHelp';
import { useNav } from '../../store/useNav';

/**
 * Help for the mode in view: what it is for, how to begin and what saves
 * time. Below it, every mode with its purpose, so the whole application
 * can be learned from one place.
 */
export function HelpPanel() {
  const workspace = useNav((state) => state.workspace);
  const go = useNav((state) => state.go);
  const close = useHelp((state) => state.close);
  const openDialog = useDialogs((state) => state.open);
  const entry = workspaceEntry(workspace);
  const help = HELP[workspace];

  return (
    <aside
      aria-label="Help"
      className="animate-enter absolute top-12 right-0 bottom-0 z-30 flex w-[380px] flex-col border-l border-border bg-panel shadow-popover"
    >
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <CircleHelp size={16} className="text-brand" />
        <h2 className="text-[14px] font-semibold">Help</h2>
        <button type="button" aria-label="Close the help" onClick={close} className="ml-auto rounded-full p-1 text-text-faint hover:bg-sunken hover:text-text">
          <X size={15} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
        <div className="flex items-center gap-2">
          <entry.icon size={16} className="text-brand" />
          <h3 className="text-[15px] font-semibold">{entry.label}</h3>
        </div>
        <p className="mt-2 text-[13px] leading-relaxed text-text">{help.purpose}</p>

        <h4 className="mt-5 text-[11px] font-semibold tracking-[0.08em] text-text-faint uppercase">How to start</h4>
        <ol className="mt-2 space-y-2">
          {help.steps.map((step, index) => (
            <li key={step} className="flex gap-2.5 text-[12.5px] leading-snug">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-soft text-[11px] font-bold text-brand">{index + 1}</span>
              {step}
            </li>
          ))}
        </ol>

        <h4 className="mt-5 text-[11px] font-semibold tracking-[0.08em] text-text-faint uppercase">Tips</h4>
        <ul className="mt-2 space-y-1.5">
          {help.tips.map((tip) => (
            <li key={tip} className="border-l-2 border-accent/40 pl-2.5 text-[12.5px] leading-snug text-text-muted">
              {tip}
            </li>
          ))}
        </ul>

        <h4 className="mt-6 text-[11px] font-semibold tracking-[0.08em] text-text-faint uppercase">All modes</h4>
        <ul className="mt-2 space-y-0.5">
          {WORKSPACES.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => go(item.id)}
                className="row-hover flex w-full items-start gap-2.5 rounded-[8px] px-2 py-1.5 text-left"
              >
                <item.icon size={14} className="mt-0.5 shrink-0 text-text-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] font-medium">{item.label}</span>
                  <span className="block text-[11.5px] text-text-muted">{item.hint}</span>
                </span>
                <kbd className="rounded border border-border px-1.5 text-[10px] text-text-faint">{shortcutFor(item.id)}</kbd>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex gap-2 border-t border-border px-4 py-3">
        <button
          type="button"
          onClick={() => openDialog({ kind: 'shortcuts' })}
          className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-control)] border border-border px-3 text-[12px] hover:bg-sunken"
        >
          <Keyboard size={13} /> Keyboard shortcuts
        </button>
      </div>
    </aside>
  );
}
