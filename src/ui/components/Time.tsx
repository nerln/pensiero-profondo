import { useEffect, useState } from 'react';
import { formatAbsoluteLocal, formatRelativeTime, formatUtc } from '../utils.js';

/** A relative time ("3m ago") that keeps itself fresh; hover shows the absolute local time. */
export function RelativeTime({ iso }: { iso: string }): JSX.Element {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 15_000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <time className="time" dateTime={iso} title={formatAbsoluteLocal(iso)}>
      {formatRelativeTime(iso)}
    </time>
  );
}

/** Absolute local time; hover shows the UTC equivalent, per the Board spec. */
export function AbsoluteTime({ iso }: { iso: string }): JSX.Element {
  return (
    <time className="time" dateTime={iso} title={formatUtc(iso)}>
      {formatAbsoluteLocal(iso)}
    </time>
  );
}
