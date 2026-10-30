import { ComponentTree } from '../tree/ComponentTree';
import { DetailPanel } from '../detail/DetailPanel';
import { SplitPane } from '../ui/Layout';
import { useSettings } from '../../store/useSettings';
import { useTimePolling } from '../../store/useTime';

/** Navigator on the left, component detail on the right. */
export function ViewerPage() {
  useTimePolling();
  const sidebarWidth = useSettings((state) => state.sidebarWidth);
  const setSetting = useSettings((state) => state.set);

  return (
    <SplitPane
      className="min-h-0 flex-1"
      size={sidebarWidth}
      onSizeChange={(size) => setSetting('sidebarWidth', size)}
      min={260}
      max={640}
      minSecond={380}
      ariaLabel="Resize the navigator"
      first={<ComponentTree />}
      second={
        <div className="flex min-h-0 flex-1 flex-col border-l border-border bg-surface">
          <DetailPanel />
        </div>
      }
    />
  );
}
