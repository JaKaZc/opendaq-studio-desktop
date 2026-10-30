import type { CSSProperties, ReactNode } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Info, Inbox } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { NotificationLevel, StatusLevel } from '../../lib/types';

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={cn('animate-spin', className)}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export type BadgeTone = 'neutral' | 'ok' | 'warn' | 'err' | 'info' | 'brand';

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-sunken text-text-muted border-border',
  ok: 'bg-ok-soft text-ok border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
  err: 'bg-err-soft text-err border-transparent',
  info: 'bg-info-soft text-info border-transparent',
  brand: 'bg-brand text-brand-contrast border-transparent',
};

export function Badge({
  tone = 'neutral',
  children,
  className,
  title,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10.5px] leading-4 font-medium whitespace-nowrap',
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Map a component status level onto a badge tone. */
export function statusTone(level: StatusLevel): BadgeTone {
  switch (level) {
    case 'ok':
      return 'ok';
    case 'warning':
      return 'warn';
    case 'error':
      return 'err';
    default:
      return 'neutral';
  }
}

/** The small coloured dot used in the tree and block headers. */
export function StatusDot({
  level,
  size = 8,
  className,
  title,
}: {
  level: StatusLevel;
  size?: number;
  className?: string;
  title?: string;
}) {
  const color =
    level === 'ok'
      ? 'var(--color-ok)'
      : level === 'warning'
        ? 'var(--color-warn)'
        : level === 'error'
          ? 'var(--color-err)'
          : 'var(--color-text-faint)';
  return (
    <span
      className={cn('inline-block shrink-0 rounded-full', className)}
      style={{ width: size, height: size, backgroundColor: color }}
      title={title}
      role="img"
      aria-label={`Status: ${level}`}
    />
  );
}

export function LevelIcon({ level, size = 14 }: { level: NotificationLevel; size?: number }) {
  const props = { size, 'aria-hidden': true } as const;
  switch (level) {
    case 'success':
      return <CheckCircle2 {...props} className="text-ok" />;
    case 'warning':
      return <AlertTriangle {...props} className="text-warn" />;
    case 'error':
      return <AlertCircle {...props} className="text-err" />;
    default:
      return <Info {...props} className="text-info" />;
  }
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-10 text-center text-text-muted',
        className,
      )}
    >
      <span className="text-text-faint">{icon ?? <Inbox size={22} aria-hidden />}</span>
      <p className="text-[13px] font-medium text-text">{title}</p>
      {description ? <p className="max-w-sm text-[12px] leading-relaxed">{description}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  action,
  className,
}: {
  title?: string;
  message?: string | null;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 px-6 py-8 text-center', className)}>
      <AlertCircle size={22} className="text-err" aria-hidden />
      <p className="text-[13px] font-medium text-text">{title}</p>
      {message ? <p className="max-w-md text-[12px] leading-relaxed text-text-muted">{message}</p> : null}
      {action}
    </div>
  );
}

export function Skeleton({
  className,
  style,
}: {
  className?: string;
  style?: CSSProperties;
}) {
  return <div className={cn('skeleton', className)} style={style} aria-hidden />;
}

/** A labelled key/value row, used throughout the detail panels. */
export function InfoRow({
  label,
  children,
  mono,
  className,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex items-baseline gap-3 py-0.5', className)}>
      <dt className="w-32 shrink-0 text-[11.5px] text-text-muted">{label}</dt>
      <dd className={cn('min-w-0 flex-1 break-words text-[12.5px]', mono && 'num')}>{children}</dd>
    </div>
  );
}
