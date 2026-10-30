import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { forwardRef, useId } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';

const CONTROL =
  'w-full rounded-[var(--radius-control)] border border-border-strong bg-panel px-2 text-text ' +
  'placeholder:text-text-faint disabled:cursor-not-allowed disabled:opacity-60 ' +
  'read-only:bg-sunken transition-colors duration-100';

const SIZES = { sm: 'h-6.5 text-[12px]', md: 'h-8 text-[13px]' } as const;

export function Label({
  htmlFor,
  children,
  hint,
  required,
  className,
}: {
  htmlFor?: string;
  children: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  className?: string;
}) {
  return (
    <label htmlFor={htmlFor} className={cn('block text-[11.5px] font-medium text-text-muted', className)}>
      {children}
      {required ? <span className="ml-0.5 text-err">*</span> : null}
      {hint ? <span className="ml-1.5 font-normal text-text-faint">{hint}</span> : null}
    </label>
  );
}

/** Label + control + error message, so forms line up without ad-hoc markup. */
export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {label ? (
        <Label hint={hint} required={required}>
          {label}
        </Label>
      ) : null}
      {children}
      {error ? <p className="text-[11.5px] text-err">{error}</p> : null}
    </div>
  );
}

// The HTML `size` attribute means "visible character count", which is not what
// these controls need; ours selects the control height, so the DOM one is omitted.
interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: 'sm' | 'md';
  mono?: boolean;
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { size = 'md', mono, invalid, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        CONTROL,
        SIZES[size],
        mono && 'font-mono tabular',
        invalid && 'border-err',
        className,
      )}
      {...rest}
    />
  );
});

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  mono?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { mono, className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={cn(CONTROL, 'py-1.5 text-[12.5px] leading-relaxed', mono && 'font-mono', className)}
      {...rest}
    />
  );
});

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: 'sm' | 'md';
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { size = 'md', className, children, ...rest },
  ref,
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        className={cn(CONTROL, SIZES[size], 'cursor-pointer appearance-none pr-7', className)}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown
        size={13}
        aria-hidden
        className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-text-faint"
      />
    </div>
  );
});

export function Checkbox({
  checked,
  onChange,
  label,
  hint,
  disabled,
  className,
  indeterminate,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
  indeterminate?: boolean;
}) {
  const id = useId();
  return (
    <div className={cn('flex items-start gap-2', className)}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        ref={(element) => {
          if (element) element.indeterminate = Boolean(indeterminate) && !checked;
        }}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-3.5 shrink-0 cursor-pointer accent-[var(--color-brand)] disabled:cursor-not-allowed disabled:opacity-50"
      />
      {label ? (
        <label
          htmlFor={id}
          className={cn(
            'cursor-pointer text-[12.5px] leading-snug select-none',
            disabled && 'cursor-not-allowed opacity-60',
          )}
        >
          {label}
          {hint ? <span className="ml-1.5 text-[11.5px] text-text-faint">{hint}</span> : null}
        </label>
      ) : null}
    </div>
  );
}

/** A switch for settings that take effect immediately. */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-150',
        checked ? 'bg-brand' : 'bg-border-strong',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <span
        className={cn(
          'absolute size-3 rounded-full bg-white shadow-sm transition-transform duration-150',
          checked ? 'translate-x-3.5' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}

/**
 * A numeric input that only commits on blur or Enter.
 *
 * Committing per keystroke would send a property write for every digit typed,
 * which a device sees as a burst of nonsense values (`1`, `12`, `123` on the way
 * to `1234`).
 */
export function CommitInput({
  value,
  onCommit,
  size = 'sm',
  mono = true,
  disabled,
  placeholder,
  className,
  align = 'right',
  ariaLabel,
  selectOnFocus = true,
}: {
  value: string;
  onCommit: (next: string) => void;
  size?: 'sm' | 'md';
  mono?: boolean;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  align?: 'left' | 'right';
  ariaLabel?: string;
  selectOnFocus?: boolean;
}) {
  return (
    <input
      key={value}
      defaultValue={value}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onFocus={selectOnFocus ? (event) => event.currentTarget.select() : undefined}
      onBlur={(event) => {
        if (event.currentTarget.value !== value) onCommit(event.currentTarget.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.currentTarget.value = value;
          event.currentTarget.blur();
        }
      }}
      className={cn(
        CONTROL,
        SIZES[size],
        mono && 'font-mono tabular',
        align === 'right' && 'text-right',
        className,
      )}
    />
  );
}
