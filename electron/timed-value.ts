/**
 * TimedValue — a value annotated with the ms-epoch timestamp at which it was
 * last observed.  Used by the analysis engine to enforce freshness limits so
 * that stale cached values cannot silently substitute for real sensor data.
 *
 * PRD §3.2 — Historical-Value Freshness Limits (P0)
 */

export interface TimedValue {
  value: number;
  /** Unix time in milliseconds when this value was last observed. */
  timestamp: number;
}

/**
 * Returns true if `tv` exists and its timestamp is within `maxAgeMs` of `now`.
 */
export function isFresh(
  tv: TimedValue | null | undefined,
  now: number,
  maxAgeMs: number,
): boolean {
  if (!tv) return false;
  return now - tv.timestamp <= maxAgeMs;
}

/**
 * Returns the value if fresh, otherwise null.
 * A drop-in replacement for the old `lastX ?? null` pattern where
 * `lastX` is now a `TimedValue`.
 */
export function getFreshValue(
  tv: TimedValue | null | undefined,
  now: number,
  maxAgeMs: number,
): number | null {
  return isFresh(tv, now, maxAgeMs) ? tv!.value : null;
}
