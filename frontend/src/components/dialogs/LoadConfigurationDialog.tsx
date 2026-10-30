import { useRef, useState } from 'react';
import { FileJson, Upload } from 'lucide-react';
import { actions } from '../../lib/actions';
import { api } from '../../lib/api';
import { formatBytes } from '../../lib/format';
import { readFileAsText } from '../../lib/utils';
import type { ConfigurationInspection, DaqValue, DeviceUpdateMode, DeviceUpdateOption } from '../../lib/types';
import { useDialogs } from '../../store/useDialogs';
import { useSession } from '../../store/useSession';
import { Button } from '../ui/Button';
import { Field, Input, Select } from '../ui/Field';
import { Badge, EmptyState, InfoRow, Spinner } from '../ui/Feedback';
import { Modal } from '../ui/Modal';
import { ConfigEditor, type ConfigValues } from './ConfigEditor';

type DeviceOverrides = Record<string, { updateMode?: DeviceUpdateMode; newConnectionString?: string }>;

/**
 * Load a saved configuration.
 *
 * The file is inspected before anything is applied, which is what makes replaying
 * a lab configuration against different hardware practical: for each device in the
 * file you can keep it, skip it, remove it, or remap it to another connection
 * string. Nothing touches the running instance until Apply.
 */
export function LoadConfigurationDialog() {
  const close = useDialogs((state) => state.close);
  const reportError = useSession((state) => state.reportError);
  const fileRef = useRef<HTMLInputElement>(null);

  const [filename, setFilename] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [inspection, setInspection] = useState<ConfigurationInspection | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [parameters, setParameters] = useState<ConfigValues>({});
  const [overrides, setOverrides] = useState<DeviceOverrides>({});
  const [applying, setApplying] = useState(false);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setFilename(file.name);
    setInspecting(true);
    setInspection(null);
    setOverrides({});
    setParameters({});
    try {
      const text = await readFileAsText(file);
      setContent(text);
      const response = await api.configuration.inspect(text);
      setInspection(response);
    } catch (error) {
      reportError(error, 'Could not read the configuration');
      setContent(null);
    } finally {
      setInspecting(false);
    }
  };

  const apply = async () => {
    if (!content) return;
    setApplying(true);
    const result = await actions.loadConfiguration(
      content,
      Object.keys(parameters).length ? (parameters as Record<string, DaqValue>) : undefined,
      Object.keys(overrides).length ? overrides : undefined,
    );
    setApplying(false);
    if (result) close();
  };

  return (
    <Modal
      open
      onClose={close}
      title="Load configuration"
      description="Restore devices, function blocks and property values from an openDAQ configuration file."
      size="lg"
      persistent
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            icon={<Upload size={12} />}
            loading={applying}
            disabled={!content || inspecting}
            onClick={apply}
          >
            Apply configuration
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(event) => void pick(event.target.files?.[0])}
        />

        <div className="flex items-center gap-2 rounded-[var(--radius-control)] border border-dashed border-border-strong px-3 py-3">
          <FileJson size={18} className="shrink-0 text-text-faint" aria-hidden />
          <div className="min-w-0 flex-1">
            {filename ? (
              <>
                <p className="truncate text-[12.5px] font-medium">{filename}</p>
                <p className="text-[11.5px] text-text-muted">
                  {content ? formatBytes(new Blob([content]).size) : '—'}
                </p>
              </>
            ) : (
              <p className="text-[12.5px] text-text-muted">
                Choose a configuration file saved from this or another openDAQ application.
              </p>
            )}
          </div>
          <Button data-autofocus onClick={() => fileRef.current?.click()}>
            {filename ? 'Choose another' : 'Choose file'}
          </Button>
        </div>

        {inspecting ? (
          <div className="flex items-center justify-center gap-2 py-4 text-[12px] text-text-muted">
            <Spinner size={14} /> Inspecting the file…
          </div>
        ) : null}

        {inspection ? (
          <>
            <dl className="rounded-[var(--radius-control)] bg-sunken px-2.5 py-2">
              <InfoRow label="Devices">
                {inspection.summary.deviceCount}
                {inspection.summary.devices.length > 0 ? (
                  <span className="ml-2 text-text-muted">{inspection.summary.devices.join(', ')}</span>
                ) : null}
              </InfoRow>
              <InfoRow label="Function blocks">
                {inspection.summary.functionBlockCount}
                {inspection.summary.functionBlocks.length > 0 ? (
                  <span className="ml-2 text-text-muted">{inspection.summary.functionBlocks.join(', ')}</span>
                ) : null}
              </InfoRow>
              <InfoRow label="Servers">
                {inspection.summary.serverCount}
                {inspection.summary.servers.length > 0 ? (
                  <span className="ml-2 text-text-muted">{inspection.summary.servers.join(', ')}</span>
                ) : null}
              </InfoRow>
            </dl>

            <div className="flex flex-col gap-1.5">
              <span className="text-[11px] font-semibold tracking-wide text-text-muted uppercase">
                Update parameters
              </span>
              <ConfigEditor
                tree={inspection.parameters}
                values={parameters}
                onChange={setParameters}
                emptyMessage="This SDK version exposes no update parameters."
              />
            </div>

            {inspection.deviceOptions.length > 0 ? (
              <div className="flex flex-col gap-1.5">
                <span className="text-[11px] font-semibold tracking-wide text-text-muted uppercase">
                  Per-device handling
                </span>
                <div className="flex flex-col gap-1.5">
                  {inspection.deviceOptions.map((option) => (
                    <DeviceOptionRow
                      key={option.path.join('.')}
                      option={option}
                      modes={inspection.updateModes}
                      overrides={overrides}
                      onChange={setOverrides}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-[11.5px] leading-relaxed text-text-muted">
                {inspection.updateModes.length === 0
                  ? 'This openDAQ SDK cannot remap devices while loading, so the file will be applied exactly as saved.'
                  : 'This file lists no devices to remap, so it will be applied as saved.'}
              </p>
            )}
          </>
        ) : !inspecting && filename && !content ? (
          <EmptyState title="Could not read that file" description="It does not look like openDAQ configuration JSON." />
        ) : null}
      </div>
    </Modal>
  );
}

function DeviceOptionRow({
  option,
  modes,
  overrides,
  onChange,
  depth = 0,
}: {
  option: DeviceUpdateOption;
  modes: DeviceUpdateMode[];
  overrides: DeviceOverrides;
  onChange: (overrides: DeviceOverrides) => void;
  depth?: number;
}) {
  const key = option.path.join('.');
  const current = overrides[key] ?? {};
  const mode = current.updateMode ?? option.updateMode;
  const remapping = mode === 'Remap';

  const patch = (change: Partial<{ updateMode: DeviceUpdateMode; newConnectionString: string }>) => {
    onChange({ ...overrides, [key]: { ...current, ...change } });
  };

  return (
    <>
      <div
        className="flex flex-wrap items-center gap-2 rounded-[var(--radius-control)] border border-border px-2.5 py-2"
        style={{ marginLeft: depth * 16 }}
      >
        <div className="min-w-40 flex-1">
          <p className="truncate text-[12.5px] font-medium">{option.localId || '(unnamed device)'}</p>
          <p className="truncate font-mono text-[10.5px] text-text-faint">
            {option.connectionString || 'no saved connection string'}
          </p>
        </div>

        {option.serialNumber ? <Badge title="Serial number in the file">{option.serialNumber}</Badge> : null}

        <label className="flex items-center gap-1.5 text-[11.5px] text-text-muted">
          Action
          <Select
            size="sm"
            className="w-28"
            value={mode}
            aria-label={`Action for ${option.localId}`}
            onChange={(event) => patch({ updateMode: event.target.value as DeviceUpdateMode })}
          >
            {modes.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </Select>
        </label>

        {remapping ? (
          <Field label="New connection string" className="min-w-56 flex-1">
            <Input
              size="sm"
              mono
              value={current.newConnectionString ?? option.newConnectionString}
              placeholder={option.connectionString}
              onChange={(event) => patch({ newConnectionString: event.target.value })}
            />
          </Field>
        ) : null}
      </div>

      {option.children.map((child) => (
        <DeviceOptionRow
          key={child.path.join('.')}
          option={child}
          modes={modes}
          overrides={overrides}
          onChange={onChange}
          depth={depth + 1}
        />
      ))}
    </>
  );
}

/** Save the running configuration to a file. */
export function SaveConfigurationDialog() {
  const close = useDialogs((state) => state.close);
  const [busy, setBusy] = useState(false);

  return (
    <Modal
      open
      onClose={close}
      title="Save configuration"
      description="Capture the current devices, function blocks, servers and property values."
      size="sm"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            loading={busy}
            data-autofocus
            onClick={async () => {
              setBusy(true);
              const result = await actions.saveConfiguration();
              setBusy(false);
              if (result) close();
            }}
          >
            Download
          </Button>
        </>
      }
    >
      <p className="text-[12.5px] leading-relaxed text-text-muted">
        The file is generated by the openDAQ SDK and can be loaded again here, or by any other openDAQ
        application. Nothing on the instance changes.
      </p>
    </Modal>
  );
}
