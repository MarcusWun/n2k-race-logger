/**
 * 1-D spline interpolation module — shared between main process and renderer.
 *
 * Exports:
 *   pchip  — Piecewise Cubic Hermite Interpolating Polynomial (Fritsch–Carlson)
 *   akima  — Akima 1970 piecewise cubic spline
 *
 * Both functions:
 *  - Require xs strictly monotone ascending; throw otherwise.
 *  - Require xs.length === ys.length and xs.length >= 2; throw otherwise.
 *  - Clamp to boundary y-value for x outside [xs[0], xs[last]] (no extrapolation).
 *  - Precompute per-interval coefficients once; binary-search interval on each call.
 */

/** Validate inputs shared by both algorithms. */
function validate(xs: number[], ys: number[], label: string): void {
  if (xs.length < 2) {
    throw new Error(`${label}: requires at least 2 knots, got ${xs.length}`);
  }
  if (xs.length !== ys.length) {
    throw new Error(`${label}: xs and ys must have the same length (xs=${xs.length}, ys=${ys.length})`);
  }
  for (let i = 1; i < xs.length; i++) {
    if (xs[i] <= xs[i - 1]) {
      throw new Error(
        `${label}: xs must be strictly monotone ascending; xs[${i - 1}]=${xs[i - 1]} >= xs[${i}]=${xs[i]}`,
      );
    }
  }
}

/** Binary search: return largest k such that xs[k] <= x. Assumes xs[0] < x < xs[n-1]. */
function bisect(xs: number[], x: number): number {
  let lo = 0;
  let hi = xs.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Evaluate cubic Hermite polynomial on interval k. */
function hermite(
  xs: number[],
  ys: number[],
  d: number[],
  h: number[],
  k: number,
  x: number,
): number {
  const t = (x - xs[k]) / h[k];
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * ys[k] + h10 * h[k] * d[k] + h01 * ys[k + 1] + h11 * h[k] * d[k + 1];
}

// ---------------------------------------------------------------------------
// PCHIP — Piecewise Cubic Hermite Interpolating Polynomial (Fritsch–Carlson)
// ---------------------------------------------------------------------------

/**
 * PCHIP interpolation (Fritsch–Carlson 1980 slope-limiting method).
 *
 * Guarantees C1 continuity and local monotonicity: if the data is monotone
 * between two adjacent knots, the interpolant is also monotone there (no
 * overshoot). This makes it ideal for sailing polar curves where negative
 * BSP or overshoot past peak speed would be physically wrong.
 *
 * @param xs  Knot x-positions; must be strictly ascending.
 * @param ys  Knot y-values; must be same length as xs.
 * @returns   Function evaluate(x) → interpolated y.
 */
export function pchip(xs: readonly number[], ys: readonly number[]): (x: number) => number {
  const xsMut = xs as number[];
  const ysMut = ys as number[];
  validate(xsMut, ysMut, 'pchip');

  const n = xsMut.length;

  // Interval widths and secant slopes
  const h: number[] = new Array(n - 1);
  const m: number[] = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) {
    h[i] = xsMut[i + 1] - xsMut[i];
    m[i] = (ysMut[i + 1] - ysMut[i]) / h[i];
  }

  // Derivatives at each knot
  const d: number[] = new Array(n);

  if (n === 2) {
    // Only one interval — linear (both derivatives equal slope)
    d[0] = m[0];
    d[1] = m[0];
  } else {
    // Interior knots: weighted harmonic mean (Fritsch–Carlson)
    for (let i = 1; i < n - 1; i++) {
      if (m[i - 1] * m[i] <= 0) {
        // Sign change or zero — set derivative to 0 to preserve monotonicity
        d[i] = 0;
      } else {
        const w1 = 2 * h[i] + h[i - 1];
        const w2 = h[i] + 2 * h[i - 1];
        d[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i]);
      }
    }

    // Endpoint derivatives: one-sided three-point formula
    d[0] = ((2 * h[0] + h[1]) * m[0] - h[0] * m[1]) / (h[0] + h[1]);
    d[n - 1] =
      ((2 * h[n - 2] + h[n - 3]) * m[n - 2] - h[n - 2] * m[n - 3]) / (h[n - 2] + h[n - 3]);

    // Fritsch–Carlson sign/magnitude limiter for endpoints
    // Left endpoint
    if (Math.sign(d[0]) !== Math.sign(m[0])) {
      d[0] = 0;
    } else if (Math.sign(m[0]) !== Math.sign(m[1]) && Math.abs(d[0]) > 3 * Math.abs(m[0])) {
      d[0] = 3 * m[0];
    }
    // Right endpoint
    if (Math.sign(d[n - 1]) !== Math.sign(m[n - 2])) {
      d[n - 1] = 0;
    } else if (
      Math.sign(m[n - 2]) !== Math.sign(m[n - 3]) &&
      Math.abs(d[n - 1]) > 3 * Math.abs(m[n - 2])
    ) {
      d[n - 1] = 3 * m[n - 2];
    }
  }

  return (x: number): number => {
    if (x <= xsMut[0]) return ysMut[0];
    if (x >= xsMut[n - 1]) return ysMut[n - 1];
    const k = bisect(xsMut, x);
    return hermite(xsMut, ysMut, d, h, k, x);
  };
}

