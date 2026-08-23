/**
 * Phase 2.8 Reliability — P0 tests
 *
 * BE2: Historical-value freshness limits (PRD §3.2)
 * BE3: Circular statistics for TWA (PRD §3.3)
 */

import { describe, it, expect } from 'vitest';
import { reconstructTimeSeries } from './analysis-engine';
import {
  shortestAngularDiff,
  circularMean,
  circularDispersion,
} from './wind-utils';

// ---------------------------------------------------------------------------
// BE3 — Circular statistics for TWA (PRD §3.3)
// ---------------------------------------------------------------------------

describe('BE3: Circular statistics for TWA (PRD §3.3)', () => {
  // -------------------------------------------------------------------------
  // shortestAngularDiff
  // -------------------------------------------------------------------------
  describe('shortestAngularDiff', () => {
    it('returns 0 for identical angles', () => {
      expect(shortestAngularDiff(90, 90)).toBe(0);
    });

    it('returns positive diff for clockwise rotation', () => {
      expect(shortestAngularDiff(0, 90)).toBe(90);
    });

    it('returns negative diff for counter-clockwise rotation', () => {
      expect(shortestAngularDiff(90, 0)).toBe(-90);
    });

    it('handles ±180° boundary: 179 → -179 is +2° (shortest path through ±180)', () => {
      // Going from +179° to -179° the short way is +2° through the ±180 boundary.
      expect(shortestAngularDiff(179, -179)).toBeCloseTo(2, 5);
    });

    it('handles ±180° boundary: -179 → 179 is -2° (shortest path back through ±180)', () => {
      expect(shortestAngularDiff(-179, 179)).toBeCloseTo(-2, 5);
    });

    it('returns exactly ±180 at the extremes', () => {
      const diff = shortestAngularDiff(0, 180);
      expect(Math.abs(diff)).toBe(180);
    });
  });

  // -------------------------------------------------------------------------
  // circularMean — PRD required tests
  // -------------------------------------------------------------------------
  describe('circularMean', () => {
    it('[178, 179, -179, -178] → mean ≈ ±180° (stable downwind)', () => {
      const mean = circularMean([178, 179, -179, -178]);
      // Mean resultant points straight aft; atan2 gives ±180°
      expect(Math.abs(mean)).toBeCloseTo(180, 3);
    });

    it('[-2, -1, 1, 2] → mean ≈ 0° (stable head-to-wind)', () => {
      const mean = circularMean([-2, -1, 1, 2]);
      expect(mean).toBeCloseTo(0, 3);
    });

    it('[170, -170] → ≈ ±180°, NOT 0° (PRD §3.3 required test)', () => {
      const mean = circularMean([170, -170]);
      // Both angles point nearly aft; arithmetic mean would be 0 — wrong
      expect(Math.abs(mean)).toBeCloseTo(180, 1);
      // Explicitly confirm it is NOT the arithmetic mean
      expect(Math.abs(mean)).toBeGreaterThan(90);
    });

    it('single angle returns that angle', () => {
      expect(circularMean([45])).toBeCloseTo(45, 3);
      expect(circularMean([-90])).toBeCloseTo(-90, 3);
    });

    it('empty array returns 0', () => {
      expect(circularMean([])).toBe(0);
    });

    it('symmetric starboard TWA → positive mean', () => {
      const mean = circularMean([40, 45, 50]);
      expect(mean).toBeCloseTo(45, 1);
    });
  });

  // -------------------------------------------------------------------------
  // circularDispersion — PRD required stability tests
  // -------------------------------------------------------------------------
  describe('circularDispersion — stability threshold tests (PRD §3.3)', () => {
    it('[178, 179, -179, -178] → detected as stable (small dispersion)', () => {
      const d = circularDispersion([178, 179, -179, -178]);
      // Mean resultant R ≈ 1 → dispersion ≈ 0
      expect(d).toBeLessThan(0.01);
    });

    it('[-2, -1, 1, 2] → detected as stable around 0°', () => {
      const d = circularDispersion([-2, -1, 1, 2]);
      expect(d).toBeLessThan(0.01);
    });

    it('[-90, 0, 90] → large dispersion (fails steady-state threshold)', () => {
      const d = circularDispersion([-90, 0, 90]);
      // Very spread out — dispersion should be substantial
      expect(d).toBeGreaterThan(0.3);
    });

    it('uniformly spread 4-quadrant angles → maximum dispersion', () => {
      const d = circularDispersion([0, 90, 180, -90]);
      // Mean resultant ≈ 0 → dispersion ≈ 1
      expect(d).toBeGreaterThan(0.9);
    });

    it('single angle → 0 (no dispersion)', () => {
      expect(circularDispersion([45])).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// BE2 — Historical-value freshness limits (PRD §3.2)
// ---------------------------------------------------------------------------

/**
 * Build a single-field RawPGNRow for use in reconstructTimeSeries tests.
 * `offsetMs` shifts the row timestamp relative to a base time.
 */
function makeRow(
  baseMs: number,
  pgn: number,
  fields: Record<string, any>,
  offsetMs = 0,
): { timestamp: string; pgn: number; data: string } {
  return {
    timestamp: new Date(baseMs + offsetMs).toISOString(),
    pgn,
    data: JSON.stringify(fields),
  };
}

const BASE = 1_700_000_000_000; // arbitrary base epoch ms
const MS_TO_KTS = 1.94384;
const RAD_TO_DEG = 180 / Math.PI;

describe('BE2: Historical-value freshness limits in reconstructTimeSeries (PRD §3.2)', () => {
  // -------------------------------------------------------------------------
  // Test 1: Fresh AWS + fresh AWA → valid TWS/TWA
  // -------------------------------------------------------------------------
  it('fresh AWS + fresh AWA → valid TWS/TWA produced', () => {
    // At t=0: AWS 6 m/s, AWA 45°, STW 3 m/s — all the same timestamp → fresh
    const rows = [
      makeRow(BASE, 128259, { speedWaterReferenced: 3.0 }),         // STW
      makeRow(BASE, 130306, { windSpeed: 6.0, windAngle: (45 * Math.PI) / 180, reference: 'Apparent' }),
    ];

    const ts = reconstructTimeSeries(rows);
    expect(ts.tws[0].value).not.toBeNull();
    expect(ts.twa[0].value).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 2: Stale AWS (beyond threshold) + fresh AWA → no TWS/TWA
  // -------------------------------------------------------------------------
  it('stale AWS beyond threshold + fresh AWA → null TWS/TWA', () => {
    // AWS at t=0, AWA at t=0+3000ms (> AWS_AWA_PAIR_MS of 1500ms)
    // When processing the row at t=3000, the lastAws timestamp is t=0,
    // which is 3000ms old — beyond the 2000ms AWS_AWA freshness window.
    const rows = [
      makeRow(BASE, 130306, { windSpeed: 6.0, windAngle: (45 * Math.PI) / 180, reference: 'Apparent' }, 0),
      // STW at 0 too
      makeRow(BASE, 128259, { speedWaterReferenced: 3.0 }, 0),
      // New row only carrying AWA — AWS is now stale (3000ms old)
      makeRow(BASE, 130306, { windSpeed: null, windAngle: (45 * Math.PI) / 180, reference: 'Apparent' }, 3000),
    ];

    const ts = reconstructTimeSeries(rows);
    // The last point (at t=BASE+3000) should have null TWS/TWA because
    // AWS hasn't been updated within the freshness window AND the pairing window
    const lastIdx = ts.tws.length - 1;
    expect(ts.tws[lastIdx].value).toBeNull();
    expect(ts.twa[lastIdx].value).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 3: Fresh AWS + stale AWA → no TWS/TWA
  // -------------------------------------------------------------------------
  it('fresh AWS + stale AWA → null TWS/TWA', () => {
    // AWA at t=0, AWS at t=+3000ms
    // When processing t=BASE+3000, lastAwa.timestamp = BASE (3000ms old) > 2000ms threshold
    const rows = [
      // AWA only at t=0 (no windSpeed field → won't be treated as AWS)
      makeRow(BASE, 130306, { windAngle: (45 * Math.PI) / 180, reference: 'Apparent' }, 0),
      makeRow(BASE, 128259, { speedWaterReferenced: 3.0 }, 0),
      // AWS-only row at t=+3000ms
      makeRow(BASE, 130306, { windSpeed: 6.0, reference: 'Apparent' }, 3000),
    ];

    const ts = reconstructTimeSeries(rows);
    const lastIdx = ts.tws.length - 1;
    // AWS is fresh but AWA is 3000ms stale → no true wind
    expect(ts.tws[lastIdx].value).toBeNull();
    expect(ts.twa[lastIdx].value).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 4: Sensor gap remains a real null gap (gap detection not bypassed)
  // -------------------------------------------------------------------------
  it('stale STW carry-forward produces null, preserving gap for resampler', () => {
    // STW at t=0; then 15000ms of silence before the next data row.
    // STW_FRESHNESS_MS = 10000ms — so the row at t=15000 should see null STW.
    const rows = [
      makeRow(BASE, 128259, { speedWaterReferenced: 3.0 }, 0),
      // Next row 15 seconds later — only carries a heading update, not STW
      makeRow(BASE, 127250, { heading: 1.5708 }, 15000),
    ];

    const ts = reconstructTimeSeries(rows);
    // At t=BASE (stw fresh): value should be ~5.83 kts
    expect(ts.stw[0].value).toBeCloseTo(3.0 * MS_TO_KTS, 1);
    // At t=BASE+15000 (stw 15s stale, beyond 10s threshold): value should be null
    expect(ts.stw[1].value).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 5: Fresh AWS/AWA at same timestamp → TWS/TWA computed
  // -------------------------------------------------------------------------
  it('AWS and AWA at the same row timestamp → contemporaneous, TWS/TWA valid', () => {
    const rows = [
      makeRow(BASE, 130306, { windSpeed: 5.0, windAngle: Math.PI / 4, reference: 'Apparent' }),
    ];

    const ts = reconstructTimeSeries(rows);
    // No STW (defaults to 0) — but wind pair is contemporaneous, so computation runs
    expect(ts.tws[0].value).not.toBeNull();
    expect(ts.twa[0].value).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Test 6: Heading carry-forward beyond freshness → null in reconstructed series
  // -------------------------------------------------------------------------
  it('heading beyond HDG_FRESHNESS_MS threshold → null heading in output', () => {
    const rows = [
      makeRow(BASE, 127250, { heading: 1.5708 }, 0),       // heading = 90°
      makeRow(BASE, 128259, { speedWaterReferenced: 3.0 }, 6000), // 6s later, no heading
    ];

    const ts = reconstructTimeSeries(rows);
    // HDG_FRESHNESS_MS = 5000ms; row at +6000ms should see null heading
    expect(ts.heading[0].value).toBeCloseTo(90, 0);
    expect(ts.heading[1].value).toBeNull();
  });
});
