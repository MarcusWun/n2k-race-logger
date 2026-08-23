/** Shared wind-angle helpers for display/analysis-derived values.
 * Raw PGN storage remains untouched; use these only when reconstructing or
 * deriving values for UI, charts, exports, polar/performance calculations.
 *
 * Also exports circular-statistics helpers (PRD §3.3 — P0):
 *   shortestAngularDiff, circularMean, circularDispersion
 */
export type WindSide = 'port' | 'starboard' | 'centerline';

export interface NormalizedWindAngle {
  /** Magnitude relative to bow, normalized to 0..180 degrees. */
  angle: number;
  /** Side context for display/export (port for raw angles > 180). */
  side: WindSide;
  /** Convenience signed representation: port negative, starboard positive. */
  signedAngle: number;
}

export function normalizeDegrees360(angleDeg: number): number {
  if (!Number.isFinite(angleDeg)) return angleDeg;
  return ((angleDeg % 360) + 360) % 360;
}

export function normalizeWindAngle(angleDeg: number): NormalizedWindAngle {
  const wrapped = normalizeDegrees360(angleDeg);
  if (!Number.isFinite(wrapped)) {
    return { angle: wrapped, side: 'centerline', signedAngle: wrapped };
  }

  if (wrapped === 0 || wrapped === 180) {
    return { angle: wrapped, side: 'centerline', signedAngle: wrapped };
  }

  if (wrapped > 180) {
    const angle = 360 - wrapped;
    return { angle, side: 'port', signedAngle: -angle };
  }

  return { angle: wrapped, side: 'starboard', signedAngle: wrapped };
}

export function normalizeWindAngleValue(angleDeg: number | null | undefined): number | null {
  if (angleDeg == null) return null;
  const numeric = Number(angleDeg);
  if (!Number.isFinite(numeric)) return null;
  return normalizeWindAngle(numeric).angle;
}

export function windSideValue(angleDeg: number | null | undefined): WindSide | null {
  if (angleDeg == null) return null;
  const numeric = Number(angleDeg);
  if (!Number.isFinite(numeric)) return null;
  return normalizeWindAngle(numeric).side;
}

// ---------------------------------------------------------------------------
// Circular statistics — PRD §3.3 (P0)
//
// All functions accept angles in degrees.  They work correctly with both
// 0..360° and signed −180..180° conventions (the signed TWA representation
// used by the analysis engine).  Math.atan2 returns in [−π, π] so
// circularMean also returns in [−180°, 180°], matching the TWA convention.
// ---------------------------------------------------------------------------

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/**
 * Shortest signed angular difference from `a` to `b` (degrees).
 * Result is in [−180, 180]: positive = clockwise, negative = counter-clockwise.
 *
 * Correctly handles the ±180° boundary, e.g.
 *   shortestAngularDiff(179, -179) → -2   (2° counter-clockwise)
 *   shortestAngularDiff(-179, 179) →  2   (2° clockwise)
 */
export function shortestAngularDiff(a: number, b: number): number {
  let diff = ((b - a) % 360 + 360) % 360;
  if (diff > 180) diff -= 360;
  return diff;
}

/**
 * Circular (angular) mean of an array of angles in degrees.
 * Uses the unit-vector / atan2 method so it handles the ±180° wrap correctly.
 * Returns 0 for an empty array.
 *
 * The return value is in [−180°, 180°] (matching signed TWA convention).
 *
 * Example: circularMean([170, -170]) ≈ ±180°  (NOT 0°)
 */
export function circularMean(angles: number[]): number {
  if (angles.length === 0) return 0;
  let sumSin = 0;
  let sumCos = 0;
  for (const a of angles) {
    const rad = a * DEG_TO_RAD;
    sumSin += Math.sin(rad);
    sumCos += Math.cos(rad);
  }
  return Math.atan2(sumSin, sumCos) * RAD_TO_DEG;
}

/**
 * Circular dispersion (concentration complement) of an array of angles.
 * Returns 1 − R where R is the mean resultant length (0..1).
 *   0 → all angles are identical (perfectly concentrated)
 *   1 → angles are maximally dispersed (uniform distribution)
 *
 * Returns 0 for arrays with fewer than 2 elements.
 */
export function circularDispersion(angles: number[]): number {
  if (angles.length < 2) return 0;
  let sumSin = 0;
  let sumCos = 0;
  for (const a of angles) {
    const rad = a * DEG_TO_RAD;
    sumSin += Math.sin(rad);
    sumCos += Math.cos(rad);
  }
  const n = angles.length;
  const R = Math.sqrt(sumSin * sumSin + sumCos * sumCos) / n;
  return 1 - R;
}
