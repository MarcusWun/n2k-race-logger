import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PolarEngine, PolarTable } from './polar-engine';

// Test polar table: simple 3×3 grid for predictable interpolation
const TEST_POLAR: PolarTable = {
  tws: [6, 10, 14],
  twa: [40, 60, 80],
  speeds: [
    // TWS=6
    [2.0, 3.0, 3.5],
    // TWS=10
    [3.5, 5.0, 5.5],
    // TWS=14
    [5.0, 7.0, 7.5],
  ],
};

// ===================================================================
// Test: Polar file parsing (.pol and .csv)
// ===================================================================
describe('Polar file parsing', () => {
  let engine: PolarEngine;

  beforeEach(() => {
    engine = new PolarEngine();
  });

  it('parses a .pol file into a PolarTable', () => {
    const polContent = `6\t10\t14
40\t2.0\t3.5\t5.0
60\t3.0\t5.0\t7.0
80\t3.5\t5.5\t7.5
`;
    const table = engine.parsePolContent(polContent);
    expect(table).not.toBeNull();
    expect(table!.tws).toEqual([6, 10, 14]);
    expect(table!.twa).toEqual([40, 60, 80]);
    expect(table!.speeds[0]).toEqual([2.0, 3.5, 5.0]);
    expect(table!.speeds[1]).toEqual([3.0, 5.0, 7.0]);
    expect(table!.speeds[2]).toEqual([3.5, 5.5, 7.5]);
  });

  it('parses a CSV file into a PolarTable', () => {
    const csvContent = `TWA,6,10,14
40,2.0,3.5,5.0
60,3.0,5.0,7.0
80,3.5,5.5,7.5
`;
    const table = engine.parseCsvContent(csvContent);
    expect(table).not.toBeNull();
    expect(table!.tws).toEqual([6, 10, 14]);
    expect(table!.twa).toEqual([40, 60, 80]);
    expect(table!.speeds[0]).toEqual([2.0, 3.5, 5.0]);
  });

  it('returns null for empty .pol content', () => {
    expect(engine.parsePolContent('')).toBeNull();
  });

  it('returns null for empty CSV content', () => {
    expect(engine.parseCsvContent('')).toBeNull();
  });
});

// ===================================================================
// Test: TWS interpolation (TWS=9 between 8 and 10)
// ===================================================================
describe('TWS interpolation', () => {
  let engine: PolarEngine;

  beforeEach(() => {
    engine = new PolarEngine();
  });

  // Use a table where TWS=8 and TWS=10 bracket TWS=9
  const INTERP_TABLE: PolarTable = {
    tws: [6, 8, 10, 12],
    twa: [40, 50, 60, 90],
    speeds: [
      // TWS=6
      [1.5, 2.0, 2.5, 2.0],
      // TWS=8
      [2.0, 3.0, 3.5, 3.0],
      // TWS=10
      [2.5, 4.0, 4.5, 3.5],
      // TWS=12
      [3.0, 5.0, 5.5, 4.0],
    ],
  };

  it('interpolates TWS=9 (between 8 and 10) at exact TWA=50', () => {
    // TWS=9 is midway between 8 and 10
    // At TWA=50: speed at TWS=8 is 3.0, speed at TWS=10 is 4.0
    // Interpolated: (3.0 + 4.0) / 2 = 3.5
    const speed = engine.interpolateSpeed(INTERP_TABLE, 9, 50);
    expect(speed).toBeCloseTo(3.5, 1);
  });

  it('interpolates TWS=9 at exact TWA=60', () => {
    // At TWA=60: speed at TWS=8 is 3.5, speed at TWS=10 is 4.5
    // Interpolated: (3.5 + 4.5) / 2 = 4.0
    const speed = engine.interpolateSpeed(INTERP_TABLE, 9, 60);
    expect(speed).toBeCloseTo(4.0, 1);
  });

  it('returns exact value when TWS matches a table entry', () => {
    const speed = engine.interpolateSpeed(INTERP_TABLE, 8, 50);
    expect(speed).toBe(3.0);
  });
});

