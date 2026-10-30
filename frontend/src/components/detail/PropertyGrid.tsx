import { useCallback, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Columns3, Copy, Info, Play, RotateCcw, Search } from 'lucide-react';
import { actions } from '../../lib/actions';
import { api } from '../../lib/api';
import { formatDaqValue, formatNumber, isStructValue } from '../../lib/format';
import { cn, copyToClipboard } from '../../lib/utils';
import type { DaqValue, PropertyNode, PropertyTree } from '../../lib/types';
import { useDialogs } from '../../store/useDialogs';
import { useSession } from '../../store/useSession';
import { useSettings } from '../../store/useSettings';
import { IconButton } from '../ui/Button';
import { Badge, EmptyState } from '../ui/Feedback';
import { CommitInput, Input, Select, Switch } from '../ui/Field';
import { ContextMenu, useContextMenu, type MenuItem } from '../ui/Menu';
import { openPictureWindow } from '../signals/PictureWindow';

const INDENT = 12;

/**
 * The property editor.
 *
 * Every openDAQ property kind gets the control that fits it, because a text box
 * for everything is what makes a configuration UI painful to use:
 *
 * | Property kind             | Control                                   |
 * |---------------------------|-------------------------------------------|
 * | bool                      | switch                                    |
 * | selection (list or dict)  | dropdown of the selection labels          |
 * | enumeration               | dropdown of the enumerators                |
 * | suggested values          | editable dropdown                         |
 * | int / float               | numeric field, min/max shown as a hint    |
 * | string                    | text field (`eval:` prefix still works)   |
 * | struct                    | expandable subtree, one field per row     |
 * | list / dict               | row opens the collection editor           |
 * | object                    | expandable subtree of nested properties   |
 * | function / procedure      | Execute button                            |
 */
