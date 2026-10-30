import { useState } from 'react';
import { LayoutGrid, Lock, MoreHorizontal, RotateCcw, Search, Table2, X } from 'lucide-react';
import { actions } from '../../lib/actions';
import { formatDaqValue, formatNumber, isStructValue } from '../../lib/format';
import {
  countChanged,
  describeDefault,
  filterProperties,
  groupProperties,
  humanizeName,
  isChangedFromDefault,
  segmentable,
  SLIDER_STEPS,
  sliderScale,
  type SliderScale,
} from '../../lib/properties';
import type { DaqValue, PropertyNode, PropertyTree } from '../../lib/types';
import { cn } from '../../lib/utils';
import { useSettings } from '../../store/useSettings';
import { ButtonGroup, IconButton, Segment } from '../ui/Button';
import { Badge, EmptyState } from '../ui/Feedback';
import { CommitInput, Input } from '../ui/Field';
import { ContextMenu, useContextMenu } from '../ui/Menu';
import { PropertyEditor, PropertyGrid, usePropertyMenuItems } from './PropertyGrid';

/**
 * A component's configuration, as something to read.
 *
 * The table it replaces is how configuration has always looked in measurement
 * software: every property a row, every row the same, nested objects as
 * indentation, and no way to tell a setting someone chose from one nobody
 * touched. Here each group of settings is a card, each property carries its own
 * label, unit, range and description, and anything changed from its default is
 * marked with a one-click way back - so "what is different about this device"
 * is a filter, not an afternoon.
 *
 * The editors themselves are the table's, so every openDAQ property kind still
 * gets the control it needs. What is added are the controls a table has no room
 * for: buttons for a short choice, a slider for a bounded number. The table is
 * one click away, for metadata columns and for anyone who prefers it.
 */
export function PropertyInspector({
  componentId,
  tree,
  readOnly,
  emptyHint,
}: {
  componentId: string;
  tree: PropertyTree;
  readOnly: boolean;
  emptyHint?: string;
}) {
  const view = useSettings((state) => state.propertyView);
  const setSetting = useSettings((state) => state.set);
  const [query, setQuery] = useState('');
  const [changedOnly, setChangedOnly] = useState(false);

  const changed = countChanged(tree.properties);
  const filtered = filterProperties(tree.properties, query, changedOnly);
  const { general, sections } = groupProperties(filtered);

  const viewToggle = (
    <ButtonGroup>
      <Segment active={view === 'cards'} onClick={() => setSetting('propertyView', 'cards')} title="Grouped cards">
        <LayoutGrid size={12} className="inline" /> Cards
      </Segment>
      <Segment active={view === 'table'} onClick={() => setSetting('propertyView', 'table')} title="The classic table, with metadata columns">
        <Table2 size={12} className="inline" /> Table
      </Segment>
    </ButtonGroup>
  );

  if (tree.properties.length === 0) {
    return (
      <section className="card">
        <EmptyState
          title="No properties"
          description={emptyHint ?? 'This component does not expose any configurable properties.'}
        />
      </section>
    );
  }

  if (view === 'table') {
    return (
      <section className="card flex min-h-[420px] flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <h3 className="text-[13px] font-semibold">Properties</h3>
          <div className="ml-auto">{viewToggle}</div>
        </div>
        <PropertyGrid componentId={componentId} tree={tree} readOnly={readOnly} emptyHint={emptyHint} />
      </section>
    );
  }

  return (
    <section aria-label="Properties" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-1 text-[15px] font-semibold">Properties</h3>
        <div className="relative min-w-40 flex-1">
          <Search size={13} aria-hidden className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-text-faint" />
          <Input
            size="sm"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search properties…"
            aria-label="Search properties"
            className="rounded-full pr-7 pl-8"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery('')}
              className="absolute top-1/2 right-2.5 -translate-y-1/2 text-text-faint hover:text-text"
            >
              <X size={12} />
            </button>
          ) : null}
        </div>
        <button
          type="button"
          aria-pressed={changedOnly}
          disabled={changed === 0 && !changedOnly}
          onClick={() => setChangedOnly((value) => !value)}
          title="Show only properties changed from their default"
          className={cn(
            'inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12px] font-medium transition-colors disabled:opacity-40',
            changedOnly
              ? 'border-brand bg-brand-soft text-brand'
              : 'border-border bg-panel text-text-muted hover:border-border-strong hover:text-text',
          )}
        >
          <span className="size-1.5 rounded-full bg-brand" aria-hidden />
          Changed
          <span className="tabular-nums">{changed}</span>
        </button>
        {tree.updating ? <Badge tone="warn">update block open</Badge> : null}
        <div className="ml-auto">{viewToggle}</div>
      </div>

      {general.length === 0 && sections.length === 0 ? (
        <div className="card">
          <EmptyState
            title={changedOnly ? 'Nothing changed' : 'No matching properties'}
            description={
              changedOnly ? 'Every property here is at its default value.' : 'Try a shorter search, or clear it.'
            }
          />
        </div>
      ) : null}

      {general.length > 0 ? (
        <PropertyCard title="General" nodes={general} componentId={componentId} readOnly={readOnly} index={0} />
      ) : null}
      {sections.map((section, index) => (
        <PropertyCard
          key={section.path.join('.')}
          title={humanizeName(section.name)}
          rawName={section.name}
          description={section.description}
          nodes={section.children ?? []}
          componentId={componentId}
          readOnly={readOnly}
          index={index + 1}
        />
      ))}
    </section>
  );
}

