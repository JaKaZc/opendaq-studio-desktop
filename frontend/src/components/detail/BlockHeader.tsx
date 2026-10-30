import { useMemo, useState } from 'react';
import { ChevronRight, CircleDot, Lock, Play, Settings2, Square, Unlock } from 'lucide-react';
import { actions } from '../../lib/actions';
import { cn } from '../../lib/utils';
import { ellipsize } from '../../lib/format';
import type { ComponentDetail, OperationMode } from '../../lib/types';
import { findNode, pathTo } from '../../lib/views';
import { useDialogs } from '../../store/useDialogs';
import { useSession } from '../../store/useSession';
import { Button, ButtonGroup, IconButton, Segment } from '../ui/Button';
import { Badge, StatusDot, statusTone } from '../ui/Feedback';
import { Select, Switch } from '../ui/Field';
import { NodeIcon, kindLabel } from '../tree/NodeIcon';

const MODE_LABELS: Record<string, string> = {
  Idle: 'Idle',
  Operation: 'Operation',
  SafeOperation: 'Safe operation',
  Unknown: 'Unknown',
};

/**
 * The top of the inspector: where this component sits, what it is, whether it
 * is running, and the controls that belong to it as a whole rather than to one
 * property.
 *
 * The path above the name is the way back up - every step is a link - which is
 * what a tree used to be needed for; the name itself is set large, because it
 * is the one thing on the page everything else is about.
 */