export function PropertyGrid({
  componentId,
  tree,
  readOnly,
  emptyHint,
}: {
  componentId: string;
  tree: PropertyTree;
  /** The instance is read-only, or the owning device is locked. */
  readOnly: boolean;
  emptyHint?: string;
}) {
  const metadataColumns = useSettings((state) => state.metadataColumns);
  const metadataFields = useSession((state) => state.metadataFields);
  const openDialog = useDialogs((state) => state.open);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');

  const columns = useMemo(
    () => metadataFields.filter((field) => metadataColumns.includes(field.key)),
    [metadataColumns, metadataFields],
  );

  const toggle = useCallback((key: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const output: { node: PropertyNode; depth: number; key: string; hasChildren: boolean }[] = [];

    const matches = (node: PropertyNode): boolean => {
      if (!needle) return true;
      if (node.name.toLowerCase().includes(needle)) return true;
      if (node.description.toLowerCase().includes(needle)) return true;
      if ((node.displayValue ?? '').toLowerCase().includes(needle)) return true;
      return (node.children ?? []).some(matches);
    };

    const walk = (nodes: PropertyNode[], depth: number) => {
      for (const node of nodes) {
        if (!matches(node)) continue;
        const key = node.path.join('.');
        const structFields = isStructValue(node.value) ? Object.keys(node.value.fields) : [];
        const hasChildren = (node.children?.length ?? 0) > 0 || structFields.length > 0;
        output.push({ node, depth, key, hasChildren });

        // A filter implies "show me what matched", so subtrees stay open.
        const isCollapsed = needle ? false : collapsed.has(key);
        if (hasChildren && !isCollapsed) {
          if (node.children?.length) walk(node.children, depth + 1);
          else if (isStructValue(node.value)) {
            for (const field of structFields) {
              output.push({
                node: {
                  ...node,
                  // Synthetic row: a struct field is addressed by parent + field.
                  name: field,
                  path: [...node.path, field],
                  valueType: 'undefined',
                  value: (node.value as { fields: Record<string, DaqValue> }).fields[field] ?? null,
                  displayValue: formatDaqValue(
                    (node.value as { fields: Record<string, DaqValue> }).fields[field] ?? null,
                  ),
                  children: null,
                  structTypeName: null,
                },
                depth: depth + 1,
                key: `${key}.${field}`,
                hasChildren: false,
              });
            }
          }
        }
      }
    };

    walk(tree.properties, 0);
    return output;
  }, [collapsed, filter, tree.properties]);

  if (tree.properties.length === 0) {
    return (
      <EmptyState
        title="No properties"
        description={emptyHint ?? 'This component does not expose any configurable properties.'}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <Search
            size={12}
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-text-faint"
          />
          <Input
            size="sm"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter properties…"
            aria-label="Filter properties"
            className="pl-6.5"
          />
        </div>
        {tree.updating ? <Badge tone="warn">update block open</Badge> : null}
        <IconButton
          label="Choose metadata columns"
          size="sm"
          onClick={() => openDialog({ kind: 'metadataColumns' })}
          active={columns.length > 0}
        >
          <Columns3 size={13} />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-[12.5px]">
          <thead className="sticky top-0 z-10">
            <tr className="bg-sunken text-left text-[11px] font-semibold tracking-wide text-text-muted uppercase">
              <th scope="col" className="px-2 py-1 font-semibold">
                Property
              </th>
              <th scope="col" className="w-[38%] px-2 py-1 font-semibold">
                Value
              </th>
              {columns.map((column) => (
                <th key={column.key} scope="col" className="px-2 py-1 font-semibold whitespace-nowrap">
                  {column.label}
                </th>
              ))}
              <th scope="col" className="w-8 px-1 py-1" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <PropertyRow
                key={row.key}
                componentId={componentId}
                node={row.node}
                depth={row.depth}
                hasChildren={row.hasChildren}
                collapsed={collapsed.has(row.key)}
                onToggle={() => toggle(row.key)}
                readOnly={readOnly}
                metadataColumns={columns.map((column) => column.key)}
              />
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? (
          <EmptyState title="No matching properties" description="Try a shorter filter." />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The actions a property offers - copy its value or path, open its metadata,
 * reset it - shared by the table and the card layout so both behave alike.
 */
export function usePropertyMenuItems(componentId: string, node: PropertyNode, locked: boolean): MenuItem[] {
  const openDialog = useDialogs((state) => state.open);
  const notify = useSession((state) => state.notify);

  const isSynthetic = node.valueType === 'undefined' && node.children === null;

  return useMemo<MenuItem[]>(() => {
    const list: MenuItem[] = [
      {
        id: 'copyValue',
        label: 'Copy value',
        icon: <Copy size={13} />,
        onSelect: () => {
          void copyToClipboard(node.displayValue ?? formatDaqValue(node.value)).then((ok) => {
            if (ok) notify('info', 'Value copied');
          });
        },
      },
      {
        id: 'copyName',
        label: 'Copy property path',
        onSelect: () => {
          void copyToClipboard(node.path.join('.'));
        },
      },
    ];
    if (!isSynthetic) {
      list.push({
        id: 'metadata',
        label: 'Metadata…',
        icon: <Info size={13} />,
        separatorBefore: true,
        onSelect: () => openDialog({ kind: 'propertyMetadata', componentId, path: node.path }),
      });
      if (!locked) {
        list.push({
          id: 'reset',
          label: 'Reset to default',
          icon: <RotateCcw size={13} />,
          onSelect: () => void actions.clearProperty(componentId, node.path),
        });
      }
    }
    return list;
  }, [componentId, isSynthetic, locked, node.displayValue, node.path, node.value, notify, openDialog]);
}

function PropertyRow({
  componentId,
  node,
  depth,
  hasChildren,
  collapsed,
  onToggle,
  readOnly,
  metadataColumns,
}: {
  componentId: string;
  node: PropertyNode;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  onToggle: () => void;
  readOnly: boolean;
  metadataColumns: string[];
}) {
  const menu = useContextMenu();

  const locked = readOnly || node.readOnly;
  const isSynthetic = node.valueType === 'undefined' && node.children === null;
  const items = usePropertyMenuItems(componentId, node, locked);

  return (
    <>
      <tr
        onContextMenu={menu.open}
        className={cn('border-b border-border/60 align-middle', 'row-hover', locked && 'text-text-muted')}
      >
        <th
          scope="row"
          className="max-w-0 px-2 py-0.5 text-left font-normal"
          style={{ paddingLeft: 8 + depth * INDENT }}
        >
          <div className="flex items-center gap-1">
            {hasChildren ? (
              <button
                type="button"
                aria-label={collapsed ? 'Expand' : 'Collapse'}
                aria-expanded={!collapsed}
                onClick={onToggle}
                className="flex size-4 shrink-0 items-center justify-center text-text-faint hover:text-text"
              >
                {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              </button>
            ) : (
              <span className="size-4 shrink-0" />
            )}
            <span className="truncate" title={node.description || node.name}>
              {node.name}
            </span>
            {node.isReferenced ? (
              <Badge tone="info" title="Value comes from another property">
                ref
              </Badge>
            ) : null}
            {node.error ? (
              <Badge tone="err" title={node.error}>
                error
              </Badge>
            ) : null}
          </div>
        </th>

        <td className="px-2 py-0.5">
          <PropertyEditor
            componentId={componentId}
            node={node}
            locked={locked}
            componentLocked={readOnly}
            synthetic={isSynthetic}
          />
        </td>

        {metadataColumns.map((key) => (
          <td key={key} className="px-2 py-0.5 text-[11.5px] whitespace-nowrap text-text-muted">
            {renderMetadata(node, key)}
          </td>
        ))}

        <td className="px-1 py-0.5">
          {!isSynthetic ? (
            <IconButton label="Property actions" size="sm" onClick={menu.open}>
              <Info size={12} />
            </IconButton>
          ) : null}
        </td>
      </tr>
      {menu.anchor ? (
        <ContextMenu items={items} anchor={menu.anchor} onClose={menu.close} ariaLabel={`Actions for ${node.name}`} />
      ) : null}
    </>
  );
}

/** Pick and render the control for one property. */
export function PropertyEditor({
  componentId,
  node,
  locked,
  componentLocked,
  synthetic,
}: {
  componentId: string;
  node: PropertyNode;
  /** The value cannot be written: the property or the component is read-only. */
  locked: boolean;
  /** Only the component is: a locked device, or a read-only viewer. */
  componentLocked: boolean;
  synthetic: boolean;
}) {
  const openDialog = useDialogs((state) => state.open);
  const detail = useSession((state) => state.detail);

  // A struct field row: writes go through the struct-field endpoint, which
  // rebuilds the immutable struct with this one field replaced.
  if (synthetic) {
    const parentPath = node.path.slice(0, -1);
    const field = node.path[node.path.length - 1] as string;
    if (locked || typeof node.value === 'object') {
      return <ReadOnlyValue node={node} />;
    }
    return (
      <CommitInput
        value={String(node.value ?? '')}
        ariaLabel={`${field} value`}
        onCommit={(next) => {
          void actions.setStructField(componentId, parentPath, field, coerceText(next, node.value));
        }}
      />
    );
  }

  if (node.valueType === 'func' || node.valueType === 'proc') {
    const argumentCount = node.callable?.arguments.length ?? 0;
    // A block that sends a plot or pictures and offers OpenWindow, as the
    // Universal renderer does: the window opens here, on the click, and the
    // procedure runs on the block as well.
    const windowSignal =
      node.valueType === 'proc' && argumentCount === 0 && node.path.at(-1) === 'OpenWindow' && detail?.node.id === componentId
        ? (detail.signals.find((signal) => signal.image === 'plot') ?? detail.signals.find((signal) => signal.image))
        : undefined;
    return (
      <button
        type="button"
        onClick={() => {
          if (!windowSignal || !detail) {
            openDialog({ kind: 'executeProperty', componentId, path: node.path });
            return;
          }
          openPictureWindow(windowSignal.id, detail.node.displayName || detail.node.name, windowSignal.imageSize);
          api.properties
            .execute(componentId, node.path, [])
            .catch((cause: unknown) => useSession.getState().reportError(cause, 'Could not run OpenWindow'));
        }}
        // Not `locked`. On a function or procedure, the property's own
        // read-only flag means the callable cannot be *replaced*, not that it
        // cannot be *called* - openDAQ declares most of them read-only for
        // exactly that reason (the renderer's OpenWindow, for one). A locked
        // device or a read-only viewer still blocks the call.
        disabled={componentLocked}
        className={cn(
          'inline-flex h-6.5 items-center gap-1.5 rounded-[var(--radius-control)] border border-border-strong',
          'bg-panel px-2 text-[12px] font-medium hover:bg-sunken disabled:cursor-not-allowed disabled:opacity-50',
        )}
      >
        <Play size={11} />
        {node.valueType === 'func' ? 'Call' : 'Run'}
        {argumentCount > 0 ? <span className="text-text-faint">({argumentCount})</span> : null}
      </button>
    );
  }

  if (node.valueType === 'object') {
    return <span className="text-[11.5px] text-text-faint">{node.children?.length ?? 0} properties</span>;
  }

  if (node.valueType === 'list' || node.valueType === 'dict') {
    const count = Array.isArray(node.value)
      ? node.value.length
      : node.value && typeof node.value === 'object'
        ? Object.keys(node.value).length
        : 0;
    return (
      <button
        type="button"
        onClick={() => openDialog({ kind: 'editContainer', componentId, path: node.path })}
        className="inline-flex h-6.5 items-center gap-1.5 rounded-[var(--radius-control)] border border-border-strong bg-panel px-2 text-[12px] hover:bg-sunken"
      >
        <span className="num">{count}</span>
        <span className="text-text-muted">{node.valueType === 'list' ? 'items' : 'entries'}</span>
      </button>
    );
  }

  if (locked) return <ReadOnlyValue node={node} />;

  // Selection properties are written by key, so the option's key is the value.
  if (node.selectionValues && node.selectionValues.length > 0) {
    const current = JSON.stringify(node.selectionKey);
    const single = node.selectionValues.length === 1;
    return (
      <Select
        size="sm"
        value={current}
        disabled={single}
        aria-label={`${node.name} value`}
        onChange={(event) => {
          const option = node.selectionValues?.find((entry) => JSON.stringify(entry.key) === event.target.value);
          if (option) void actions.setProperty(componentId, node.path, option.key);
        }}
      >
        {node.selectionValues.map((option) => (
          <option key={JSON.stringify(option.key)} value={JSON.stringify(option.key)}>
            {option.label}
          </option>
        ))}
      </Select>
    );
  }

  if (node.valueType === 'enumeration' && typeof node.value === 'object' && node.value !== null) {
    const value = node.value as { name: string; enumerators: string[]; typeName: string | null };
    return (
      <Select
        size="sm"
        value={value.name}
        aria-label={`${node.name} value`}
        onChange={(event) =>
          void actions.setProperty(componentId, node.path, {
            kind: 'enumeration',
            typeName: value.typeName,
            name: event.target.value,
            value: null,
            enumerators: value.enumerators,
          })
        }
      >
        {value.enumerators.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </Select>
    );
  }

  if (node.valueType === 'bool') {
    return (
      <div className="flex items-center gap-2">
        <Switch
          checked={Boolean(node.value)}
          label={`${node.name} enabled`}
          onChange={(next) => void actions.setProperty(componentId, node.path, next)}
        />
        <span className="text-[11.5px] text-text-muted">{node.value ? 'Yes' : 'No'}</span>
      </div>
    );
  }

  if (node.valueType === 'struct') {
    return <span className="text-[11.5px] text-text-faint">{node.structTypeName ?? 'struct'}</span>;
  }

  const suggested = Array.isArray(node.suggestedValues) ? node.suggestedValues : null;
  if (suggested && suggested.length > 0) {
    const listId = `suggested-${componentId}-${node.path.join('-')}`;
    return (
      <div className="flex items-center gap-1.5">
        <CommitInput
          value={String(node.value ?? '')}
          ariaLabel={`${node.name} value`}
          onCommit={(next) => void actions.setProperty(componentId, node.path, coerceText(next, node.value))}
          className="min-w-0"
        />
        <datalist id={listId}>
          {suggested.map((option) => (
            <option key={String(option)} value={String(option)} />
          ))}
        </datalist>
        <Select
          size="sm"
          value=""
          aria-label={`${node.name} suggested values`}
          className="w-20"
          onChange={(event) => {
            if (event.target.value === '') return;
            void actions.setProperty(componentId, node.path, coerceText(event.target.value, node.value));
          }}
        >
          <option value="">…</option>
          {suggested.map((option) => (
            <option key={String(option)} value={String(option)}>
              {formatDaqValue(option)}
            </option>
          ))}
        </Select>
      </div>
    );
  }

  const isNumeric = node.valueType === 'int' || node.valueType === 'float';
  return (
    <div className="flex items-center gap-1.5">
      <CommitInput
        value={isNumeric && typeof node.value === 'number' ? formatNumber(node.value, 10) : String(node.value ?? '')}
        ariaLabel={`${node.name} value`}
        align={isNumeric ? 'right' : 'left'}
        mono={isNumeric}
        onCommit={(next) => void actions.setProperty(componentId, node.path, coerceText(next, node.value))}
        className="min-w-0"
      />
      {node.unit?.symbol ? (
        <span className="shrink-0 text-[11.5px] text-text-muted">{node.unit.symbol}</span>
      ) : null}
      {isNumeric && (node.minValue !== null || node.maxValue !== null) ? (
        <span
          className="shrink-0 text-[10.5px] whitespace-nowrap text-text-faint"
          title={`Allowed range: ${node.minValue ?? '−∞'} to ${node.maxValue ?? '∞'}`}
        >
          {node.minValue ?? '−∞'}…{node.maxValue ?? '∞'}
        </span>
      ) : null}
    </div>
  );
}

function ReadOnlyValue({ node }: { node: PropertyNode }) {
  const text = node.displayValue ?? formatDaqValue(node.value, node.unit);
  return (
    <span
      className={cn('num block truncate text-text-muted', node.valueType === 'string' && 'font-sans')}
      title={text}
    >
      {text || '—'}
    </span>
  );
}

/**
 * Keep an edited value in the type it started as.
 *
 * The backend coerces too, but sending a number as a number means a float
 * property never receives the string `"1e3"` and hope for the best.
 */
function coerceText(text: string, previous: DaqValue): DaqValue {
  const trimmed = text.trim();
  if (typeof previous === 'number') {
    const parsed = Number(trimmed.split(' ')[0]);
    return Number.isFinite(parsed) ? parsed : trimmed;
  }
  if (typeof previous === 'boolean') {
    return /^(1|true|yes|on)$/i.test(trimmed);
  }
  return text;
}

function renderMetadata(node: PropertyNode, key: string): string {
  switch (key) {
    case 'description':
      return node.description || '—';
    case 'valueType':
      return node.valueType;
    case 'itemType':
      return node.itemType === 'undefined' ? '—' : node.itemType;
    case 'keyType':
      return node.keyType === 'undefined' ? '—' : node.keyType;
    case 'unit':
      return node.unit?.symbol || '—';
    case 'minValue':
      return node.minValue === null ? '—' : formatNumber(node.minValue);
    case 'maxValue':
      return node.maxValue === null ? '—' : formatNumber(node.maxValue);
    case 'defaultValue':
      return formatDaqValue(node.defaultValue);
    case 'readOnly':
      return node.readOnly ? 'Yes' : 'No';
    case 'visible':
      return node.visible ? 'Yes' : 'No';
    case 'isReferenced':
      return node.isReferenced ? 'Yes' : 'No';
    case 'hasCoercer':
      return node.hasCoercer ? 'Yes' : 'No';
    case 'hasValidator':
      return node.hasValidator ? 'Yes' : 'No';
    case 'structTypeName':
      return node.structTypeName ?? '—';
    default:
      return '—';
  }
}