// ===================================================================
// Test: TWA interpolation (TWA=47 between 45 and 52)
// ===================================================================
describe('TWA interpolation', () => {
  let engine: PolarEngine;

  beforeEach(() => {
    engine = new PolarEngine();
  });

  // Table with TWA=45 and TWA=52 bracketing TWA=47
  const TWA_INTERP_TABLE: PolarTable = {
    tws: [6, 10],
    twa: [40, 45, 52, 60],
    speeds: [
      // TWS=6
      [1.5, 2.0, 2.5, 2.8],
      // TWS=10
      [2.5, 3.5, 4.2, 4.5],
    ],
  };

  it('interpolates TWA=47 (between 45 and 52) at exact TWS=6', () => {
    // TWA=47 is 2/7 of the way from 45 to 52
    // At TWS=6: speed at TWA=45 is 2.0, speed at TWA=52 is 2.5
    // Interpolated: 2.0 + (2/7) * (2.5 - 2.0) = 2.0 + 0.142857 = 2.142857
    const speed = engine.interpolateSpeed(TWA_INTERP_TABLE, 6, 47);
    expect(speed).toBeCloseTo(2.14, 1);
  });

  it('interpolates TWA=47 at exact TWS=10', () => {
    // At TWS=10: speed at TWA=45 is 3.5, speed at TWA=52 is 4.2
    // Interpolated: 3.5 + (2/7) * (4.2 - 3.5) = 3.5 + 0.2 = 3.7
    const speed = engine.interpolateSpeed(TWA_INTERP_TABLE, 10, 47);
    expect(speed).toBeCloseTo(3.7, 1);
  });
});

// ===================================================================
// Test: % of polar computation
// ===================================================================
describe('% of polar', () => {
  let engine: PolarEngine;

  beforeEach(() => {
    engine = new PolarEngine();
  });

  it('computes % of polar correctly', () => {
    // Target speed at TWS=10, TWA=60 is 5.0
    // Actual STW = 4.5 → 4.5/5.0 * 100 = 90%
    const result = engine.computePerformance(TEST_POLAR, 10, 60, 4.5);
    expect(result.percentPolar).toBe(90);
    expect(result.targetSpeed).toBe(5.0);
    expect(result.actualSpeed).toBe(4.5);
  });

  it('computes 100% when at polar', () => {
    const result = engine.computePerformance(TEST_POLAR, 10, 60, 5.0);
    expect(result.percentPolar).toBe(100);
  });

  it('computes >100% when exceeding polar', () => {
    const result = engine.computePerformance(TEST_POLAR, 10, 60, 6.0);
    expect(result.percentPolar).toBe(120);
  });
});

// ===================================================================
// Test: Edge cases — missing wind data, TWA out of range
// ===================================================================
describe('Polar edge cases', () => {
  let engine: PolarEngine;

  beforeEach(() => {
    engine = new PolarEngine();
  });

  it('returns null when wind data is missing (tws=null)', () => {
    const result = engine.computePerformance(TEST_POLAR, null, 60, 5.0);
    expect(result.percentPolar).toBeNull();
    expect(result.targetSpeed).toBeNull();
  });

  it('returns null when wind data is missing (twa=null)', () => {
    const result = engine.computePerformance(TEST_POLAR, 10, null, 5.0);
    expect(result.percentPolar).toBeNull();
  });

  it('returns null when STW is missing', () => {
    const result = engine.computePerformance(TEST_POLAR, 10, 60, null);
    expect(result.percentPolar).toBeNull();
  });

  it('returns null when TWA is outside polar range (too low)', () => {
    const speed = engine.interpolateSpeed(TEST_POLAR, 10, 20);
    expect(speed).toBeNull();
  });

  it('returns null when TWA is outside polar range (too high)', () => {
    const speed = engine.interpolateSpeed(TEST_POLAR, 10, 200);
    expect(speed).toBeNull();
  });

  it('returns null when TWS is outside polar range (too low)', () => {
    const speed = engine.interpolateSpeed(TEST_POLAR, 2, 60);
    expect(speed).toBeNull();
  });

  it('returns null when TWS is outside polar range (too high)', () => {
    const speed = engine.interpolateSpeed(TEST_POLAR, 20, 60);
    expect(speed).toBeNull();
  });

  it('returns null for NaN inputs', () => {
    const speed = engine.interpolateSpeed(TEST_POLAR, NaN, 60);
    expect(speed).toBeNull();
  });
});

// ===================================================================
// Test: Bilinear interpolation (both TWS and TWA between grid points)
// ===================================================================
describe('Bilinear interpolation', () => {
  let engine: PolarEngine;

  beforeEach(() => {
    engine = new PolarEngine();
  });

  it('interpolates both TWS and TWA simultaneously', () => {
    // TEST_POLAR: tws=[6,10,14], twa=[40,60,80]
    // TWS=8 (between 6 and 10), TWA=50 (between 40 and 60)
    // v00=2.0 (TWS=6, TWA=40), v01=3.0 (TWS=6, TWA=60)
    // v10=3.5 (TWS=10, TWA=40), v11=5.0 (TWS=10, TWA=60)
    // tTWS = (8-6)/(10-6) = 0.5
    // tTWA = (50-40)/(60-40) = 0.5
    // edge0 = 2.0*0.5 + 3.0*0.5 = 2.5
    // edge1 = 3.5*0.5 + 5.0*0.5 = 4.25
    // result = 2.5*0.5 + 4.25*0.5 = 3.375
    const speed = engine.interpolateSpeed(TEST_POLAR, 8, 50);
    expect(speed).toBeCloseTo(3.375, 2);
  });
});
