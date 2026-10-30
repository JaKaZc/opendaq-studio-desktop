import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';
import { cn } from '../../lib/utils';
import { Spinner } from './Feedback';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'accent';
export type ButtonSize = 'sm' | 'md';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-brand text-brand-contrast hover:bg-brand-orange-600 active:brightness-95 border border-transparent',
  accent: 'bg-accent text-panel hover:brightness-110 active:brightness-95 border border-transparent',
  secondary: 'bg-panel text-text border border-border-strong hover:bg-sunken active:bg-sunken',
  ghost: 'bg-transparent text-text-muted hover:bg-sunken hover:text-text border border-transparent',
  danger: 'bg-err text-white hover:brightness-110 active:brightness-95 border border-transparent',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-6.5 px-2 text-[12px] gap-1.5',
  md: 'h-8 px-3 text-[13px] gap-2',
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: ReactNode;
  /** Fill the parent's width; used inside dialog footers and toolbars. */
  block?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, block, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[var(--radius-control)] font-medium',
        'transition-colors duration-100 select-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={size === 'sm' ? 12 : 14} /> : icon}
      {children}
    </button>
  );
});

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Always required: an icon-only control needs an accessible name. */
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, variant = 'ghost', size = 'md', active, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={rest.type ?? 'button'}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[var(--radius-control)]',
        'transition-colors duration-100',
        'disabled:cursor-not-allowed disabled:opacity-40',
        size === 'sm' ? 'size-6.5' : 'size-8',
        active ? 'bg-accent-soft text-accent' : VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

/** Segmented control: a row of buttons that reads as one unit. */
export function ButtonGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'inline-flex items-center rounded-[var(--radius-control)] border border-border bg-panel p-0.5',
        className,
      )}
      role="group"
    >
      {children}
    </div>
  );
}

interface SegmentProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  active: boolean;
  children: ReactNode;
}

export function Segment({ active, className, children, ...rest }: SegmentProps) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        'rounded-[5px] px-2 py-0.5 text-[12px] font-medium transition-colors duration-100',
        active ? 'bg-accent-soft text-accent' : 'text-text-muted hover:text-text',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