function PropertyCard({
  title,
  rawName,
  description,
  nodes,
  componentId,
  readOnly,
  index,
}: {
  title: string;
  rawName?: string;
  description?: string;
  nodes: PropertyNode[];
  componentId: string;
  readOnly: boolean;
  index: number;
}) {
  return (
    <div
      className="animate-enter card @container overflow-hidden"
      style={{ '--enter-delay': `${Math.min(index, 6) * 50}ms` } as React.CSSProperties}
    >
      <div className="flex items-baseline gap-2 border-b border-border px-4 py-2.5">
        <h4 className="text-[13px] font-semibold" title={rawName}>
          {title}
        </h4>
        <span className="text-[11.5px] text-text-faint">
          {nodes.length} setting{nodes.length === 1 ? '' : 's'}
        </span>
        {description ? <p className="w-full text-[11.5px] text-text-muted">{description}</p> : null}
      </div>
      <PropertyList nodes={nodes} componentId={componentId} readOnly={readOnly} depth={0} />
    </div>
  );
}

/** One line of a card: a heading for a nested object, or a property. */
type ListEntry = { kind: 'group'; node: PropertyNode; depth: number } | { kind: 'row'; node: PropertyNode; depth: number };

/**
 * Nested objects and struct fields as one flat list.
 *
 * Every level used to be a box inside a box, each with its own padding and rule
 * down the side, so three levels deep the rules stacked up and the editors were
 * pushed into a narrow column. Flat, each line spans the card and only its
 * indentation says how deep it is.
 */
function flatten(nodes: PropertyNode[], depth: number, out: ListEntry[] = []): ListEntry[] {
  for (const node of nodes) {
    if (node.valueType === 'object' && (node.children?.length ?? 0) > 0) {
      out.push({ kind: 'group', node, depth });
      flatten(node.children ?? [], depth + 1, out);
      continue;
    }
    out.push({ kind: 'row', node, depth });
    const synthetic = node.valueType === 'undefined' && node.children === null;
    if (!synthetic) for (const field of structFields(node)) out.push({ kind: 'row', node: field, depth: depth + 1 });
  }
  return out;
}

/** Left padding for a level: the card's own 16 px, then 20 px per level. */
const indent = (depth: number) => ({ paddingLeft: 16 + depth * 20 });

