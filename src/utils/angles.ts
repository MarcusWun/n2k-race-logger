export interface NormalizedWindAngle {
  angle: number;
  side: 'P' | 'S';
}

/** Normalize relative wind angles from raw 0–360° into sailing display convention: 0–180° + port/starboard. */
export function normalizeWindAngle(value: number): NormalizedWindAngle {
  const wrapped = ((value % 360) + 360) % 360;
  if (wrapped > 180) {
    return { angle: 360 - wrapped, side: 'P' };
  }
  return { angle: wrapped, side: 'S' };
}

export function normalizedWindAngleValue(value: number): number {
  return normalizeWindAngle(value).angle;
}

export function formatWindAngle(value: number, precision = 0): string {
  const { angle, side } = normalizeWindAngle(value);
  return `${angle.toFixed(precision)}°${side}`;
}