// ---------------------------------------------------------------------------
// Akima — Akima 1970 piecewise cubic spline
// ---------------------------------------------------------------------------

/**
 * Akima interpolation (Akima 1970 algorithm).
 *
 * Computes derivatives at each knot as a weighted average of adjacent finite
 * differences, down-weighting large outliers. More resistant to oscillation
 * than natural cubic splines; does not guarantee monotonicity but avoids the
 * dramatic ringing of Runge's phenomenon.
 *
 * @param xs  Knot x-positions; must be strictly ascending.
 * @param ys  Knot y-values; must be same length as xs.
 * @returns   Function evaluate(x) → interpolated y.
 */
export function akima(xs: readonly number[], ys: readonly number[]): (x: number) => number {
  const xsMut = xs as number[];
  const ysMut = ys as number[];
  validate(xsMut, ysMut, 'akima');

  const n = xsMut.length;
  const ne = n - 1; // number of intervals

  // Interval widths and secant slopes
  const h: number[] = new Array(ne);
  const m: number[] = new Array(ne);
  for (let i = 0; i < ne; i++) {
    h[i] = xsMut[i + 1] - xsMut[i];
    m[i] = (ysMut[i + 1] - ysMut[i]) / h[i];
  }

  // Extended slope array: indices 0..ne+3 correspond to m[-2], m[-1], m[0], ..., m[ne-1], m[ne], m[ne+1]
  // i.e. extM[k+2] = m[k] for k = 0..ne-1
  const extM: number[] = new Array(ne + 4);
  for (let i = 0; i < ne; i++) {
    extM[i + 2] = m[i];
  }

  if (ne === 1) {
    // Only one interval — phantom slopes all equal the single real slope → linear
    extM[0] = m[0];
    extM[1] = m[0];
    extM[3] = m[0];
    extM[4] = m[0];
  } else {
    // Left phantom slopes (Akima 1970 §3)
    extM[1] = 2 * m[0] - m[1];
    extM[0] = 2 * extM[1] - m[0];
    // Right phantom slopes
    extM[ne + 2] = 2 * m[ne - 1] - m[ne - 2];
    extM[ne + 3] = 2 * extM[ne + 2] - m[ne - 1];
  }

  // Derivative at each knot (Akima weighted formula)
  // For knot i, uses extM[i..i+3] which maps to m[i-2], m[i-1], m[i], m[i+1]
  const d: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const mm2 = extM[i];       // m[i-2]
    const mm1 = extM[i + 1];   // m[i-1]
    const mp0 = extM[i + 2];   // m[i]
    const mp1 = extM[i + 3];   // m[i+1]

    const w1 = Math.abs(mp1 - mp0); // |m[i+1] - m[i]|
    const w2 = Math.abs(mm1 - mm2); // |m[i-1] - m[i-2]|

    if (w1 === 0 && w2 === 0) {
      // Tie-breaker: arithmetic mean of adjacent slopes
      d[i] = (mm1 + mp0) / 2;
    } else {
      d[i] = (w1 * mm1 + w2 * mp0) / (w1 + w2);
    }
  }

  return (x: number): number => {
    if (x <= xsMut[0]) return ysMut[0];
    if (x >= xsMut[n - 1]) return ysMut[n - 1];
    const k = bisect(xsMut, x);
    return hermite(xsMut, ysMut, d, h, k, x);
  };
}