function PropertyList({
  nodes,
  componentId,
  readOnly,
  depth,
}: {
  nodes: PropertyNode[];
  componentId: string;
  readOnly: boolean;
  depth: number;
}) {
  const entries = flatten(nodes, depth);
  return (
    <div className="divide-y divide-border/70">
      {entries.map((entry) =>
        entry.kind === 'group' ? (
          <div key={`group:${entry.node.path.join('.')}`} className="flex items-baseline gap-2 bg-sunken/40 pt-3 pr-4 pb-1.5" style={indent(entry.depth)}>
            <span className="text-[11px] font-semibold tracking-wide text-text-muted uppercase" title={entry.node.name}>
              {humanizeName(entry.node.name)}
            </span>
            {entry.node.description ? <span className="truncate text-[11px] text-text-faint">{entry.node.description}</span> : null}
          </div>
        ) : (
          <PropertyRowCard
            key={entry.node.path.join('.')}
            node={entry.node}
            depth={entry.depth}
            componentId={componentId}
            readOnly={readOnly}
          />
        ),
      )}
    </div>
  );
}

/** The fields of a struct value, as rows the table's editor knows how to write. */
function structFields(node: PropertyNode): PropertyNode[] {
  if (!isStructValue(node.value)) return [];
  const fields = (node.value as { fields: Record<string, DaqValue> }).fields;
  return Object.keys(fields).map((field) => ({
    ...node,
    name: field,
    path: [...node.path, field],
    valueType: 'undefined',
    value: fields[field] ?? null,
    displayValue: formatDaqValue(fields[field] ?? null),
    defaultValue: null,
    children: null,
    structTypeName: null,
    selectionValues: null,
    minValue: null,
    maxValue: null,
  }));
}

function PropertyRowCard({
  node,
  depth,
  componentId,
  readOnly,
}: {
  node: PropertyNode;
  depth: number;
  componentId: string;
  readOnly: boolean;
}) {
  const menu = useContextMenu();
  const synthetic = node.valueType === 'undefined' && node.children === null;
  const locked = readOnly || node.readOnly;
  const items = usePropertyMenuItems(componentId, node, locked);
  const changed = !synthetic && isChangedFromDefault(node);
  const isStruct = !synthetic && isStructValue(node.value);

  return (
    <div
      onContextMenu={menu.open}
      className="group flex items-center gap-1 py-2.5 pr-1.5 transition-colors hover:bg-sunken/60"
      style={indent(depth)}
    >
      <div className="grid min-w-0 flex-1 grid-cols-1 items-center gap-x-5 gap-y-1.5 @lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className={cn('truncate text-[12.5px] font-medium', locked && 'text-text-muted')} title={node.name}>
              {synthetic ? node.name : humanizeName(node.name)}
            </span>
            {changed ? (
              <span
                className="size-1.5 shrink-0 rounded-full bg-brand"
                title={`Changed from the default (${describeDefault(node)})`}
                aria-label="Changed from default"
              />
            ) : null}
            {node.readOnly ? <Lock size={11} className="shrink-0 text-text-faint" aria-label="Read-only" /> : null}
            {node.isReferenced ? (
              <Badge tone="info" title="The value comes from another property">
                ref
              </Badge>
            ) : null}
          </div>
          {node.description ? <p className="mt-0.5 text-[11.5px] leading-snug text-text-muted">{node.description}</p> : null}
          {node.error ? <p className="mt-0.5 text-[11.5px] text-err">{node.error}</p> : null}
        </div>

        <div className="flex min-w-0 flex-col items-stretch gap-1 @lg:items-end">
          {isStruct ? (
            // Its fields follow as rows of their own, one level in.
            <span className="truncate text-[12px] text-text-faint" title={node.structTypeName ?? undefined}>
              {node.structTypeName || 'Structure'}
            </span>
          ) : (
            <CardEditor node={node} componentId={componentId} readOnly={readOnly} synthetic={synthetic} />
          )}
          {changed && !locked ? (
            <button
              type="button"
              onClick={() => void actions.clearProperty(componentId, node.path)}
              className="inline-flex items-center gap-1 self-end text-[11px] text-text-faint transition-colors hover:text-brand"
              title={`Back to the default: ${describeDefault(node)}`}
            >
              <RotateCcw size={10} /> Reset to {describeDefault(node)}
            </button>
          ) : null}
        </div>
      </div>

      {/* Its own column, so it never sits on top of the editor. */}
      <IconButton
        label="Property actions"
        size="sm"
        onClick={menu.open}
        className="shrink-0 self-center opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      >
        <MoreHorizontal size={13} />
      </IconButton>
      {menu.anchor ? (
        <ContextMenu items={items} anchor={menu.anchor} onClose={menu.close} ariaLabel={`Actions for ${node.name}`} />
      ) : null}
    </div>
  );
}

