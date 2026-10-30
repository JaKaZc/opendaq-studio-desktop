import { useCallback, useEffect, useReducer } from 'react';
import { ApiError } from './api';

interface State<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Bumped by `reload()` to re-run the loader. */
  nonce: number;
}

type Action<T> =
  | { type: 'start' }
  | { type: 'success'; data: T }
  | { type: 'failure'; error: string }
  | { type: 'reload' };

function reducer<T>(state: State<T>, action: Action<T>): State<T> {
  switch (action.type) {
    case 'start':
      return { ...state, loading: true };
    case 'success':
      return { data: action.data, error: null, loading: false, nonce: state.nonce };
    case 'failure':
      return { ...state, error: action.error, loading: false };
    case 'reload':
      return { ...state, nonce: state.nonce + 1 };
  }
}

/**
 * Load data for the lifetime of a component, with cancellation.
 *
 * Every panel in this app follows the same shape - fetch on mount, refetch when
 * something changes, abort the in-flight request on unmount, keep the last good
 * data on a transient failure - and writing that out eight times invites eight
 * slightly different bugs. A reducer is used rather than several `useState`
 * calls so a single dispatch moves loading, data and error together, which is
 * also what keeps the effect free of the cascading renders React warns about.
 */
export function useAsyncData<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  dependencies: readonly unknown[],
  options: { enabled?: boolean; onError?: (error: unknown) => void } = {},
): {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
  setData: (data: T) => void;
} {
  const { enabled = true, onError } = options;
  const [state, dispatch] = useReducer(reducer<T>, {
    data: null,
    error: null,
    loading: enabled,
    nonce: 0,
  });

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let cancelled = false;

    dispatch({ type: 'start' });
    loader(controller.signal)
      .then((data) => {
        if (!cancelled) dispatch({ type: 'success', data });
      })
      .catch((cause: unknown) => {
        // An abort is the expected outcome of unmounting, not a failure.
        if (cancelled || (cause instanceof DOMException && cause.name === 'AbortError')) return;
        const message = cause instanceof ApiError ? cause.summary : String(cause);
        dispatch({ type: 'failure', error: message });
        onError?.(cause);
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
    // The loader closes over its own inputs; `dependencies` says when to re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, state.nonce, ...dependencies]);

  const reload = useCallback(() => dispatch({ type: 'reload' }), []);
  const setData = useCallback((data: T) => dispatch({ type: 'success', data }), []);

  return { data: state.data, error: state.error, loading: state.loading, reload, setData };
}
