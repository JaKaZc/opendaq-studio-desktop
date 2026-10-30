import { useEffect, useState } from 'react';

/**
 * A value that settles only after the user stops changing it.
 *
 * Used for inputs whose change triggers real work on the backend - the
 * connection-string field runs a discovery match on every keystroke otherwise.
 * Returning a *value* rather than a callback keeps the consuming effect purely
 * derived, so nothing has to be reset imperatively when the input is cleared.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);

  useEffect(() => {
    if (Object.is(settled, value)) return;
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs, settled]);

  return settled;
}
