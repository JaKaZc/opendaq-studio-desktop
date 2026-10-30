import { MousePointerClick, PackageX } from 'lucide-react';
import { useSession } from '../../store/useSession';
import { EmptyState, ErrorState, Skeleton } from '../ui/Feedback';
import { BlockHeader } from './BlockHeader';
import { InputPortsPanel } from './InputPortsPanel';
import { PropertyInspector } from './PropertyInspector';
import { SignalsPanel } from './SignalsPanel';
import { TimeCard } from '../time/TimeSync';

/**
 * The right-hand pane: everything about the selected component.
 *
 * Layout follows how the information is used - identity and state on top,
 * configuration on the left, signal flow on the right - so an operator can read
 * "what is this, is it running, what does it produce" without scrolling.
 */
export function DetailPanel() {
  const detail = useSession((state) => state.detail);
  const loading = useSession((state) => state.detailLoading);
  const error = useSession((state) => state.detailError);
  const selectedId = useSession((state) => state.selectedId);
  const info = useSession((state) => state.info);
  const refreshDetail = useSession((state) => state.refreshDetail);


  if (!selectedId) {
    return (
      <EmptyState
        className="h-full"
        icon={<MousePointerClick size={22} aria-hidden />}
        title="Select a component"
        description="Pick a device, channel, function block or signal in the navigator to see its properties, statuses and signals."
      />
    );
  }

  if (error) {
    return (
      <ErrorState
        className="h-full"
        title="Could not load this component"
        message={error}
        action={
          <button
            type="button"
            onClick={() => void refreshDetail()}
            className="mt-1 text-[12px] text-accent underline"
          >
            Try again
          </button>
        }
      />
    );
  }

  if (!detail) {
    // The same shapes the inspector will have, so it arrives rather than jumps.
    return (
      <div className="min-h-0 flex-1 overflow-y-auto bg-surface">
        <div className="mx-auto flex max-w-[1000px] flex-col gap-4 p-5">
          <div className="card space-y-3 p-5">
            <Skeleton className="h-3 w-48" />
            <Skeleton className="h-7 w-64" />
            <Skeleton className="h-7 w-80" />
          </div>
          <div className="card space-y-2.5 p-5">
            {Array.from({ length: 6 }).map((_, index) => (
              <Skeleton key={index} className="h-7" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // A locked device refuses property writes; grey the controls rather than
  // letting the user discover it one failed write at a time.
  const readOnly = Boolean(info?.readOnly) || Boolean(detail.node.device?.locked);

  // One column of cards, read top to bottom in the order the questions come:
  // what is this, what is it producing right now, how does it keep time, how is
  // it configured, what does it read. The outputs sit above the settings on
  // purpose - change a setting and the reading it affects moves in view.
  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto bg-surface">
      {loading ? (
        <div className="sticky top-0 z-10 h-0.5 w-full animate-pulse bg-brand" aria-hidden />
      ) : null}
      <div key={detail.node.id} className="mx-auto flex max-w-[1000px] flex-col gap-4 p-5">
        <BlockHeader detail={detail} readOnly={readOnly} />

        {detail.node.kind === 'device' || detail.node.kind === 'instance' ? (
          <TimeCard deviceId={detail.node.id} isInstance={detail.node.kind === 'instance'} />
        ) : null}

        {detail.node.functionBlock?.moduleAvailable === false ? (
          <MissingModuleNotice typeId={detail.node.functionBlock.typeId ?? 'this type'} />
        ) : null}

        {detail.signals.length > 0 ? <SignalsPanel signals={detail.signals} readOnly={readOnly} /> : null}

        <PropertyInspector
          componentId={detail.node.id}
          tree={detail.properties}
          readOnly={readOnly}
          emptyHint={
            detail.node.kind === 'inputPort'
              ? 'Input ports are configured through the function block that owns them.'
              : undefined
          }
        />

        <InputPortsPanel ports={detail.inputPorts} readOnly={readOnly} />
      </div>
    </div>
  );
}

/**
 * Why a function block from the device is inert here.
 *
 * The device holds it, so it is shown - hiding it would make the tree disagree
 * with the hardware. But its module lives only on the device, so this viewer
 * cannot build the type: its properties do not come through and it cannot be
 * configured. Saying that is the difference between a limitation and a bug.
 */
function MissingModuleNotice({ typeId }: { typeId: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-[var(--radius-card)] border border-warn/40 bg-warn-soft px-4 py-3 text-[12px] leading-relaxed">
      <PackageX size={13} className="mt-0.5 shrink-0 text-warn" aria-hidden />
      <div className="min-w-0">
        <strong className="font-semibold">No module for {typeId}.</strong> The device provides this
        function block, so it is listed with its signals and ports, but openDAQ Studio cannot build the
        type, so its properties are unavailable and it cannot be configured from here. Add the
        device's module with <code className="code-chip">--module-path</code> or{' '}
        <strong>File → Load module…</strong>, then reconnect.
      </div>
    </div>
  );
}
