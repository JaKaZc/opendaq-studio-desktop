import { ChevronDown, ChevronRight } from 'lucide-react';
import { useCollapsed } from '../../store/useCollapsed';

/** The chevron that collapses or expands a group of signals. */
export function GroupToggle({ groupKey, label }: { groupKey: string; label: string }) {
  const collapsed = useCollapsed((state) => state.collapsed.has(groupKey));
  const toggle = useCollapsed((state) => state.toggle);
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        toggle(groupKey);
      }}
      aria-expanded={!collapsed}
      aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${label}`}
      className="inline-flex size-5 shrink-0 items-center justify-center rounded text-text-faint hover:bg-sunken hover:text-text"
    >
      {collapsed ? <ChevronRight size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
    </button>
  );
}

/** Whether a group is collapsed. */
export function useIsCollapsed(groupKey: string): boolean {
  return useCollapsed((state) => state.collapsed.has(groupKey));
}
