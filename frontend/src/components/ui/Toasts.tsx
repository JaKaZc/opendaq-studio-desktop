import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useSession } from '../../store/useSession';
import { cn } from '../../lib/utils';
import { IconButton } from './Button';
import { LevelIcon } from './Feedback';

/** How long a non-error toast stays up. Errors persist until dismissed. */
const TRANSIENT_MS = 5000;

export function Toasts() {
  const toasts = useSession((state) => state.toasts);
  const dismiss = useSession((state) => state.dismissToast);

  useEffect(() => {
    const timers = toasts
      .filter((toast) => toast.transient)
      .map((toast) => window.setTimeout(() => dismiss(toast.id), TRANSIENT_MS));
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [toasts, dismiss]);

  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-3 z-70 flex flex-col items-center gap-2 px-3"
      // Assertive so an error interrupts a screen reader; the log holds the history.
      role="log"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cn(
            'panel pointer-events-auto flex w-full max-w-xl items-start gap-2.5 px-3 py-2',
            'shadow-[var(--shadow-popover)]',
            toast.level === 'error' && 'border-err',
            toast.level === 'warning' && 'border-warn',
          )}
        >
          <span className="mt-0.5 shrink-0">
            <LevelIcon level={toast.level} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[12.5px] leading-snug font-medium break-words">{toast.message}</p>
            {toast.detail ? (
              <p className="mt-0.5 text-[11.5px] leading-snug break-words text-text-muted">{toast.detail}</p>
            ) : null}
          </div>
          <IconButton label="Dismiss" size="sm" onClick={() => dismiss(toast.id)}>
            <X size={13} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
