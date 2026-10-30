import { useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { actions } from '../../lib/actions';
import { api } from '../../lib/api';
import { useAsyncData } from '../../lib/useAsyncData';
import { cn } from '../../lib/utils';
import { shortenGlobalId } from '../../lib/format';
import type { ComponentTypeInfo, ComponentTypeKind } from '../../lib/types';
import { useDialogs } from '../../store/useDialogs';
import { useSession } from '../../store/useSession';
import { Button } from '../ui/Button';
import { Field, Input } from '../ui/Field';
import { Badge, EmptyState, Spinner } from '../ui/Feedback';
import { Modal } from '../ui/Modal';
import { ConfigEditor, ConfigSummary, type ConfigValues } from './ConfigEditor';

/**
 * A shared "pick a type, tweak its config, create it" dialog.
 *
 * Function blocks and servers differ only in which type list they read and what
 * happens on submit, so one component covers both. The default configuration is
 * fetched for the selected type, which is what lets the dialog offer real options
 * instead of a bare name field.
 */
function AddTypedComponentDialog({
  kind,
  title,
  description,
  hostId,
  loadTypes,
  onCreate,
  hostLabel,
}: {
  kind: ComponentTypeKind;
  title: string;
  description: string;
  hostId: string | null;
  loadTypes: (signal: AbortSignal) => Promise<{ types: ComponentTypeInfo[]; hostId?: string }>;
  onCreate: (typeId: string, values: ConfigValues) => Promise<{ componentId: string } | null>;
  hostLabel?: string;
}) {
  const close = useDialogs((state) => state.close);
  const reportError = useSession((state) => state.reportError);

  // `null` means "nothing picked yet", which resolves to the first type once the
  // list arrives - derived rather than assigned in an effect, so there is no
  // frame where the list is loaded but no row looks selected.
  const [pickedTypeId, setPickedTypeId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [values, setValues] = useState<ConfigValues>({});
  const [creating, setCreating] = useState(false);

  const { data: types } = useAsyncData(
    (signal) =>
      loadTypes(signal).then((response) =>
        [...response.types].sort((a, b) => a.name.localeCompare(b.name)),
      ),
    [hostId],
    { onError: (error) => reportError(error, `Could not list ${kind} types`) },
  );

  const typeId = pickedTypeId ?? types?.[0]?.id ?? '';

  const { data: config, loading: configLoading } = useAsyncData(
    (signal) =>
      api.topology.typeConfig(kind, typeId, hostId ?? undefined, signal).then((r) => r.config),
    [kind, typeId, hostId],
    { enabled: typeId.length > 0 },
  );

  /** Choosing a different type invalidates whatever was configured for the old one. */
  const chooseType = (next: string) => {
    if (next === typeId) return;
    setPickedTypeId(next);
    setValues({});
  };

  const filtered = useMemo(() => {
    if (!types) return [];
    const needle = query.trim().toLowerCase();
    if (!needle) return types;
    return types.filter(
      (type) =>
        type.name.toLowerCase().includes(needle) ||
        type.id.toLowerCase().includes(needle) ||
        type.description.toLowerCase().includes(needle),
    );
  }, [query, types]);

  const selected = types?.find((type) => type.id === typeId) ?? null;

  const create = async () => {
    if (!typeId) return;
    setCreating(true);
    const result = await onCreate(typeId, values);
    setCreating(false);
    if (result) {
      void useSession.getState().select(result.componentId);
      close();
    }
  };

  return (
    <Modal
      open
      onClose={close}
      title={title}
      description={hostLabel ? `${description} · into ${hostLabel}` : description}
      size="lg"
      persistent
      footer={
        <>
          <ConfigSummary values={values} onClear={() => setValues({})} />
          <span className="flex-1" />
          <Button onClick={close}>Cancel</Button>
          <Button
            variant="primary"
            icon={<Plus size={12} />}
            loading={creating}
            disabled={!typeId}
            onClick={create}
          >
            Add
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search
            size={12}
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-text-faint"
          />
          <Input
            data-autofocus
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search types…"
            aria-label="Search types"
            className="pl-6.5"
          />
        </div>

        {!types ? (
          <div className="flex items-center justify-center gap-2 py-6 text-[12px] text-text-muted">
            <Spinner size={14} /> Loading types…
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No matching types"
            description="The available types come from the modules loaded by the backend — check the Modules page."
          />
        ) : (
          <div className="max-h-60 overflow-y-auto rounded-[var(--radius-control)] border border-border">
            <ul>
              {filtered.map((type) => (
                <li key={type.id}>
                  <button
                    type="button"
                    aria-pressed={type.id === typeId}
                    onClick={() => chooseType(type.id)}
                    onDoubleClick={() => {
                      chooseType(type.id);
                      void create();
                    }}
                    className={cn(
                      'flex w-full flex-col gap-0.5 px-2.5 py-1.5 text-left',
                      'row-hover',
                      type.id === typeId && 'row-selected',
                    )}
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 truncate text-[12.5px] font-medium">{type.name}</span>
                      {type.connectionStringPrefix ? (
                        <Badge>{type.connectionStringPrefix}://</Badge>
                      ) : null}
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-text-faint">{type.id}</span>
                    </span>
                    {type.description ? (
                      <span className="text-[11.5px] leading-snug text-text-muted">{type.description}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {selected ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-semibold tracking-wide text-text-muted uppercase">
              Configuration
            </span>
            {configLoading ? (
              <div className="flex items-center gap-2 py-3 text-[12px] text-text-muted">
                <Spinner size={13} /> Reading the default configuration…
              </div>
            ) : (
              <div className="max-h-60 overflow-y-auto">
                <ConfigEditor
                  tree={config}
                  values={values}
                  onChange={setValues}
                  emptyMessage={`${selected.name} is created without configuration options.`}
                />
              </div>
            )}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

export function AddFunctionBlockDialog({ parentId }: { parentId: string | null }) {
  const tree = useSession((state) => state.tree);
  const hostLabel = parentId ? shortenGlobalId(parentId) || parentId : (tree?.name ?? 'this instance');

  return (
    <AddTypedComponentDialog
      kind="functionBlock"
      title="Add function block"
      description="Processing blocks read signals through input ports and publish their results as new signals."
      hostId={parentId}
      hostLabel={hostLabel}
      loadTypes={(signal) => api.topology.functionBlockTypes(parentId ?? undefined, signal)}
      onCreate={(typeId, values) =>
        actions.addFunctionBlock(typeId, parentId, Object.keys(values).length ? values : undefined)
      }
    />
  );
}

export function AddServerDialog() {
  return (
    <AddTypedComponentDialog
      kind="server"
      title="Add server"
      description="A server publishes this instance so other openDAQ clients can connect to it."
      hostId={null}
      loadTypes={(signal) => api.topology.serverTypes(signal)}
      onCreate={(typeId, values) => actions.addServer(typeId, Object.keys(values).length ? values : undefined)}
    />
  );
}

/** Load an extra openDAQ module from disk at runtime. */
export function LoadModuleDialog() {
  const close = useDialogs((state) => state.close);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);

  const extension = useMemo(() => {
    const platform = navigator.platform || navigator.userAgent;
    if (/win/i.test(platform)) return '.module.dll';
    if (/mac/i.test(platform)) return '.dylib';
    return '.module.so';
  }, []);

  const submit = async () => {
    if (!path.trim()) return;
    setBusy(true);
    const result = await actions.loadModule(path.trim());
    setBusy(false);
    if (result) close();
  };

  return (
    <Modal
      open
      onClose={close}
      title="Load module"
      description="Modules add device, function block, server and streaming types."
      size="md"
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!path.trim()} onClick={submit}>
            Load
          </Button>
        </>
      }
    >
      <Field
        label="Module path"
        hint={`a path on the machine running the backend, e.g. …${extension}`}
      >
        <Input
          data-autofocus
          mono
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder={`/opt/opendaq/modules/my_device${extension}`}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit();
          }}
        />
      </Field>
      <p className="mt-2 text-[11.5px] leading-relaxed text-text-muted">
        The path is resolved on the backend host, not in your browser, so a file picker would point at the wrong
        machine. For modules that should always be present, pass{' '}
        <code className="rounded bg-sunken px-1 font-mono">--module-path</code> when starting the backend
        instead.
      </p>
    </Modal>
  );
}
