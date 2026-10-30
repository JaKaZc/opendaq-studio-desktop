import { useEffect, useRef, useState } from 'react';

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * A number that moves to its new value instead of jumping.
 *
 * A change you can see happen is a change you notice: a channel count going
 * from 4 to 6 as a device connects reads as an event, where a digit silently
 * replaced does not. The tween is short and eases out, so a number that
 * changes often still reads as current rather than lagging.
 *
 * The text is written straight to the DOM on each frame - the same technique as
 * the device clock - so a tween never re-renders the page around it. Under
 * reduced motion it simply shows the value.
 */
export function AnimatedNumber({
  value,
  format,
  duration = 700,
  countUp = true,
  className,
}: {
  value: number;
  format: (value: number) => string;
  duration?: number;
  /** Count up from zero on first appearance, the way a page assembling reads. */
  countUp?: boolean;
  className?: string;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const [initial] = useState(() => (countUp && !prefersReducedMotion() ? 0 : value));
  const shown = useRef(initial);
  // The formatter is usually an inline arrow, new on every render; holding it in
  // a ref keeps a re-render from restarting a tween that is under way.
  const formatRef = useRef(format);
  useEffect(() => {
    formatRef.current = format;
  });

  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const from = shown.current;
    const to = value;
    if (!Number.isFinite(to) || !Number.isFinite(from) || from === to || prefersReducedMotion()) {
      shown.current = to;
      node.textContent = formatRef.current(to);
      return;
    }
    let frame = 0;
    const started = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - started) / duration);
      const eased = 1 - (1 - progress) ** 3;
      shown.current = from + (to - from) * eased;
      node.textContent = formatRef.current(progress === 1 ? to : shown.current);
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);

  return (
    <span ref={element} className={className}>
      {format(initial)}
    </span>
  );
}
