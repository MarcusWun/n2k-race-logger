/**
 * Unit tests for electron/spline.ts
 * Covers PCHIP and Akima interpolation algorithms.
 */

import { describe, it, expect } from 'vitest';
import { pchip, akima } from './spline';

// Helper: linear-lerp reference
function lerp(xs: number[], ys: number[], x: number): number {
  for (let i = 0; i < xs.length - 1; i++) {
    if (xs[i] <= x && x <= xs[i + 1]) {
      const t = (x - xs[i]) / (xs[i + 1] - xs[i]);
      return ys[i] * (1 - t) + ys[i + 1] * t;
    }
  }
  if (x <= xs[0]) return ys[0];
  return ys[ys.length - 1];
}

// ===================================================================
// Precondition: monotone-ascending xs
// ===================================================================
describe('pchip preconditions', () => {
  it('throws when xs is not strictly ascending (duplicate)', () => {
    expect(() => pchip([1, 1, 2], [0, 1, 2])).toThrow(/strictly monotone ascending/i);
  });

  it('throws when xs is not strictly ascending (descending)', () => {
    expect(() => pchip([3, 2, 1], [0, 1, 2])).toThrow(/strictly monotone ascending/i);
  });

  it('throws when xs and ys have different lengths', () => {
    expect(() => pchip([1, 2, 3], [0, 1])).toThrow(/same length/i);
  });

  it('throws when xs.length < 2', () => {
    expect(() => pchip([1], [0])).toThrow(/at least 2/i);
  });

  it('throws for empty arrays', () => {
    expect(() => pchip([], [])).toThrow(/at least 2/i);
  });
});

describe('akima preconditions', () => {
  it('throws when xs is not strictly ascending (duplicate)', () => {
    expect(() => akima([1, 1, 2], [0, 1, 2])).toThrow(/strictly monotone ascending/i);
  });

  it('throws when xs is not strictly ascending (descending)', () => {
    expect(() => akima([3, 2, 1], [0, 1, 2])).toThrow(/strictly monotone ascending/i);
  });

  it('throws when xs and ys have different lengths', () => {
    expect(() => akima([1, 2, 3], [0, 1])).toThrow(/same length/i);
  });

  it('throws when xs.length < 2', () => {
    expect(() => akima([1], [0])).toThrow(/at least 2/i);
  });

  it('throws for empty arrays', () => {
    expect(() => akima([], [])).toThrow(/at least 2/i);
  });
});

// ===================================================================
// Exact knot hit: evaluate(xs[i]) must return ys[i]
// ===================================================================
describe('exact knot values', () => {
  const xs = [0, 1, 3, 6, 10];
  const ys = [0, 2, 5, 3, 7];

  it('pchip: returns y[i] at each knot', () => {
    const fn = pchip(xs, ys);
    xs.forEach((x, i) => {
      expect(fn(x)).toBeCloseTo(ys[i], 10);
    });
  });

  it('akima: returns y[i] at each knot', () => {
    const fn = akima(xs, ys);
    xs.forEach((x, i) => {
      expect(fn(x)).toBeCloseTo(ys[i], 10);
    });
  });
});

// ===================================================================
// Clamping: outside boundary returns boundary y-value
// ===================================================================
describe('boundary clamping', () => {
  const xs = [2, 4, 6];
  const ys = [10, 20, 15];

  it('pchip: clamps below xs[0]', () => {
    const fn = pchip(xs, ys);
    expect(fn(0)).toBe(10);
    expect(fn(-100)).toBe(10);
    expect(fn(2)).toBe(10); // exact left boundary
  });

  it('pchip: clamps above xs[last]', () => {
    const fn = pchip(xs, ys);
    expect(fn(6)).toBe(15); // exact right boundary
    expect(fn(7)).toBe(15);
    expect(fn(1000)).toBe(15);
  });

  it('akima: clamps below xs[0]', () => {
    const fn = akima(xs, ys);
    expect(fn(0)).toBe(10);
    expect(fn(-100)).toBe(10);
    expect(fn(2)).toBe(10);
  });

  it('akima: clamps above xs[last]', () => {
    const fn = akima(xs, ys);
    expect(fn(6)).toBe(15);
    expect(fn(7)).toBe(15);
    expect(fn(1000)).toBe(15);
  });
});

