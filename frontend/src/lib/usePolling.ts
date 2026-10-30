import { useEffect, useRef } from 'react';

/**
 * Repeatedly run an async task, with the visibility rules a measurement UI wants.
 *
 * Three behaviours that are easy to get subtly wrong, so they live in one place:
 *
 * - **The first run always happens.**  Skipping it when the document reports
 *   itself hidden - which some embedded webviews and headless contexts do even
 *   while visible - leaves the panel showing "—" forever.
 * - **Background tabs stop polling.**  There is no point asking a device for its
 *   values while nobody is looking, and `last_value` reads cost the device real
 *   work.
 * - **Becoming visible resumes immediately**, rather than after up to one full
 *   interval of stale numbers.
 *
 * The task receives an `AbortSignal` that fires when the effect is torn down, so
 * in-flight requests are cancelled on unmount and on a dependency change.
 */
export function usePolling(
  task: (signal: AbortSignal) => Promise<void>,
  intervalMs: number,
  dependencies: readonly unknown[],
  options: { pauseWhenHidden?: boolean; enabled?: boolean } = {},
): void {
  const { pauseWhenHidden = true, enabled = true } = options;

  // The latest task is kept in a ref so changing the closure does not restart the
  // timer, but the write happens in an effect: mutating a ref during render can
  // leave a concurrent render reading a value the committed tree never saw.
  const taskRef = useRef(task);
  useEffect(() => {
    taskRef.current = task;
  });

  useEffect(() => {
    if (!enabled) return;

    const controller = new AbortController();
    let cancelled = false;
    let timer: number | null = null;
    let running = false;

    const schedule = () => {
      if (cancelled || intervalMs <= 0) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => void run(false), intervalMs);
    };

    const run = async (isFirst: boolean) => {
      if (cancelled || running) return;
      // Skip the work while hidden, but never the very first run.
      if (!isFirst && pauseWhenHidden && document.hidden) {
        schedule();
        return;
      }
      running = true;
      try {
        await taskRef.current(controller.signal);
      } catch {
        // The caller decides how to surface failures; a rejected poll must not
        // stop the loop, or one network blip would freeze the panel for good.
      } finally {
        running = false;
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (!document.hidden) void run(false);
    };

    void run(true);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      cancelled = true;
      controller.abort();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (timer !== null) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, intervalMs, pauseWhenHidden, ...dependencies]);
}
