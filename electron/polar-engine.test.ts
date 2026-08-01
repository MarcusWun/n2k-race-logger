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

// ===================================================================
// Test: Expedition .txt polar parsing (Phase 2.5)
// ===================================================================
describe('Expedition polar parsing', () => {
  let engine: PolarEngine;

  beforeEach(() => {
    engine = new PolarEngine();
  });

  // Minimal SF 3300 Stratos-style Expedition polar snippet.
  // Two rows share some TWA values (52, 60, 75, 90) and diverge at the
  // deep-downwind VMG angle (139.7° at 4 kts, 142.85° at 6 kts).
  const EXPEDITION_SAMPLE = `!SF 3300 Stratos test polar
4 0 0 52 3.99 60 4.35 75 4.61 90 4.51 139.7 3.30
6 0 0 52 5.49 60 5.98 75 6.20 90 6.10 142.85 4.85
`;

  it('parses a simple Expedition polar', () => {
    const table = engine.parseExpeditionContent(EXPEDITION_SAMPLE);
    expect(table).not.toBeNull();
    expect(table!.tws).toEqual([4, 6]);
    // Union of TWA across rows, sorted, excluding the (0,0) sentinel
    expect(table!.twa).toEqual([52, 60, 75, 90, 139.7, 142.85]);
  });

  it('preserves exact BSP values at each row\'s known TWA points', () => {
    const table = engine.parseExpeditionContent(EXPEDITION_SAMPLE)!;
    // Row TWS=4 at TWA=52
    const idx52 = table.twa.indexOf(52);
    expect(table.speeds[0][idx52]).toBeCloseTo(3.99, 3);
    // Row TWS=6 at TWA=90
    const idx90 = table.twa.indexOf(90);
    expect(table.speeds[1][idx90]).toBeCloseTo(6.10, 3);
  });

  it('linearly interpolates BSP at TWA values known in the other row', () => {
    const table = engine.parseExpeditionContent(EXPEDITION_SAMPLE)!;
    // Row TWS=4 has no explicit point at TWA=142.85; it lies between
    // known points (139.7, 3.30) and its row max 139.7 — actually 142.85
    // is *outside* the TWS=4 row's range (max=139.7), so it must clamp to 0.
    const idx14285 = table.twa.indexOf(142.85);
    expect(table.speeds[0][idx14285]).toBe(0);

    // Row TWS=6 has no explicit point at TWA=139.7. TWS=6 known TWAs are
    // 52, 60, 75, 90, 142.85. 139.7 lies between 90 (6.10) and 142.85 (4.85).
    // t = (139.7 - 90)/(142.85 - 90) = 49.7/52.85 ≈ 0.94040
    // interp = 6.10 * (1 - 0.94040) + 4.85 * 0.94040 = 0.3635 + 4.5610 = 4.9245
    const idx1397 = table.twa.indexOf(139.7);
    expect(table.speeds[1][idx1397]).toBeCloseTo(4.9245, 1);
    // Within ±0.1 kt of hand-calculated value per PRD acceptance criteria
    expect(Math.abs((table.speeds[1][idx1397] as number) - 4.9245)).toBeLessThan(0.1);
  });

  it('discards the (TWA=0, BSP=0) sentinel from every row', () => {
    const table = engine.parseExpeditionContent(EXPEDITION_SAMPLE)!;
    expect(table.twa).not.toContain(0);
  });

  it('ignores comment lines starting with !', () => {
    const withComments = `!header comment
!another comment line
4 0 0 52 3.99 60 4.35
!inline comment between rows
6 0 0 52 5.49 60 5.98
`;
    const table = engine.parseExpeditionContent(withComments)!;
    expect(table.tws).toEqual([4, 6]);
    expect(table.twa).toEqual([52, 60]);
  });

  it('ignores blank lines', () => {
    const withBlanks = `
4 0 0 52 3.99 60 4.35

6 0 0 52 5.49 60 5.98

`;
    const table = engine.parseExpeditionContent(withBlanks)!;
    expect(table.tws).toEqual([4, 6]);
  });

  it('throws a clear error for malformed lines (odd token count after TWS)', () => {
    // TWS=4 followed by 5 tokens — cannot form pairs
    const malformed = `4 0 0 52 3.99 60`;
    expect(() => engine.parseExpeditionContent(malformed)).toThrow(/expected TWA\/BSP pairs/);
  });

  it('returns null when no valid data rows are present', () => {
    const commentsOnly = `!only comments
!nothing else
`;
    expect(engine.parseExpeditionContent(commentsOnly)).toBeNull();
    expect(engine.parseExpeditionContent('')).toBeNull();
  });

  it('produces a full 9-row polar for a realistic SF 3300 Stratos file (4–24 kts)', () => {
    // Realistic 9-TWS Expedition polar spanning 4..24 kts (step 2 up to 20,
    // then 22, 24). Uses a modest number of TWA points per row so the union
    // covers the whole active range.
    const full = `!SF 3300 Stratos
4  0 0  46.11 3.67  52 3.99  60 4.35  75 4.61  90 4.51  110 4.20  139.7 3.30
6  0 0  43.11 4.95  52 5.49  60 5.98  75 6.20  90 6.10  110 5.60  142.85 4.85
8  0 0  41.00 5.90  52 6.55  60 7.02  75 7.30  90 7.20  110 6.70  145.00 5.90
10 0 0  40.00 6.55  52 7.20  60 7.75  75 8.05  90 7.95  110 7.40  148.00 6.70
12 0 0  39.50 7.05  52 7.65  60 8.30  75 8.65  90 8.55  110 7.95  150.00 7.30
14 0 0  39.00 7.35  52 7.95  60 8.65  75 9.05  90 8.95  110 8.30  152.00 7.75
16 0 0  38.50 7.55  52 8.20  60 8.95  75 9.35  90 9.25  110 8.60  155.00 8.10
20 0 0  38.00 7.85  52 8.55  60 9.35  75 9.75  90 9.75  110 9.05  158.00 8.75
24 0 0  38.00 8.10  52 8.85  60 9.70  75 10.05 90 10.15 110 9.50  160.00 9.25
`;
    const table = engine.parseExpeditionContent(full)!;
    expect(table).not.toBeNull();
    expect(table.tws.length).toBe(9);
    expect(table.tws[0]).toBe(4);
    expect(table.tws[8]).toBe(24);
    // Each row's speeds array must have the same length as the unified TWA axis
    for (const row of table.speeds) {
      expect(row.length).toBe(table.twa.length);
    }
  });
});

// ===================================================================
// Test: Regression guard — .pol and .csv parsing unaffected by Expedition changes
// ===================================================================
describe('Regression guard: .pol and .csv parsing after Expedition support', () => {
  let engine: PolarEngine;

  beforeEach(() => {
    engine = new PolarEngine();
  });

  it('.pol parser still returns expected table', () => {
    const polContent = `6\t10\t14
40\t2.0\t3.5\t5.0
60\t3.0\t5.0\t7.0
`;
    const table = engine.parsePolContent(polContent)!;
    expect(table.tws).toEqual([6, 10, 14]);
    expect(table.twa).toEqual([40, 60]);
    expect(table.speeds[0]).toEqual([2.0, 3.5, 5.0]);
  });

  it('.csv parser still returns expected table', () => {
    const csvContent = `TWA,6,10,14
40,2.0,3.5,5.0
60,3.0,5.0,7.0
`;
    const table = engine.parseCsvContent(csvContent)!;
    expect(table.tws).toEqual([6, 10, 14]);
    expect(table.twa).toEqual([40, 60]);
  });
});
