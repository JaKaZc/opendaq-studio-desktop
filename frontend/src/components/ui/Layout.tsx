import type { ReactNode } from 'react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { cn } from '../../lib/utils';

/**
 * A draggable splitter between two panes.
 *
 * Resizing is done by writing the size straight to the DOM during the drag and
 * only committing to React state on release: a controlled re-render per
 * mousemove would stutter the whole layout, including the scope canvas.
 */
export function SplitPane({
  orientation = 'horizontal',
  size,
  onSizeChange,
  min = 180,
  max = 720,
  minSecond = 120,
  first,
  second,
  className,
  ariaLabel = 'Resize panels',
}: {
  orientation?: 'horizontal' | 'vertical';
  /** Size of the first pane, in pixels. */
  size: number;
  onSizeChange: (size: number) => void;
  min?: number;
  max?: number;
  /** Room always left for the second pane, however large the saved size - a
   *  window made narrower later must not squeeze it to nothing. */
  minSecond?: number;
  first: ReactNode;
  second: ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const firstRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const isHorizontal = orientation === 'horizontal';

  const clampSize = useCallback(
    (value: number) => {
      const container = containerRef.current;
      const limit = container
        ? (isHorizontal ? container.clientWidth : container.clientHeight) - minSecond
        : max;
      return Math.max(min, Math.min(Math.min(max, limit), value));
    },
    [isHorizontal, max, min, minSecond],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault();
      const container = containerRef.current;
      const pane = firstRef.current;
      if (!container || !pane) return;

      setDragging(true);
      const rect = container.getBoundingClientRect();
      const origin = isHorizontal ? rect.left : rect.top;
      let latest = size;

      const move = (pointer: PointerEvent) => {
        const raw = (isHorizontal ? pointer.clientX : pointer.clientY) - origin;
        latest = clampSize(raw);
        // Direct style write: no React render on the drag path.
        if (isHorizontal) pane.style.width = `${latest}px`;
        else pane.style.height = `${latest}px`;
      };

      const finish = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        setDragging(false);
        onSizeChange(latest);
      };

      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    },
    [clampSize, isHorizontal, onSizeChange, size],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const step = event.shiftKey ? 40 : 12;
      const decrease = isHorizontal ? 'ArrowLeft' : 'ArrowUp';
      const increase = isHorizontal ? 'ArrowRight' : 'ArrowDown';
      if (event.key === decrease) {
        event.preventDefault();
        onSizeChange(clampSize(size - step));
      } else if (event.key === increase) {
        event.preventDefault();
        onSizeChange(clampSize(size + step));
      }
    },
    [clampSize, isHorizontal, onSizeChange, size],
  );

  return (
    <div
      ref={containerRef}
      className={cn('flex min-h-0 min-w-0', isHorizontal ? 'flex-row' : 'flex-col', className)}
    >
      <div
        ref={firstRef}
        className="flex min-h-0 min-w-0 shrink-0 flex-col"
        style={
          isHorizontal
            ? { width: size, maxWidth: `calc(100% - ${minSecond}px)` }
            : { height: size, maxHeight: `calc(100% - ${minSecond}px)` }
        }
      >
        {first}
      </div>
      <div
        role="separator"
        aria-label={ariaLabel}
        aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
        aria-valuenow={Math.round(size)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onDoubleClick={() => onSizeChange(clampSize(isHorizontal ? 320 : 260))}
        className={cn(
          'group relative shrink-0 bg-border transition-colors',
          isHorizontal ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
          dragging && 'bg-brand',
        )}
      >
        {/* A 9px invisible hit area over a 1px visual line. */}
        <span
          className={cn(
            'absolute',
            isHorizontal ? '-inset-x-1 inset-y-0' : '-inset-y-1 inset-x-0',
            'group-hover:bg-[color-mix(in_oklab,var(--color-brand)_35%,transparent)]',
          )}
        />
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">{second}</div>
    </div>
  );
}

/** A titled section with an optional toolbar on the right. */
export function Section({
  title,
  actions,
  children,
  className,
  bodyClassName,
  count,
}: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  count?: number;
}) {
  return (
    <section className={cn('flex min-h-0 flex-col', className)}>
      <div className="section-bar">
        <span className="min-w-0 truncate">{title}</span>
        {count !== undefined ? <span className="text-text-faint">{count}</span> : null}
        {actions ? <div className="ml-auto flex items-center gap-1">{actions}</div> : null}
      </div>
      <div className={cn('min-h-0 flex-1', bodyClassName)}>{children}</div>
    </section>
  );
}

export interface TabDefinition {
  id: string;
  label: ReactNode;
  hint?: string;
  badge?: ReactNode;
  disabled?: boolean;
}

/**
 * Horizontal tabs with proper roles and arrow-key navigation.
 *
 * `wrap` is for tab strips inside a resizable pane: scrolling them horizontally
 * hides the last tabs behind an affordance nobody looks for, so a strip that has
 * to stay *complete* at any width wraps onto a second row instead.
 */
export function Tabs({
  tabs,
  active,
  onChange,
  className,
  ariaLabel,
  size = 'md',
  wrap = false,
}: {
  tabs: TabDefinition[];
  active: string;
  onChange: (id: string) => void;
  className?: string;
  ariaLabel: string;
  size?: 'sm' | 'md';
  wrap?: boolean;
}) {
  const baseId = useId();
  const enabled = tabs.filter((tab) => !tab.disabled);

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn(
        'flex items-stretch gap-px border-b border-border',
        wrap ? 'flex-wrap' : 'overflow-x-auto',
        className,
      )}
      onKeyDown={(event) => {
        if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
        event.preventDefault();
        const index = enabled.findIndex((tab) => tab.id === active);
        const next =
          event.key === 'ArrowRight'
            ? enabled[(index + 1) % enabled.length]
            : enabled[(index - 1 + enabled.length) % enabled.length];
        if (next) onChange(next.id);
      }}
    >
      {tabs.map((tab) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            id={`${baseId}-${tab.id}`}
            role="tab"
            type="button"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={tab.disabled}
            title={tab.hint}
            onClick={() => onChange(tab.id)}
            className={cn(
              'relative flex shrink-0 items-center gap-1.5 whitespace-nowrap font-medium transition-colors',
              size === 'sm' ? 'px-2.5 py-1 text-[12px]' : 'px-3 py-1.5 text-[12.5px]',
              'disabled:cursor-not-allowed disabled:opacity-40',
              selected ? 'text-text' : 'text-text-muted hover:text-text',
            )}
          >
            {tab.label}
            {tab.badge}
            {selected ? <span className="absolute inset-x-0 -bottom-px h-0.5 bg-brand" /> : null}
          </button>
        );
      })}
    </div>
  );
}

/** Observe an element's size; used by the canvas panels. */
export function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((previous) =>
        Math.abs(previous.width - width) < 0.5 && Math.abs(previous.height - height) < 0.5
          ? previous
          : { width, height },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, ...size };
}
