/** Shared wind-angle helpers for display/analysis-derived values.
 * Raw PGN storage remains untouched; use these only when reconstructing or
 * deriving values for UI, charts, exports, polar/performance calculations.
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
