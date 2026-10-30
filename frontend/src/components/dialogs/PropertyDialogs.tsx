import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Copy, Play, Plus, Trash2 } from 'lucide-react';
import { actions } from '../../lib/actions';
import { api } from '../../lib/api';
import { formatDaqValue } from '../../lib/format';
import { copyToClipboard } from '../../lib/utils';
import type { CoreTypeName, DaqValue, ExecuteResult, PropertyNode } from '../../lib/types';
import { useDialogs } from '../../store/useDialogs';
import { useSession } from '../../store/useSession';
import { Button, IconButton } from '../ui/Button';
import { Field, Input, Textarea } from '../ui/Field';
import { Badge, EmptyState, InfoRow, Spinner } from '../ui/Feedback';
import { Modal } from '../ui/Modal';

/** Everything the SDK knows about one property. */
export function PropertyMetadataDialog({
  componentId,
  path,
}: {
  componentId: string;
  path: string[];
}) {
  const close = useDialogs((state) => state.close);
  const reportError = useSession((state) => state.reportError);
  const [node, setNode] = useState<PropertyNode | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.properties
      .metadata(componentId, path)
      .then((response) => {
        if (!cancelled) setNode(response);
      })
      .catch((error: unknown) => {
        if (!cancelled) reportError(error, 'Could not read the property metadata');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [componentId, path.join('.')]);

  return (
    <Modal
      open
      onClose={close}
      title={`${path.join('.')} — metadata`}
      description={componentId}
      size="md"
      footer={
        <>
          <Button
            icon={<Copy size={12} />}
            disabled={!node}
            onClick={() => node && void copyToClipboard(JSON.stringify(node, null, 2))}
          >
            Copy JSON
          </Button>
          <Button onClick={close}>Close</Button>
        </>
      }
    >
      {loading && !node ? (
        <div className="flex items-center justify-center gap-2 py-6 text-[12px] text-text-muted">
          <Spinner size={14} /> Loading…
        </div>
      ) : !node ? (
        <EmptyState title="Not available" />
      ) : (
        <dl>
          <InfoRow label="Name">{node.name}</InfoRow>
          <InfoRow label="Path" mono>
            {node.path.join('.')}
          </InfoRow>
          {node.description ? <InfoRow label="Description">{node.description}</InfoRow> : null}
          <InfoRow label="Value" mono>
            {node.displayValue ?? formatDaqValue(node.value, node.unit)}
          </InfoRow>
          <InfoRow label="Default" mono>
            {formatDaqValue(node.defaultValue)}
          </InfoRow>
          <InfoRow label="Value type" mono>
            {node.valueType}
          </InfoRow>
          {node.itemType !== 'undefined' ? (
            <InfoRow label="Item type" mono>
              {node.itemType}
            </InfoRow>
          ) : null}
          {node.keyType !== 'undefined' ? (
            <InfoRow label="Key type" mono>
              {node.keyType}
            </InfoRow>
          ) : null}
          {node.unit ? (
            <InfoRow label="Unit">
              {node.unit.symbol} · {node.unit.quantity || 'unspecified quantity'}
            </InfoRow>
          ) : null}
          {node.minValue !== null || node.maxValue !== null ? (
            <InfoRow label="Range" mono>
              {node.minValue ?? '−∞'} … {node.maxValue ?? '∞'}
            </InfoRow>
          ) : null}
          {node.selectionValues ? (
            <InfoRow label="Selection">
              {node.selectionValues.map((option) => option.label).join(', ')}
            </InfoRow>
          ) : null}
          {Array.isArray(node.suggestedValues) && node.suggestedValues.length > 0 ? (
            <InfoRow label="Suggested">
              {node.suggestedValues.map((value) => formatDaqValue(value)).join(', ')}
            </InfoRow>
          ) : null}
          <InfoRow label="Flags">
            <span className="flex flex-wrap gap-1">
              {node.readOnly ? <Badge tone="warn">read-only</Badge> : <Badge tone="ok">writable</Badge>}
              {node.visible ? null : <Badge>hidden</Badge>}
              {node.isReferenced ? <Badge tone="info">referenced</Badge> : null}
              {node.hasCoercer ? <Badge title="Values are coerced by the device">coercer</Badge> : null}
              {node.hasValidator ? <Badge title="Values are validated by the device">validator</Badge> : null}
            </span>
          </InfoRow>
          {node.structTypeName ? <InfoRow label="Struct type">{node.structTypeName}</InfoRow> : null}
          {node.callable ? (
            <InfoRow label="Signature" mono>
              ({node.callable.arguments.map((argument) => `${argument.name}: ${argument.type}`).join(', ')}) →{' '}
              {node.callable.returnType}
            </InfoRow>
          ) : null}
          {node.error ? (
            <InfoRow label="Read error">
              <span className="text-err">{node.error}</span>
            </InfoRow>
          ) : null}
        </dl>
      )}
    </Modal>
  );
}

/**
 * Call a function or procedure property.
 *
 * Arguments are typed from the SDK's callable info, so a text field is only used
 * where the argument really is a string, and the result of the last call stays on
 * screen — device procedures are often run repeatedly while watching what changes.
 */
export function ExecutePropertyDialog({
  componentId,
  path,
}: {
  componentId: string;
  path: string[];
}) {
  const close = useDialogs((state) => state.close);
  const reportError = useSession((state) => state.reportError);
  const [node, setNode] = useState<PropertyNode | null>(null);
  const [args, setArgs] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ExecuteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.properties
      .read(componentId, path)
      .then((response) => {
        if (!cancelled) setNode(response);
      })
      .catch((cause: unknown) => {
        if (!cancelled) reportError(cause, 'Could not read the property');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [componentId, path.join('.')]);

  const parameters = node?.callable?.arguments ?? [];

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const converted = parameters.map((parameter) => coerceArgument(args[parameter.name] ?? '', parameter.type));
      const response = await api.properties.execute(componentId, path, converted);
      setResult(response);
      void useSession.getState().refreshDetail({ silent: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      open
      onClose={close}
      title={`${path.join('.')} — ${node?.valueType === 'proc' ? 'procedure' : 'function'}`}
      description={node?.description || componentId}
      size="md"
      footer={
        <>
          <Button onClick={close}>Close</Button>
          <Button variant="primary" icon={<Play size={12} />} loading={running} onClick={run} data-autofocus>
            {node?.valueType === 'proc' ? 'Run' : 'Call'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {parameters.length === 0 ? (
          <p className="text-[12.5px] text-text-muted">This takes no arguments.</p>
        ) : (
          parameters.map((parameter) => (
            <Field key={parameter.name} label={parameter.name} hint={parameter.type}>
              <Input
                mono
                value={args[parameter.name] ?? ''}
                placeholder={placeholderFor(parameter.type)}
                onChange={(event) => setArgs((current) => ({ ...current, [parameter.name]: event.target.value }))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void run();
                }}
              />
            </Field>
          ))
        )}

        {error ? (
          <div className="rounded-[var(--radius-control)] bg-err-soft px-2.5 py-2 text-[12px] text-err">
            {error}
          </div>
        ) : null}

        {result ? (
          <div className="rounded-[var(--radius-control)] border border-border">
            <div className="section-bar rounded-t-[var(--radius-control)]">Result</div>
            <div className="flex items-start gap-2 px-2.5 py-2">
              <pre className="num min-w-0 flex-1 break-words whitespace-pre-wrap">
                {result.returned ? (formatDaqValue(result.result) || '(empty)') : 'completed'}
              </pre>
              {result.returned ? (
                <IconButton
                  label="Copy result"
                  size="sm"
                  onClick={() => void copyToClipboard(String(formatDaqValue(result.result)))}
                >
                  <Copy size={12} />
                </IconButton>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function placeholderFor(type: CoreTypeName): string {
  switch (type) {
    case 'int':
      return '42';
    case 'float':
      return '1.5';
    case 'bool':
      return 'true';
    case 'list':
      return '[1, 2, 3]';
    default:
      return '';
  }
}

function coerceArgument(text: string, type: CoreTypeName): DaqValue {
  const trimmed = text.trim();
  switch (type) {
    case 'int': {
      const value = Number.parseInt(trimmed, 10);
      if (!Number.isFinite(value)) throw new Error(`"${text}" is not an integer`);
      return value;
    }
    case 'float': {
      const value = Number(trimmed);
      if (!Number.isFinite(value)) throw new Error(`"${text}" is not a number`);
      return value;
    }
    case 'bool':
      return /^(1|true|yes|on)$/i.test(trimmed);
    case 'list':
    case 'dict':
      try {
        return JSON.parse(trimmed) as DaqValue;
      } catch {
        throw new Error(`"${text}" is not valid JSON`);
      }
    default:
      return text;
  }
}

/**
 * Editor for a list or dict property.
 *
 * The whole collection is submitted at once rather than item by item, so the write
 * is atomic: a device never sees a half-applied list.
 */
export function ContainerEditorDialog({
  componentId,
  path,
}: {
  componentId: string;
  path: string[];
}) {
  const close = useDialogs((state) => state.close);
  const reportError = useSession((state) => state.reportError);
  const [node, setNode] = useState<PropertyNode | null>(null);
  const [items, setItems] = useState<string[]>([]);
  const [entries, setEntries] = useState<{ key: string; value: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.properties
      .read(componentId, path)
      .then((response) => {
        if (cancelled) return;
        setNode(response);
        if (Array.isArray(response.value)) {
          setItems(response.value.map((item) => stringify(item)));
        } else if (response.value && typeof response.value === 'object') {
          setEntries(
            Object.entries(response.value as Record<string, DaqValue>).map(([key, value]) => ({
              key,
              value: stringify(value),
            })),
          );
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) reportError(cause, 'Could not read the property');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [componentId, path.join('.')]);

  const isList = node?.valueType === 'list';
  const itemType = node?.itemType ?? 'string';

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload: DaqValue = isList
        ? items.map((item) => parseByType(item, itemType))
        : Object.fromEntries(
            entries.map((entry) => [entry.key, parseByType(entry.value, itemType)] as const),
          );
      const result = await actions.setContainer(componentId, path, payload);
      if (result) close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={close}
      title={`${path.join('.')} — ${isList ? 'list' : 'dictionary'}`}
      description={
        node
          ? `Item type: ${node.itemType}${node.keyType !== 'undefined' ? `, key type: ${node.keyType}` : ''}`
          : componentId
      }
      size="md"
      persistent
      footer={
        <>
          <Button onClick={close}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={node?.readOnly} onClick={save}>
            Apply
          </Button>
        </>
      }
    >
      {!node ? (
        <div className="flex items-center justify-center gap-2 py-6 text-[12px] text-text-muted">
          <Spinner size={14} /> Loading…
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {node.readOnly ? (
            <p className="rounded-[var(--radius-control)] bg-warn-soft px-2.5 py-1.5 text-[12px] text-warn">
              This property is read-only.
            </p>
          ) : null}

          {isList ? (
            <ul className="flex flex-col gap-1">
              {items.map((item, index) => (
                <li key={index} className="flex items-center gap-1">
                  <span className="num w-6 shrink-0 text-right text-text-faint">{index}</span>
                  <Input
                    mono
                    size="sm"
                    value={item}
                    disabled={node.readOnly}
                    aria-label={`Item ${index}`}
                    onChange={(event) =>
                      setItems((current) => current.map((value, i) => (i === index ? event.target.value : value)))
                    }
                  />
                  <IconButton
                    label="Move up"
                    size="sm"
                    disabled={index === 0 || node.readOnly}
                    onClick={() => setItems((current) => swap(current, index, index - 1))}
                  >
                    <ArrowUp size={11} />
                  </IconButton>
                  <IconButton
                    label="Move down"
                    size="sm"
                    disabled={index === items.length - 1 || node.readOnly}
                    onClick={() => setItems((current) => swap(current, index, index + 1))}
                  >
                    <ArrowDown size={11} />
                  </IconButton>
                  <IconButton
                    label="Remove"
                    size="sm"
                    disabled={node.readOnly}
                    onClick={() => setItems((current) => current.filter((_, i) => i !== index))}
                  >
                    <Trash2 size={11} />
                  </IconButton>
                </li>
              ))}
              {items.length === 0 ? <p className="text-[12px] text-text-muted">The list is empty.</p> : null}
              <li>
                <Button
                  size="sm"
                  icon={<Plus size={11} />}
                  disabled={node.readOnly}
                  onClick={() => setItems((current) => [...current, ''])}
                >
                  Add item
                </Button>
              </li>
            </ul>
          ) : (
            <ul className="flex flex-col gap-1">
              {entries.map((entry, index) => (
                <li key={index} className="flex items-center gap-1">
                  <Input
                    mono
                    size="sm"
                    value={entry.key}
                    disabled={node.readOnly}
                    aria-label={`Key ${index}`}
                    className="w-40"
                    onChange={(event) =>
                      setEntries((current) =>
                        current.map((item, i) => (i === index ? { ...item, key: event.target.value } : item)),
                      )
                    }
                  />
                  <Input
                    mono
                    size="sm"
                    value={entry.value}
                    disabled={node.readOnly}
                    aria-label={`Value ${index}`}
                    onChange={(event) =>
                      setEntries((current) =>
                        current.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)),
                      )
                    }
                  />
                  <IconButton
                    label="Remove"
                    size="sm"
                    disabled={node.readOnly}
                    onClick={() => setEntries((current) => current.filter((_, i) => i !== index))}
                  >
                    <Trash2 size={11} />
                  </IconButton>
                </li>
              ))}
              {entries.length === 0 ? (
                <p className="text-[12px] text-text-muted">The dictionary is empty.</p>
              ) : null}
              <li>
                <Button
                  size="sm"
                  icon={<Plus size={11} />}
                  disabled={node.readOnly}
                  onClick={() => setEntries((current) => [...current, { key: '', value: '' }])}
                >
                  Add entry
                </Button>
              </li>
            </ul>
          )}

          {error ? (
            <p className="rounded-[var(--radius-control)] bg-err-soft px-2.5 py-1.5 text-[12px] text-err">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

function swap<T>(list: T[], a: number, b: number): T[] {
  const next = [...list];
  const first = next[a] as T;
  next[a] = next[b] as T;
  next[b] = first;
  return next;
}

function stringify(value: DaqValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function parseByType(text: string, type: CoreTypeName): DaqValue {
  const trimmed = text.trim();
  switch (type) {
    case 'int': {
      const value = Number.parseInt(trimmed, 10);
      if (!Number.isFinite(value)) throw new Error(`"${text}" is not an integer`);
      return value;
    }
    case 'float': {
      const value = Number(trimmed);
      if (!Number.isFinite(value)) throw new Error(`"${text}" is not a number`);
      return value;
    }
    case 'bool':
      return /^(1|true|yes|on)$/i.test(trimmed);
    default:
      return text;
  }
}

/** A read-only text view, for struct and string values too long for a cell. */
export function ViewValueDialog({ title, text }: { title: string; text: string }) {
  const close = useDialogs((state) => state.close);
  const notify = useSession((state) => state.notify);
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      return text;
    }
  }, [text]);

  return (
    <Modal
      open
      onClose={close}
      title={title}
      size="md"
      footer={
        <>
          <Button
            icon={<Copy size={12} />}
            onClick={() =>
              void copyToClipboard(pretty).then((ok) => ok && notify('info', 'Copied to the clipboard'))
            }
          >
            Copy
          </Button>
          <Button onClick={close}>Close</Button>
        </>
      }
    >
      <Textarea mono readOnly value={pretty} rows={16} aria-label={title} />
    </Modal>
  );
}