/**
 * The control for one value: buttons for a short choice, a slider with an exact
 * field for a bounded number, and the table's own editor for everything else.
 */
function CardEditor({
  node,
  componentId,
  readOnly,
  synthetic,
}: {
  node: PropertyNode;
  componentId: string;
  readOnly: boolean;
  synthetic: boolean;
}) {
  const locked = readOnly || node.readOnly;

  if (!synthetic && !locked && segmentable(node)) {
    const current = JSON.stringify(node.selectionKey);
    return (
      <div className="max-w-full">
        <ButtonGroup>
          {(node.selectionValues ?? []).map((option) => (
            <Segment
              key={JSON.stringify(option.key)}
              active={JSON.stringify(option.key) === current}
              onClick={() => void actions.setProperty(componentId, node.path, option.key)}
            >
              {option.label}
            </Segment>
          ))}
        </ButtonGroup>
      </div>
    );
  }

  const scale = synthetic || locked ? null : sliderScale(node);
  if (scale && typeof node.value === 'number') {
    return <SliderEditor node={node} scale={scale} componentId={componentId} />;
  }

  return (
    <div className="w-full min-w-0 @lg:max-w-[22rem]">
      <PropertyEditor
        componentId={componentId}
        node={node}
        locked={locked}
        componentLocked={readOnly}
        synthetic={synthetic}
      />
    </div>
  );
}

/**
 * A bounded number: drag for feel, type for precision.
 *
 * The value is written when the thumb is *released*, never while it moves - a
 * drag across a sample-rate slider would otherwise reconfigure the device dozens
 * of times on the way. While dragging, the field shows where it will land.
 */
function SliderEditor({ node, scale, componentId }: { node: PropertyNode; scale: SliderScale; componentId: string }) {
  const value = node.value as number;
  const integer = node.valueType === 'int';
  // The drag remembers the value it started from: once the device reports a
  // different one - the write landed, or someone else changed it - the drag is
  // over and the slider follows the device again.
  const [drag, setDrag] = useState<{ from: number; position: number } | null>(null);
  const position = drag && drag.from === value ? drag.position : null;

  const shown = position === null ? value : scale.toValue(position);
  const commit = () => {
    if (position === null) return;
    const next = scale.toValue(position);
    if (next !== value) void actions.setProperty(componentId, node.path, next);
    else setDrag(null);
  };
  const unit = node.unit?.symbol ?? '';
  const format = (number: number) => (integer ? String(Math.round(number)) : formatNumber(number, 6));

  return (
    <div className="flex w-full min-w-0 items-center gap-3 @lg:max-w-[26rem]">
      <div className="flex min-w-0 flex-1 flex-col">
        <input
          type="range"
          min={0}
          max={SLIDER_STEPS}
          step={1}
          value={position ?? scale.toPosition(value)}
          aria-label={`${node.name}${scale.kind === 'log' ? ' (logarithmic)' : ''}`}
          onChange={(event) => setDrag({ from: value, position: Number(event.target.value) })}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
          className="h-4 w-full cursor-pointer accent-[var(--color-brand)]"
        />
        <div className="flex justify-between text-[10px] text-text-faint">
          <span>{format(scale.min)}</span>
          {scale.kind === 'log' ? <span>log</span> : null}
          <span>{format(scale.max)}</span>
        </div>
      </div>
      <div className="flex w-32 shrink-0 items-center gap-1.5">
        <CommitInput
          value={position === null ? format(value) : format(shown)}
          ariaLabel={`${node.name} value`}
          align="right"
          mono
          onCommit={(next) => {
            const parsed = Number(next);
            if (!Number.isFinite(parsed)) return;
            void actions.setProperty(componentId, node.path, integer ? Math.round(parsed) : parsed);
          }}
          className={cn('min-w-0', position !== null && 'text-brand')}
        />
        {unit ? <span className="shrink-0 text-[11.5px] text-text-muted">{unit}</span> : null}
      </div>
    </div>
  );
}
