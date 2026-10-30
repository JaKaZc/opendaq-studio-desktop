import type { ReactNode } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils';

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  disabled?: boolean;
  destructive?: boolean;
  onSelect?: () => void;
  /** Renders a divider above this entry. */
  separatorBefore?: boolean;
  /** Renders a non-interactive group heading instead of an item. */
  heading?: boolean;
}

/**
 * A menu anchored to a point, used both for right-click menus and for buttons.
 *
 * It renders into a portal and flips against the viewport edges so a menu opened
 * near the bottom of a long tree stays on screen.
 */
export function ContextMenu({
  items,
  anchor,
  onClose,
  ariaLabel = 'Actions',
}: {
  items: MenuItem[];
  anchor: { x: number; y: number };
  onClose: () => void;
  ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState(anchor);
  const [activeIndex, setActiveIndex] = useState(-1);

  const selectable = items.filter((item) => !item.heading && !item.disabled);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const margin = 8;
    setPosition({
      x: Math.min(anchor.x, window.innerWidth - rect.width - margin),
      y: Math.min(anchor.y, window.innerHeight - rect.height - margin),
    });
  }, [anchor.x, anchor.y, items.length]);

  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    // `capture` so a click that also selects a tree row does not reopen the menu.
    window.addEventListener('mousedown', dismiss, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', dismiss, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % Math.max(1, selectable.length));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + selectable.length) % Math.max(1, selectable.length));
      } else if (event.key === 'Enter' && activeIndex >= 0) {
        event.preventDefault();
        const item = selectable[activeIndex];
        if (item) {
          onClose();
          item.onSelect?.();
        }
      }
    },
    [activeIndex, onClose, selectable],
  );

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      autoFocus
      style={{ left: position.x, top: position.y }}
      className={cn(
        'fixed z-60 min-w-48 overflow-hidden rounded-[var(--radius-panel)] border border-border',
        'bg-elevated py-1 shadow-[var(--shadow-popover)]',
      )}
    >
      {items.map((item, index) => {
        if (item.heading) {
          return (
            <div
              key={item.id}
              className="px-2.5 pt-2 pb-1 text-[10.5px] font-semibold tracking-wide text-text-faint uppercase"
            >
              {item.label}
            </div>
          );
        }
        const selectableIndex = selectable.indexOf(item);
        return (
          <div key={item.id}>
            {item.separatorBefore && index > 0 ? <div className="my-1 h-px bg-border" /> : null}
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onMouseEnter={() => setActiveIndex(selectableIndex)}
              onClick={() => {
                onClose();
                item.onSelect?.();
              }}
              className={cn(
                'flex w-full items-center gap-2 px-2.5 py-1 text-left text-[12.5px]',
                'disabled:cursor-not-allowed disabled:opacity-40',
                item.destructive ? 'text-err' : 'text-text',
                !item.disabled && 'hover:bg-sunken',
                selectableIndex === activeIndex && !item.disabled && 'bg-sunken',
              )}
            >
              <span className="flex w-4 shrink-0 justify-center text-text-muted">{item.icon}</span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.hint ? <span className="shrink-0 text-[11px] text-text-faint">{item.hint}</span> : null}
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

/** Hook that manages a context menu's open state and anchor point. */
export function useContextMenu() {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);

  const open = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setAnchor({ x: event.clientX, y: event.clientY });
  }, []);

  const openAtElement = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setAnchor({ x: rect.left, y: rect.bottom + 4 });
  }, []);

  const close = useCallback(() => setAnchor(null), []);

  return { anchor, open, openAtElement, close, isOpen: anchor !== null };
}

/** A button that opens a menu below itself. */
export function MenuButton({
  items,
  children,
  className,
  ariaLabel,
  title,
}: {
  items: MenuItem[];
  children: ReactNode;
  className?: string;
  ariaLabel: string;
  title?: string;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { anchor, openAtElement, close, isOpen } = useContextMenu();

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        title={title ?? ariaLabel}
        onClick={() => (isOpen ? close() : openAtElement(buttonRef.current))}
        className={className}
      >
        {children}
      </button>
      {anchor ? <ContextMenu items={items} anchor={anchor} onClose={close} ariaLabel={ariaLabel} /> : null}
    </>
  );
}
