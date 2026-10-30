import type { ReactNode } from 'react';
import { useCallback, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { Button } from './Button';
import { IconButton } from './Button';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

const SIZES: Record<ModalSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-2xl',
  lg: 'max-w-4xl',
  xl: 'max-w-6xl',
};

/**
 * A focus-trapping modal dialog.
 *
 * Written by hand rather than pulled from a component library: the behaviour
 * needed here is small and well defined (Escape closes, focus is trapped, the
 * page behind does not scroll), and one fewer dependency is one fewer thing to
 * upgrade.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  size = 'md',
  children,
  footer,
  /** Keep the dialog open when the backdrop is clicked; for dialogs with edits. */
  persistent = false,
  bodyClassName,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  size?: ModalSize;
  children: ReactNode;
  footer?: ReactNode;
  persistent?: boolean;
  bodyClassName?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    // Focus the first control so keyboard users land inside the dialog.
    const timer = window.setTimeout(() => {
      const target = panelRef.current?.querySelector<HTMLElement>(
        '[data-autofocus], input:not([type=hidden]), select, textarea, button',
      );
      (target ?? panelRef.current)?.focus();
    }, 0);

    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = overflow;
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable || focusable.length === 0) return;
      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-8"
      role="presentation"
    >
      <div
        className="fixed inset-0 bg-[color-mix(in_oklab,var(--color-brand-navy)_55%,transparent)] backdrop-blur-[2px]"
        onClick={persistent ? undefined : onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn(
          'panel relative z-10 my-auto flex max-h-[calc(100vh-4rem)] w-full flex-col',
          'shadow-[var(--shadow-popover)]',
          SIZES[size],
        )}
      >
        <header className="flex items-start gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-[14px] font-semibold">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="mt-0.5 text-[12px] leading-snug text-text-muted">
                {description}
              </p>
            ) : null}
          </div>
          <IconButton label="Close" size="sm" onClick={onClose}>
            <X size={15} />
          </IconButton>
        </header>

        <div className={cn('min-h-0 flex-1 overflow-y-auto px-4 py-3', bodyClassName)}>{children}</div>

        {footer ? (
          <footer className="flex items-center justify-end gap-2 border-t border-border bg-sunken px-4 py-2.5">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/** Confirmation for actions that cannot be undone. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = true,
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={busy}
            data-autofocus
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-[12.5px] leading-relaxed text-text-muted">{message}</div>
    </Modal>
  );
}
