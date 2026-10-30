import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export interface PageTab<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
  /** A count or a status shown after the label. */
  badge?: ReactNode;
}

/**
 * The sections of a workspace, as a row of pills under the top bar.
 *
 * One component for every workspace with sections, so moving from Test to
 * System feels the same. Arrow keys move between the pills.
 */
export function PageTabs<T extends string>({
  tabs,
  active,
  onChange,
  label,
  aside,
}: {
  tabs: PageTab<T>[];
  active: T;
  onChange: (id: T) => void;
  label: string;
  /** Actions on the right of the row. */
  aside?: ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border bg-panel px-4 py-2">
      <div
        role="tablist"
        aria-label={label}
        className="inline-flex rounded-full bg-sunken p-0.5"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
          const index = tabs.findIndex((tab) => tab.id === active);
          const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
          if (next) onChange(next.id);
        }}
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === active}
            tabIndex={tab.id === active ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={cn(
              'inline-flex h-7 items-center gap-1.5 rounded-full px-3.5 text-[12.5px] font-medium transition-colors',
              tab.id === active ? 'bg-panel text-text shadow-sm' : 'text-text-muted hover:text-text',
            )}
          >
            {tab.icon}
            {tab.label}
            {tab.badge}
          </button>
        ))}
      </div>
      {aside ? <div className="ml-auto flex items-center gap-2">{aside}</div> : null}
    </div>
  );
}
