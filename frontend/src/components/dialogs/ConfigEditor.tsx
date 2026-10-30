import { useCallback, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, RotateCcw } from 'lucide-react';
import { formatDaqValue, formatNumber, isEnumerationValue, isStructValue } from '../../lib/format';
import { cn } from '../../lib/utils';
import type { DaqValue, PropertyNode, PropertyTree } from '../../lib/types';
import { Button, IconButton } from '../ui/Button';
import { Badge, EmptyState } from '../ui/Feedback';
import { CommitInput, Select, Switch } from '../ui/Field';

/**
 * Editor for an openDAQ configuration object, before anything is created.
 *
 * The backend hands over the SDK's default configuration tree and expects a flat
 * `{"General.Username": "..."}` override map back, which it applies to a *fresh*
 * default object.  That keeps the exchange stateless: no half-edited config object
 * is held on the server between requests, and a stale browser tab cannot submit
 * against something that no longer exists.
 *
 * Only edited fields are sent, so a value the SDK changes in a later release is
 * picked up rather than pinned by whatever this dialog happened to read.
 */
export interface ConfigValues {
  [dottedPath: string]: DaqValue;
}

export function ConfigEditor({
  tree,
  values,
  onChange,
  hiddenPaths = [],
  emptyMessage = 'This type has no configuration options.',
}: {
  tree: PropertyTree | null;
  values: ConfigValues;
  onChange: (values: ConfigValues) => void;
  /** Dotted paths driven by dedicated widgets elsewhere in the dialog. */
  hiddenPaths?: string[];
  emptyMessage?: string;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const hidden = useMemo(() => new Set(hiddenPaths), [hiddenPaths]);

  const setValue = useCallback(
    (path: string, value: DaqValue) => {
      onChange({ ...values, [path]: value });
    },
    [onChange, values],
  );

  const resetValue = useCallback(
    (path: string) => {
      const next = { ...values };
      delete next[path];
      onChange(next);
    },
    [onChange, values],
  );

  const rows = useMemo(() => {
    if (!tree) return [];
    const output: { node: PropertyNode; depth: number; path: string; hasChildren: boolean }[] = [];
    const walk = (nodes: PropertyNode[], depth: number, prefix: string) => {
      for (const node of nodes) {
        const path = prefix ? `${prefix}.${node.name}` : node.name;
        if (hidden.has(path)) continue;
        const hasChildren = (node.children?.length ?? 0) > 0;
        output.push({ node, depth, path, hasChildren });
        if (hasChildren && !collapsed.has(path)) {
          walk(node.children ?? [], depth + 1, path);
        }
      }
    };
    walk(tree.properties, 0, '');
    return output;
  }, [collapsed, hidden, tree]);

  if (!tree || tree.properties.length === 0) {
    return <EmptyState title="Nothing to configure" description={emptyMessage} />;
  }

  return (
    <div className="overflow-hidden rounded-[var(--radius-control)] border border-border">
      <table className="w-full border-collapse text-[12px]">
        <tbody>
          {rows.map(({ node, depth, path, hasChildren }) => {
            const edited = Object.prototype.hasOwnProperty.call(values, path);
            const effective = edited ? (values[path] ?? null) : node.value;
            return (
              <tr key={path} className={cn('border-b border-border/60 last:border-b-0', 'row-hover')}>
                <th
                  scope="row"
                  className="max-w-0 px-2 py-1 text-left font-normal"
                  style={{ paddingLeft: 8 + depth * 12 }}
                >
                  <div className="flex items-center gap-1">
                    {hasChildren ? (
                      <button
                        type="button"
                        aria-label={collapsed.has(path) ? 'Expand' : 'Collapse'}
                        onClick={() =>
                          setCollapsed((current) => {
                            const next = new Set(current);
                            if (next.has(path)) next.delete(path);
                            else next.add(path);
                            return next;
                          })
                        }
                        className="flex size-4 shrink-0 items-center justify-center text-text-faint hover:text-text"
                      >
                        {collapsed.has(path) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                      </button>
                    ) : (
                      <span className="size-4 shrink-0" />
                    )}
                    <span className={cn('truncate', hasChildren && 'font-medium')} title={node.description || path}>
                      {node.name}
                    </span>
                    {edited ? <Badge tone="brand">edited</Badge> : null}
                  </div>
                </th>

                <td className="w-[45%] px-2 py-1">
                  {hasChildren ? null : (
                    <ConfigField
                      node={node}
                      value={effective}
                      onChange={(next) => setValue(path, next)}
                    />
                  )}
                </td>

                <td className="w-8 px-1 py-1">
                  {edited ? (
                    <IconButton label="Revert to the default" size="sm" onClick={() => resetValue(path)}>
                      <RotateCcw size={11} />
                    </IconButton>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ConfigField({
  node,
  value,
  onChange,
}: {
  node: PropertyNode;
  value: DaqValue;
  onChange: (value: DaqValue) => void;
}) {
  if (node.readOnly) {
    return <span className="num text-text-muted">{formatDaqValue(value, node.unit)}</span>;
  }

  if (node.selectionValues && node.selectionValues.length > 0) {
    return (
      <Select
        size="sm"
        aria-label={node.name}
        value={JSON.stringify(node.selectionKey ?? value)}
        onChange={(event) => {
          const option = node.selectionValues?.find((entry) => JSON.stringify(entry.key) === event.target.value);
          if (option) onChange(option.key);
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

  if (node.valueType === 'bool') {
    return (
      <div className="flex items-center gap-2">
        <Switch checked={Boolean(value)} label={node.name} onChange={onChange} />
        <span className="text-[11.5px] text-text-muted">{value ? 'Yes' : 'No'}</span>
      </div>
    );
  }

  if (node.valueType === 'enumeration' && isEnumerationValue(value)) {
    return (
      <Select
        size="sm"
        aria-label={node.name}
        value={value.name}
        onChange={(event) =>
          onChange({ ...value, name: event.target.value, value: null })
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

  if (node.valueType === 'list') {
    // Lists in a connection config are short (protocol names), so a comma
    // separated field is friendlier than a full collection editor here.
    const items = Array.isArray(value) ? value : [];
    return (
      <CommitInput
        value={items.map((item) => String(item)).join(', ')}
        ariaLabel={node.name}
        mono={false}
        align="left"
        onCommit={(next) =>
          onChange(
            next
              .split(',')
              .map((part) => part.trim())
              .filter(Boolean),
          )
        }
      />
    );
  }

  if (node.valueType === 'struct' && isStructValue(value)) {
    return <span className="text-[11.5px] text-text-faint">{value.typeName ?? 'struct'}</span>;
  }

  if (node.valueType === 'dict' || node.valueType === 'object') {
    return <span className="text-[11.5px] text-text-faint">not editable here</span>;
  }

  const numeric = node.valueType === 'int' || node.valueType === 'float';
  const isPassword = /password|secret|token/i.test(node.name);

  return (
    <div className="flex items-center gap-1.5">
      <CommitInput
        value={numeric && typeof value === 'number' ? formatNumber(value, 10) : String(value ?? '')}
        ariaLabel={node.name}
        mono={numeric}
        align={numeric ? 'right' : 'left'}
        placeholder={isPassword ? '••••••' : undefined}
        onCommit={(next) => {
          if (numeric) {
            const parsed = Number(next);
            onChange(Number.isFinite(parsed) ? parsed : next);
          } else {
            onChange(next);
          }
        }}
      />
      {node.unit?.symbol ? (
        <span className="shrink-0 text-[11px] text-text-muted">{node.unit.symbol}</span>
      ) : null}
    </div>
  );
}

/** A footer summary of what will be sent, so nothing is applied invisibly. */
export function ConfigSummary({
  values,
  onClear,
}: {
  values: ConfigValues;
  onClear: () => void;
}) {
  const keys = Object.keys(values);
  if (keys.length === 0) {
    return <span className="text-[11.5px] text-text-faint">Using the SDK defaults</span>;
  }
  return (
    <span className="flex items-center gap-2 text-[11.5px] text-text-muted">
      {keys.length} setting{keys.length === 1 ? '' : 's'} changed
      <Button size="sm" variant="ghost" onClick={onClear}>
        Reset all
      </Button>
    </span>
  );
}