// ===================================================================
// Minimal dataset (n=2): must not throw; linear behaviour
// ===================================================================
describe('two-point (n=2) dataset', () => {
  const xs = [0, 1];
  const ys = [0, 3];

  it('pchip: does not throw and evaluates midpoint linearly', () => {
    const fn = pchip(xs, ys);
    expect(fn(0.5)).toBeCloseTo(1.5, 10);
  });

  it('akima: does not throw and evaluates midpoint linearly', () => {
    const fn = akima(xs, ys);
    expect(fn(0.5)).toBeCloseTo(1.5, 10);
  });
});

// ===================================================================
// Monotone dataset: PCHIP must produce monotone output between knots
// ===================================================================
describe('monotone dataset', () => {
  // Monotone increasing data: BSP ramps from 0 at dead-upwind to 6 at VMG
  const xs = [0, 10, 20, 30, 40];
  const ys = [0, 1.5, 3, 5, 6];

  it('pchip: output is monotone between knots', () => {
    const fn = pchip(xs, ys);
    let prev = fn(0);
    for (let x = 1; x <= 40; x++) {
      const cur = fn(x);
      expect(cur).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = cur;
    }
  });

  it('akima: output does not wildly overshoot (max < 2× data range)', () => {
    const fn = akima(xs, ys);
    const dataMin = Math.min(...ys);
    const dataMax = Math.max(...ys);
    const margin = (dataMax - dataMin) * 0.5;
    for (let x = 0; x <= 40; x += 0.5) {
      const cur = fn(x);
      expect(cur).toBeGreaterThan(dataMin - margin);
      expect(cur).toBeLessThan(dataMax + margin);
    }
  });
});

// ===================================================================
// Linearity check: y=x at midpoints returns the midpoint
// ===================================================================
describe('linearity: y = x', () => {
  const xs = [0, 1, 2, 3, 4, 5];
  const ys = xs.slice(); // y = x

  it('pchip: midpoints return exact midpoint value', () => {
    const fn = pchip(xs, ys);
    expect(fn(0.5)).toBeCloseTo(0.5, 8);
    expect(fn(2.5)).toBeCloseTo(2.5, 8);
    expect(fn(4.0)).toBeCloseTo(4.0, 8);
  });

  it('akima: midpoints return exact midpoint value', () => {
    const fn = akima(xs, ys);
    expect(fn(0.5)).toBeCloseTo(0.5, 8);
    expect(fn(2.5)).toBeCloseTo(2.5, 8);
    expect(fn(4.0)).toBeCloseTo(4.0, 8);
  });
});

// ===================================================================
// Convexity check: y=x^2 at [0,1,2,3,4], evaluate at x=0.5
// True value: 0.25; linear lerp between (0,0) and (1,1): 0.5
// Both algorithms should give a value closer to 0.25 than to 0.5
// ===================================================================
describe('convexity: y = x^2', () => {
  const xs = [0, 1, 2, 3, 4];
  const ys = xs.map((x) => x * x); // [0, 1, 4, 9, 16]

  it('pchip: at x=0.5 is closer to 0.25 than to linear-lerp 0.5', () => {
    const fn = pchip(xs, ys);
    const val = fn(0.5);
    const errToTruth = Math.abs(val - 0.25);
    const errToLinear = Math.abs(val - 0.5);
    // Must be closer to 0.25 than to 0.5
    expect(errToTruth).toBeLessThan(errToLinear);
  });

  it('akima: at x=0.5 is closer to 0.25 than to linear-lerp 0.5', () => {
    const fn = akima(xs, ys);
    const val = fn(0.5);
    const errToTruth = Math.abs(val - 0.25);
    const errToLinear = Math.abs(val - 0.5);
    expect(errToTruth).toBeLessThan(errToLinear);
  });
});

// ===================================================================
// Non-monotone dataset: sanity check (no crash, reasonable output)
// ===================================================================
describe('non-monotone dataset (peak then valley)', () => {
  const xs = [0, 1, 2, 3, 4];
  const ys = [0, 3, 5, 2, 4];

  it('pchip: evaluates without error', () => {
    const fn = pchip(xs, ys);
    expect(() => { for (let x = 0; x <= 4; x += 0.1) fn(x); }).not.toThrow();
  });

  it('akima: evaluates without error', () => {
    const fn = akima(xs, ys);
    expect(() => { for (let x = 0; x <= 4; x += 0.1) fn(x); }).not.toThrow();
  });
});
