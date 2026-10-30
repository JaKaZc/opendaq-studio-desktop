import { ExternalLink } from 'lucide-react';
import { MOD_KEY } from '../../lib/utils';
import { useDialogs } from '../../store/useDialogs';
import { useSession } from '../../store/useSession';
import { useSettings } from '../../store/useSettings';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Field';
import { InfoRow } from '../ui/Feedback';
import { Modal } from '../ui/Modal';
import { Brand } from '../layout/Brand';

/** Choose which property metadata columns the grid shows. */
export function MetadataColumnsDialog() {
  const close = useDialogs((state) => state.close);
  const fields = useSession((state) => state.metadataFields);
  const columns = useSettings((state) => state.metadataColumns);
  const setMetadataColumns = useSettings((state) => state.setMetadataColumns);

  const toggle = (key: string) => {
    setMetadataColumns(
      columns.includes(key) ? columns.filter((entry) => entry !== key) : [...columns, key],
    );
  };

  return (
    <Modal
      open
      onClose={close}
      title="Property metadata columns"
      description="Extra columns shown beside each property value."
      size="sm"
      footer={
        <>
          <Button onClick={() => setMetadataColumns([])} disabled={columns.length === 0}>
            Show none
          </Button>
          <Button variant="primary" onClick={close} data-autofocus>
            Done
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        {fields.map((field) => (
          <Checkbox
            key={field.key}
            checked={columns.includes(field.key)}
            onChange={() => toggle(field.key)}
            label={field.label}
            hint={field.key}
          />
        ))}
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-text-muted">
        The list comes from the backend, so it stays in step with whatever the SDK exposes.
      </p>
    </Modal>
  );
}

const SHORTCUTS: { keys: string; action: string; scope: string }[] = [
  { keys: `${MOD_KEY} K`, action: 'Open the command palette', scope: 'Anywhere' },
  { keys: `${MOD_KEY} S`, action: 'Save the configuration to a file', scope: 'Anywhere' },
  { keys: '1 … 6', action: 'Switch mode, in the order of the header', scope: 'Anywhere' },
  { keys: 'R', action: 'Refresh the component tree', scope: 'Anywhere' },
  { keys: 'H', action: 'Show or hide hidden components', scope: 'Anywhere' },
  { keys: '?', action: 'Show this list', scope: 'Anywhere' },
  { keys: '↑ ↓', action: 'Move between components', scope: 'Navigator' },
  { keys: '→ ←', action: 'Expand or collapse a node', scope: 'Navigator' },
  { keys: 'Home / End', action: 'Jump to the first or last component', scope: 'Navigator' },
  { keys: 'Right-click', action: 'Component actions', scope: 'Navigator' },
  { keys: 'Space', action: 'Pause the tracks, or follow live again', scope: 'Signals' },
  { keys: '↑ ↓', action: 'Select the previous or next track', scope: 'Signals' },
  { keys: '⌘ or Ctrl + scroll', action: 'Show more or less time', scope: 'Signals' },
  { keys: 'Sideways scroll', action: 'Look back in time (pauses)', scope: 'Signals' },
  { keys: 'L', action: 'Jump back to the newest samples', scope: 'Scope' },
  { keys: 'Space', action: 'Pause or resume the stream', scope: 'Scope' },
  { keys: 'Drag', action: 'Pan the time axis (freezes the view)', scope: 'Scope' },
  { keys: 'Scroll', action: 'Zoom the time axis around the pointer', scope: 'Scope' },
  { keys: 'Shift + drag', action: 'Place the measurement cursors', scope: 'Scope' },
  { keys: 'Double-click', action: 'Return to the live edge', scope: 'Scope' },
  { keys: 'Enter', action: 'Commit an edit', scope: 'Property grid' },
  { keys: 'Escape', action: 'Cancel an edit, or close a dialog', scope: 'Anywhere' },
];

export function ShortcutsDialog() {
  const close = useDialogs((state) => state.close);

  return (
    <Modal
      open
      onClose={close}
      title="Keyboard shortcuts"
      size="md"
      footer={
        <Button variant="primary" onClick={close} data-autofocus>
          Close
        </Button>
      }
    >
      <table className="w-full border-collapse text-[12.5px]">
        <tbody>
          {SHORTCUTS.map((entry) => (
            <tr key={`${entry.scope}-${entry.keys}`} className="border-b border-border/60 last:border-b-0">
              <td className="w-28 py-1.5 pr-2">
                <kbd className="rounded border border-border-strong bg-sunken px-1.5 py-0.5 font-mono text-[11px]">
                  {entry.keys}
                </kbd>
              </td>
              <td className="py-1.5 pr-2">{entry.action}</td>
              <td className="py-1.5 text-right text-[11.5px] text-text-faint">{entry.scope}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Modal>
  );
}

export function AboutDialog() {
  const close = useDialogs((state) => state.close);
  const info = useSession((state) => state.info);

  return (
    <Modal
      open
      onClose={close}
      title="About openDAQ Studio"
      size="sm"
      footer={
        <Button variant="primary" onClick={close} data-autofocus>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <Brand />

        <dl>
          <InfoRow label="Studio version" mono>
            {info?.appVersion ?? '—'}
          </InfoRow>
          <InfoRow label="API contract" mono>
            {info?.apiVersion ?? '—'}
          </InfoRow>
          <InfoRow label="openDAQ SDK" mono>
            {info?.sdkVersion ?? '—'}
          </InfoRow>
          <InfoRow label="Instance" mono>
            {info?.name ?? '—'}
          </InfoRow>
          <InfoRow label="Discovery">
            {info?.discoveryServers.length ? info.discoveryServers.join(', ') : 'disabled'}
          </InfoRow>
          <InfoRow label="Mode">{info?.readOnly ? 'read-only' : 'read/write'}</InfoRow>
        </dl>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            icon={<ExternalLink size={11} />}
            onClick={() => window.open('https://opendaq.com', '_blank', 'noopener')}
          >
            opendaq.com
          </Button>
          <Button
            size="sm"
            icon={<ExternalLink size={11} />}
            onClick={() => window.open('https://docs.opendaq.com', '_blank', 'noopener')}
          >
            SDK documentation
          </Button>
        </div>
      </div>
    </Modal>
  );
}