export function BlockHeader({ detail, readOnly }: { detail: ComponentDetail; readOnly: boolean }) {
  const { node } = detail;
  const openDialog = useDialogs((state) => state.open);
  const [busy, setBusy] = useState(false);

  const statusEntries = Object.entries(node.status.statuses);
  const locked = readOnly || Boolean(node.device?.locked);
  const modes = node.device?.availableOperationModes ?? [];
  const typeName = node.functionBlock?.typeName || node.functionBlock?.typeId;

  return (
    <header className="animate-enter card px-5 pt-4 pb-4">
      <Breadcrumb id={node.id} />

      <div className="mt-3 flex items-start gap-3.5">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-[12px] border border-border bg-sunken">
          <NodeIcon kind={node.kind} size={20} />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h2 className="kpi-number truncate text-[26px]" title={node.id}>
              {node.name || node.localId}
            </h2>
            <Badge>{kindLabel(node.kind)}</Badge>
            {typeName ? (
              <span className="font-mono text-[11px] text-text-faint" title="Type">
                {typeName}
              </span>
            ) : null}
            {node.device?.locked ? (
              <Badge tone="warn">
                <Lock size={9} />
                locked
              </Badge>
            ) : null}
            {node.device && !node.device.connected ? <Badge tone="err">disconnected</Badge> : null}
            {node.functionBlock?.moduleAvailable === false ? (
              <Badge
                tone="warn"
                title={`openDAQ Studio has no module for ${node.functionBlock.typeId}, so it cannot be configured here`}
              >
                module missing
              </Badge>
            ) : null}
            {!node.visible ? <Badge>hidden</Badge> : null}
          </div>
          {node.description ? (
            <p className="mt-1.5 max-w-2xl text-[12.5px] leading-snug text-text-muted">{node.description}</p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {node.functionBlock?.isRecorder ? (
            <Button
              size="sm"
              variant={node.functionBlock.isRecording ? 'danger' : 'primary'}
              disabled={readOnly}
              loading={busy}
              icon={node.functionBlock.isRecording ? <Square size={11} /> : <CircleDot size={11} />}
              onClick={async () => {
                setBusy(true);
                await actions.setRecording(node.id, !node.functionBlock?.isRecording);
                setBusy(false);
              }}
            >
              {node.functionBlock.isRecording ? 'Stop recording' : 'Record'}
            </Button>
          ) : null}
          <IconButton label="Edit attributes" size="sm" onClick={() => openDialog({ kind: 'attributes', componentId: node.id })}>
            <Settings2 size={15} />
          </IconButton>
        </div>
      </div>

      {/* The controls for the component as a whole, as a strip of pills. */}
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <label
          className={cn(
            'inline-flex h-8 items-center gap-2 rounded-full border px-3 text-[12px] font-medium transition-colors',
            node.active ? 'border-ok/40 bg-ok-soft text-ok' : 'border-border bg-sunken text-text-muted',
          )}
          title={node.parentActive ? undefined : 'The parent component is inactive'}
        >
          <Switch
            checked={node.active}
            disabled={!node.parentActive || readOnly}
            label="Active"
            onChange={(next) => void actions.setActive(node.id, next)}
          />
          {node.active ? 'Active' : 'Inactive'}
        </label>

        {modes.length > 0 ? (
          modes.length <= 4 ? (
            <ButtonGroup>
              {modes.map((mode) => (
                <Segment
                  key={mode}
                  active={node.device?.operationMode === mode}
                  disabled={locked}
                  onClick={() => void actions.setOperationMode(node.id, mode as OperationMode)}
                  title="Operation mode"
                >
                  {MODE_LABELS[mode] ?? mode}
                </Segment>
              ))}
            </ButtonGroup>
          ) : (
            <Select
              size="sm"
              className="w-40"
              value={node.device?.operationMode ?? 'Unknown'}
              disabled={locked}
              aria-label="Operation mode"
              onChange={(event) => void actions.setOperationMode(node.id, event.target.value as OperationMode)}
            >
              {modes.map((mode) => (
                <option key={mode} value={mode}>
                  {MODE_LABELS[mode] ?? mode}
                </option>
              ))}
            </Select>
          )
        ) : null}

        {node.kind === 'device' && !node.device?.isRoot ? (
          <Button
            size="sm"
            variant="ghost"
            icon={node.device?.locked ? <Unlock size={12} /> : <Lock size={12} />}
            disabled={readOnly}
            onClick={() =>
              node.device?.locked ? void actions.setLock(node.id, false) : void actions.setLock(node.id, true)
            }
          >
            {node.device?.locked ? 'Unlock' : 'Lock'}
          </Button>
        ) : null}

        {node.kind === 'server' ? (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => void actions.setServerDiscovery(node.id, true)}>
              Enable discovery
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void actions.setServerDiscovery(node.id, false)}>
              Disable
            </Button>
          </div>
        ) : null}

        {node.tags.length > 0 ? (
          <div className="flex items-center gap-1">
            {node.tags.slice(0, 4).map((tag) => (
              <Badge key={tag} tone="info">
                {tag}
              </Badge>
            ))}
          </div>
        ) : null}

        {statusEntries.length > 0 ? (
          <button
            type="button"
            onClick={() => openDialog({ kind: 'statuses', componentId: node.id })}
            className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-full border border-border px-3 text-[12px] transition-colors hover:border-border-strong"
            title="Show all statuses"
          >
            <StatusDot level={node.status.level} />
            <span className="text-text-muted">
              {node.status.message
                ? ellipsize(node.status.message, 44)
                : statusEntries.length === 1
                  ? 'Status'
                  : `${statusEntries.length} statuses`}
            </span>
            {node.status.level === 'error' || node.status.level === 'warning' ? (
              <Badge tone={statusTone(node.status.level)}>{node.status.level}</Badge>
            ) : null}
          </button>
        ) : null}
      </div>

      {node.updating ? (
        <div className="mt-3 flex items-center gap-2 rounded-[var(--radius-control)] bg-warn-soft px-3 py-2 text-[12px] text-warn">
          <span className="flex-1">
            An update block is open: property writes are collected and applied together when it is committed.
          </span>
          <Button size="sm" icon={<Play size={11} />} onClick={() => void actions.endUpdate(node.id)}>
            Commit now
          </Button>
        </div>
      ) : null}
    </header>
  );
}

/**
 * Where the component sits, each step a link back up.
 *
 * The SDK's storage folders - "Dev", "IO", "FB", "Sig" - are skipped, as they
 * are in the navigator, so the path reads as devices and what is on them; a
 * folder a device names itself ("AI") stays.
 */
function Breadcrumb({ id }: { id: string }) {
  const tree = useSession((state) => state.tree);
  const select = useSession((state) => state.select);

  const steps = useMemo(() => {
    if (!tree) return [];
    return pathTo(tree, id)
      .map((ancestorId) => findNode(tree, ancestorId))
      .filter((node) => node !== null && !node.isDefaultFolder);
  }, [id, tree]);

  if (steps.length === 0) return null;
  return (
    <nav aria-label="Location" className="flex min-w-0 flex-wrap items-center gap-0.5 text-[11.5px] text-text-faint">
      {steps.map((step) =>
        step ? (
          <span key={step.id} className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => void select(step.id)}
              className="max-w-[12rem] truncate rounded px-1 py-0.5 transition-colors hover:bg-sunken hover:text-text"
              title={step.id}
            >
              {step.displayName || step.name}
            </button>
            <ChevronRight size={11} aria-hidden />
          </span>
        ) : null,
      )}
    </nav>
  );
}
