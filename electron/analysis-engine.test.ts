import { describe, it, expect } from 'vitest';
import {
  reconstructTimeSeries,
  resampleToGrid,
  detectSegments,
  assignSailTags,
  computeSegmentPerformance,
  interpolateSpeed,
  aggregatePerformance,
  splitSegmentsAtSailChanges,
} from './analysis-engine';
import type { TimeSeriesPoint, SegmentThresholds, DetectedSegmentData, SailTagData } from './analysis-engine';
import type { PolarTable } from './polar-engine';

// Sun Fast 3300 polar data (subset for testing)
const TEST_POLAR: PolarTable = {
  tws: [6, 8, 10, 12, 16, 20],
  twa: [40, 45, 50, 55, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 170, 180],
  speeds: [
    [2.1, 2.8, 3.2, 3.4, 3.5, 3.4, 3.2, 3.0, 2.8, 2.6, 2.4, 2.2, 2.0, 1.8, 1.6, 1.4, 1.2],
    [3.0, 3.9, 4.5, 4.8, 5.0, 4.9, 4.7, 4.4, 4.1, 3.8, 3.5, 3.2, 2.9, 2.6, 2.3, 2.0, 1.7],
    [4.0, 5.2, 6.0, 6.4, 6.7, 6.5, 6.2, 5.9, 5.5, 5.1, 4.7, 4.3, 3.9, 3.5, 3.1, 2.7, 2.3],
    [5.0, 6.5, 7.5, 8.0, 8.4, 8.1, 7.8, 7.4, 7.0, 6.5, 6.0, 5.5, 5.0, 4.5, 4.0, 3.5, 3.0],
    [6.5, 8.5, 9.8, 10.5, 11.0, 10.7, 10.3, 9.8, 9.3, 8.7, 8.1, 7.4, 6.7, 6.0, 5.3, 4.6, 3.9],
    [7.5, 10.0, 11.5, 12.5, 13.2, 12.8, 12.3, 11.7, 11.0, 10.3, 9.5, 8.7, 7.8, 7.0, 6.1, 5.2, 4.3],
  ],
};

// Helper: generate a synthetic resampled time series
function makeSeries(
  startMs: number,
  durationS: number,
  baseValue: number,
  variation: number, // half-range of random variation
  seed: number = 42,
): TimeSeriesPoint[] {
  const points: TimeSeriesPoint[] = [];
  // Simple deterministic pseudo-random for test reproducibility
  let state = seed;
  const rand = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return (state / 0x7fffffff) * 2 - 1; };

  for (let t = 0; t < durationS; t++) {
    points.push({
      time: startMs + t * 1000,
      value: baseValue + rand() * variation,
    });
  }
  return points;
}

// Helper: generate steady then unsteady data
function makeCompositeSeries(
  startMs: number,
  sections: Array<{ durationS: number; base: number; variation: number }>,
  seed: number = 42,
): TimeSeriesPoint[] {
  const points: TimeSeriesPoint[] = [];
  let state = seed;
  const rand = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return (state / 0x7fffffff) * 2 - 1; };
  let t = 0;
  for (const sec of sections) {
    for (let i = 0; i < sec.durationS; i++) {
      points.push({
        time: startMs + t * 1000,
        value: sec.base + rand() * sec.variation,
      });
      t++;
    }
  }
  return points;
}


describe('Analysis Engine', () => {
  // Test 1: Data reconstruction
  describe('Data reconstruction', () => {
    it('reconstructs TWS/TWA/TWD/STW/AWS/AWA from stored PGN rows with correct unit conversions', () => {
      const rows = [
        // STW: 3.0 m/s → 5.83 kts
        { timestamp: '2026-06-01T10:00:00.000Z', pgn: 128259, data: JSON.stringify({ speedWaterReferenced: 3.0 }) },
        // Apparent wind: speed=6.0 m/s → 11.66 kts, angle=0.785 rad → 45°
        { timestamp: '2026-06-01T10:00:00.000Z', pgn: 130306, data: JSON.stringify({ windSpeed: 6.0, windAngle: 0.785398, reference: 'Apparent' }) },
        // Heading: 1.5708 rad → 90°
        { timestamp: '2026-06-01T10:00:00.000Z', pgn: 127250, data: JSON.stringify({ heading: 1.5708 }) },
      ];

      const ts = reconstructTimeSeries(rows);

      // STW should be converted to knots
      expect(ts.stw.length).toBeGreaterThan(0);
      expect(ts.stw[0].value).toBeCloseTo(3.0 * 1.94384, 1);

      // AWS should be converted to knots
      expect(ts.aws[0].value).toBeCloseTo(6.0 * 1.94384, 1);

      // AWA stored as signed angle: positive = starboard
      expect(ts.awa[0].value).toBeCloseTo(45, 0);
      expect(ts.awaSide[0].value).toBe('starboard');

      // Heading should be converted to degrees
      expect(ts.heading[0].value).toBeCloseTo(90, 0);

      // TWS/TWA should be computed from apparent wind
      expect(ts.tws[0].value).not.toBeNull();
      expect(ts.twa[0].value).not.toBeNull();

      // TWD = heading + TWA
      expect(ts.twd[0].value).not.toBeNull();
    });

    it('normalizes port-side AWA/TWA to signed angles while preserving side context', () => {
      const rows = [
        { timestamp: '2026-06-01T10:00:00.000Z', pgn: 128259, data: JSON.stringify({ speedWaterReferenced: 2.0 }) },
        { timestamp: '2026-06-01T10:00:00.000Z', pgn: 130306, data: JSON.stringify({ windSpeed: 5.0, windAngle: (315 * Math.PI) / 180, reference: 'Apparent' }) },
        { timestamp: '2026-06-01T10:00:01.000Z', pgn: 130306, data: JSON.stringify({ windSpeed: 5.0, windAngle: (225 * Math.PI) / 180, reference: 'True (boat referenced)' }) },
      ];

      const ts = reconstructTimeSeries(rows);

      // Port angles are stored as negative signed values
      expect(ts.awa[0].value).toBeCloseTo(-45, 0);
      expect(ts.awaSide[0].value).toBe('port');
      expect(ts.twa[1].value).toBeCloseTo(-135, 0);
      expect(ts.twaSide[1].value).toBe('port');
    });
  });

  // Test 2: Resampling
  describe('Resampling', () => {
    it('interpolates to 1-second grid with breaks at gaps >= 5s', () => {
      const series: TimeSeriesPoint[] = [
        { time: 0, value: 10 },
        { time: 2000, value: 12 },
        // 3s gap (< 5s) — should interpolate
        { time: 5000, value: 15 },
        // 8s gap (>= 5s) — should break
        { time: 13000, value: 20 },
        { time: 14000, value: 21 },
      ];

      const resampled = resampleToGrid(series, 0, 14000);

      // Should have 15 points (0s to 14s inclusive)
      expect(resampled.length).toBe(15);

      // At t=0, value should be 10
      expect(resampled[0].value).toBeCloseTo(10, 1);

      // At t=1 (between 0 and 2), should interpolate
      expect(resampled[1].value).toBeCloseTo(11, 0);

      // In the middle of the large gap (t=8 to t=10), values should be null
      // Points near the edges of the gap (within 5s of a known value) may still be filled
      const midGapNulls = resampled.filter((p) => p.time >= 10000 && p.time <= 11000 && p.value === null);
      expect(midGapNulls.length).toBeGreaterThan(0);
    });
  });

  // Test 3: Segment detection — basic
  describe('Segment detection', () => {
    it('detects one segment from a 120s steady-state period', () => {
      const startMs = 1000000;
      const tws = makeSeries(startMs, 120, 12, 0.5, 1); // TWS=12±0.5
      const twa = makeSeries(startMs, 120, 90, 3, 2);    // TWA=90±3
      const stw = makeSeries(startMs, 120, 6.5, 0.2, 3); // STW=6.5±0.2

      const thresholds: SegmentThresholds = { tws: 1.5, twa: 10, stw: 0.5, minDuration: 60 };
      const segments = detectSegments(tws, twa, stw, thresholds);

      expect(segments.length).toBe(1);
      expect(segments[0].meanTws).toBeCloseTo(12, 0);
      expect(segments[0].meanTwa).toBeCloseTo(90, 0);
      expect(segments[0].meanStw).toBeCloseTo(6.5, 0);
      expect(segments[0].durationS).toBeGreaterThanOrEqual(59); // At least 60s minus rounding
    });

    // Test 4: No unsteady-gap merge (PRD §3.5)
    // An 8s window with clearly unsteady data (high variation) must NOT be merged
    // even though the gap is < 10 s.  The secondary stability check should reject it.
    it('keeps two steady windows separate when the 8s gap contains clearly unsteady data (PRD §3.5)', () => {
      const startMs = 0;
      // Steady 70s, then 8s with very high variation (maneuver), then steady 70s
      const tws = makeCompositeSeries(startMs, [
        { durationS: 70, base: 12, variation: 0.3 },
        { durationS: 8, base: 12, variation: 5 }, // ±5 kts — far exceeds any stability threshold
        { durationS: 70, base: 12, variation: 0.3 },
      ], 1);
      const twa = makeCompositeSeries(startMs, [
        { durationS: 70, base: 90, variation: 2 },
        { durationS: 8, base: 90, variation: 30 }, // ±30° — clearly a maneuver
        { durationS: 70, base: 90, variation: 2 },
      ], 2);
      const stw = makeCompositeSeries(startMs, [
        { durationS: 70, base: 6.5, variation: 0.1 },
        { durationS: 8, base: 6.5, variation: 3 },
        { durationS: 70, base: 6.5, variation: 0.1 },
      ], 3);

      const thresholds: SegmentThresholds = { tws: 1.5, twa: 10, stw: 0.5, minDuration: 60 };
      const segments = detectSegments(tws, twa, stw, thresholds);

      // Must produce two separate segments — unsteady gap must not be absorbed (PRD §3.5)
      expect(segments.length).toBe(2);
    });

    // Test 5: No merge
    it('keeps two segments separate when gap is 15s', () => {
      const startMs = 0;
      const tws = makeCompositeSeries(startMs, [
        { durationS: 70, base: 12, variation: 0.3 },
        { durationS: 15, base: 12, variation: 5 },
        { durationS: 70, base: 12, variation: 0.3 },
      ], 1);
      const twa = makeCompositeSeries(startMs, [
        { durationS: 70, base: 90, variation: 2 },
        { durationS: 15, base: 90, variation: 30 },
        { durationS: 70, base: 90, variation: 2 },
      ], 2);
      const stw = makeCompositeSeries(startMs, [
        { durationS: 70, base: 6.5, variation: 0.1 },
        { durationS: 15, base: 6.5, variation: 3 },
        { durationS: 70, base: 6.5, variation: 0.1 },
      ], 3);

      const thresholds: SegmentThresholds = { tws: 1.5, twa: 10, stw: 0.5, minDuration: 60 };
      const segments = detectSegments(tws, twa, stw, thresholds);

      expect(segments.length).toBe(2);
    });

    // Test 6: Below minimum duration
    it('does not detect a 25s stable period with 60s minimum', () => {
      const startMs = 0;
      const tws = makeSeries(startMs, 25, 12, 0.2, 1);
      const twa = makeSeries(startMs, 25, 90, 1, 2);
      const stw = makeSeries(startMs, 25, 6.5, 0.1, 3);

      const thresholds: SegmentThresholds = { tws: 1.5, twa: 10, stw: 0.5, minDuration: 60 };
      const segments = detectSegments(tws, twa, stw, thresholds);

      expect(segments.length).toBe(0);
    });

    // Test 7: STW exclusion
    it('discards segments with mean STW < 1.0 kts', () => {
      const startMs = 0;
      const tws = makeSeries(startMs, 120, 5, 0.3, 1);
      const twa = makeSeries(startMs, 120, 90, 2, 2);
      const stw = makeSeries(startMs, 120, 0.5, 0.1, 3); // Mean STW ~0.5

      const thresholds: SegmentThresholds = { tws: 1.5, twa: 10, stw: 0.5, minDuration: 60 };
      const segments = detectSegments(tws, twa, stw, thresholds);

      expect(segments.length).toBe(0);
    });

    // Test 8: Tightening thresholds reduces segments
    it('tightening TWS threshold reduces detected segments', () => {
      const startMs = 0;
      // Create data with moderate variation (TWS range ~2kts)
      const tws = makeCompositeSeries(startMs, [
        { durationS: 120, base: 12, variation: 0.8 }, // range ~1.6kts — passes ±1.5 but fails ±0.5
        { durationS: 30, base: 12, variation: 5 },
        { durationS: 120, base: 12, variation: 0.2 },  // range ~0.4kts — passes both
      ], 1);
      const twa = makeSeries(startMs, 270, 90, 2, 2);
      const stw = makeSeries(startMs, 270, 6.5, 0.1, 3);

      const loose: SegmentThresholds = { tws: 1.5, twa: 10, stw: 0.5, minDuration: 60 };
      const tight: SegmentThresholds = { tws: 0.5, twa: 10, stw: 0.5, minDuration: 60 };

      const looseSegments = detectSegments(tws, twa, stw, loose);
      const tightSegments = detectSegments(tws, twa, stw, tight);

      expect(tightSegments.length).toBeLessThanOrEqual(looseSegments.length);
    });
  });

  // Test 9: % of polar per segment
  describe('Polar performance', () => {
    it('computes correct % of polar for a segment at TWS=12, TWA=90', () => {
      // At TWS=12, TWA=90 the Sun Fast 3300 target is 7.4 kts
      const targetSpeed = interpolateSpeed(TEST_POLAR, 12, 90);
      expect(targetSpeed).toBeCloseTo(7.4, 1);

      const segments: DetectedSegmentData[] = [{
        startTime: 0, endTime: 120000, durationS: 120,
        meanTws: 12, meanTwa: 90, meanStw: 6.66,
        stdTws: 0.3, stdTwa: 2, stdStw: 0.1,
        percentPolar: null, sailConfig: null,
      }];

      const withPerf = computeSegmentPerformance(segments, TEST_POLAR);
      expect(withPerf[0].percentPolar).toBe(Math.round((6.66 / 7.4) * 100));
    });
  });

  // Test 10: Sail tag assignment — matching
  describe('Sail tag assignment', () => {
    it('assigns sail config when tag covers the segment', () => {
      const segments: DetectedSegmentData[] = [{
        startTime: 600000, endTime: 720000, durationS: 120, // 10:00 - 12:00
        meanTws: 12, meanTwa: 90, meanStw: 6.5,
        stdTws: 0.3, stdTwa: 2, stdStw: 0.1,
        percentPolar: null, sailConfig: null,
      }];

      const tags: SailTagData[] = [{
        sailConfig: 'J2 + Main',
        startTime: 590000, // 09:50
        endTime: 750000,   // 12:30
      }];

      const result = assignSailTags(segments, tags);
      expect(result[0].sailConfig).toBe('J2 + Main');
    });

    // Test 11: Sail tag gap
    it('leaves sail_config null when no tag overlaps', () => {
      const segments: DetectedSegmentData[] = [{
        startTime: 600000, endTime: 720000, durationS: 120,
        meanTws: 12, meanTwa: 90, meanStw: 6.5,
        stdTws: 0.3, stdTwa: 2, stdStw: 0.1,
        percentPolar: null, sailConfig: null,
      }];

      const tags: SailTagData[] = [{
        sailConfig: 'J2 + Main',
        startTime: 0,
        endTime: 500000, // Ends before segment starts
      }];

      const result = assignSailTags(segments, tags);
      expect(result[0].sailConfig).toBeNull();
    });
  });

  // Test 12: Performance aggregation
  describe('Performance aggregation', () => {
    it('aggregates three segments into correct average % polar', () => {
      const segments: DetectedSegmentData[] = [
        {
          startTime: 0, endTime: 120000, durationS: 120,
          meanTws: 11, meanTwa: 80, meanStw: 7.0,
          stdTws: 0.3, stdTwa: 2, stdStw: 0.1,
          percentPolar: 95, sailConfig: 'J2 + Main',
        },
        {
          startTime: 200000, endTime: 320000, durationS: 120,
          meanTws: 10.5, meanTwa: 85, meanStw: 6.5,
          stdTws: 0.3, stdTwa: 2, stdStw: 0.1,
          percentPolar: 90, sailConfig: 'J2 + Main',
        },
        {
          startTime: 400000, endTime: 520000, durationS: 120,
          meanTws: 11.5, meanTwa: 75, meanStw: 7.5,
          stdTws: 0.3, stdTwa: 2, stdStw: 0.1,
          percentPolar: 100, sailConfig: 'J2 + Main',
        },
      ];

      const rows = aggregatePerformance(segments);
      expect(rows.length).toBe(1);
      expect(rows[0].sailConfig).toBe('J2 + Main');

      // All three segments are in TWS 10-12, TWA 60-90 band
      const key = '10-12:60-90';
      expect(rows[0].cells[key]).not.toBeNull();
      expect(rows[0].cells[key]!.segmentCount).toBe(3);
      expect(rows[0].cells[key]!.avgPercentPolar).toBe(Math.round((95 + 90 + 100) / 3));

      expect(rows[0].totalSegments).toBe(3);
      expect(rows[0].overallAvgPercent).toBe(Math.round((95 + 90 + 100) / 3));
    });
  });

  // Test 13 (bonus): interpolateSpeed for non-exact TWS/TWA
  describe('Polar interpolation', () => {
    it('interpolates between TWS columns correctly', () => {
      // TWS=9 is between 8 and 10. At TWA=90:
      // TWS=8 → 4.4 kts, TWS=10 → 5.9 kts
      // Interpolated: 4.4 + 0.5 * (5.9 - 4.4) = 5.15
      const speed = interpolateSpeed(TEST_POLAR, 9, 90);
      expect(speed).toBeCloseTo(5.15, 1);
    });
  });
});

// ---------------------------------------------------------------------------
// BE5 — Prevent unsteady-gap segment merging (PRD §3.5)
// ---------------------------------------------------------------------------

describe('BE5: Prevent unsteady-gap segment merging (PRD §3.5)', () => {
  const thresholds: SegmentThresholds = { tws: 1.5, twa: 10, stw: 0.5, minDuration: 40 };

  it('two steady windows separated by an unsteady 8s gap → two segments', () => {
    const startMs = 0;
    // 40s steady → 8s maneuver-level noise → 40s steady
    const tws = makeCompositeSeries(startMs, [
      { durationS: 40, base: 12, variation: 0.3 },
      { durationS: 8, base: 12, variation: 5 }, // ±5 kts — clearly unsteady
      { durationS: 40, base: 12, variation: 0.3 },
    ], 7);
    const twa = makeCompositeSeries(startMs, [
      { durationS: 40, base: 90, variation: 2 },
      { durationS: 8, base: 90, variation: 30 }, // ±30° — clearly unsteady
      { durationS: 40, base: 90, variation: 2 },
    ], 8);
    const stw = makeCompositeSeries(startMs, [
      { durationS: 40, base: 6.5, variation: 0.1 },
      { durationS: 8, base: 6.5, variation: 3 }, // clearly unsteady
      { durationS: 40, base: 6.5, variation: 0.1 },
    ], 9);

    const segs = detectSegments(tws, twa, stw, thresholds);
    expect(segs.length).toBe(2);
  });

  it('two directly adjacent steady windows → may merge into one', () => {
    const startMs = 0;
    // 80s of continuous steady data — all qualifying windows overlap/are adjacent
    const tws = makeSeries(startMs, 80, 12, 0.3, 10);
    const twa = makeSeries(startMs, 80, 90, 2, 11);
    const stw = makeSeries(startMs, 80, 6.5, 0.1, 12);

    const segs = detectSegments(tws, twa, stw, thresholds);
    expect(segs.length).toBe(1);
  });

  it('segment statistics contain only samples from the steady region', () => {
    const startMs = 0;
    // 40s at TWS=12 → 8s at TWS=22 (unsteady spike) → 40s at TWS=12
    const tws = makeCompositeSeries(startMs, [
      { durationS: 40, base: 12, variation: 0.3 },
      { durationS: 8, base: 22, variation: 5 },
      { durationS: 40, base: 12, variation: 0.3 },
    ], 13);
    const twa = makeCompositeSeries(startMs, [
      { durationS: 40, base: 90, variation: 2 },
      { durationS: 8, base: 90, variation: 30 },
      { durationS: 40, base: 90, variation: 2 },
    ], 14);
    const stw = makeCompositeSeries(startMs, [
      { durationS: 40, base: 6.5, variation: 0.1 },
      { durationS: 8, base: 6.5, variation: 3 },
      { durationS: 40, base: 6.5, variation: 0.1 },
    ], 15);

    const segs = detectSegments(tws, twa, stw, thresholds);
    expect(segs.length).toBe(2);
    // Both segments should have meanTws ≈ 12, NOT contaminated by the 22-kts spike
    for (const seg of segs) {
      expect(seg.meanTws).toBeCloseTo(12, 0);
    }
  });
});

// ---------------------------------------------------------------------------
// BE6 — Split segments at sail-change boundaries (PRD §3.6)
// ---------------------------------------------------------------------------

describe('BE6: Split segments at sail-change boundaries (PRD §3.6)', () => {
  const BASE_MS = 1_700_000_000_000;

  function makeSteadySegment(
    startMs: number,
    durationMs: number,
    twaBase = 90,
  ): DetectedSegmentData {
    return {
      startTime: startMs,
      endTime: startMs + durationMs,
      durationS: durationMs / 1000,
      meanTws: 12,
      meanTwa: twaBase,
      meanStw: 6.5,
      stdTws: 0.3,
      stdTwa: 2,
      stdStw: 0.1,
      percentPolar: null,
      sailConfig: null,
    };
  }

  function makeTimeSeries(
    startMs: number,
    durationMs: number,
    tws = 12,
    twa = 90,
    stw = 6.5,
  ): { tws: TimeSeriesPoint[]; twa: TimeSeriesPoint[]; stw: TimeSeriesPoint[] } {
    const twsSeries: TimeSeriesPoint[] = [];
    const twaSeries: TimeSeriesPoint[] = [];
    const stwSeries: TimeSeriesPoint[] = [];
    for (let t = startMs; t <= startMs + durationMs; t += 1000) {
      twsSeries.push({ time: t, value: tws });
      twaSeries.push({ time: t, value: twa });
      stwSeries.push({ time: t, value: stw });
    }
    return { tws: twsSeries, twa: twaSeries, stw: stwSeries };
  }

  it('one sail change inside a segment → two correctly tagged sub-segments', () => {
    const segStart = BASE_MS;
    const sailChange = BASE_MS + 30_000; // 30 s into a 60 s segment
    const segEnd = BASE_MS + 60_000;

    const segment = makeSteadySegment(segStart, segEnd - segStart);
    const sailTags: SailTagData[] = [
      { sailConfig: 'A2', startTime: segStart, endTime: sailChange },
      { sailConfig: 'A3', startTime: sailChange, endTime: segEnd },
    ];
    const ts = makeTimeSeries(segStart, segEnd - segStart);
    const minDuration = 20; // 20-second minimum — both pieces are 30 s

    const result = splitSegmentsAtSailChanges(
      [segment], sailTags, ts.tws, ts.twa, ts.stw, minDuration,
    );

    expect(result.length).toBe(2);
    expect(result[0].sailConfig).toBe('A2');
    expect(result[0].startTime).toBe(segStart);
    expect(result[0].endTime).toBe(sailChange);
    expect(result[1].sailConfig).toBe('A3');
    expect(result[1].startTime).toBe(sailChange);
    expect(result[1].endTime).toBe(segEnd);
  });

  it('multiple sail changes inside a segment → multiple correctly tagged sub-segments', () => {
    const segStart = BASE_MS;
    const change1 = BASE_MS + 60_000;
    const change2 = BASE_MS + 120_000;
    const segEnd = BASE_MS + 180_000;

    const segment = makeSteadySegment(segStart, segEnd - segStart);
    const sailTags: SailTagData[] = [
      { sailConfig: 'J1', startTime: segStart, endTime: change1 },
      { sailConfig: 'J2', startTime: change1, endTime: change2 },
      { sailConfig: 'J3', startTime: change2, endTime: segEnd },
    ];
    const ts = makeTimeSeries(segStart, segEnd - segStart);

    const result = splitSegmentsAtSailChanges(
      [segment], sailTags, ts.tws, ts.twa, ts.stw, 30,
    );

    expect(result.length).toBe(3);
    expect(result[0].sailConfig).toBe('J1');
    expect(result[1].sailConfig).toBe('J2');
    expect(result[2].sailConfig).toBe('J3');
  });

  it('sub-segment below minimum duration after split → discarded', () => {
    const segStart = BASE_MS;
    const sailChange = BASE_MS + 3_000; // Creates a 3-second first piece
    const segEnd = BASE_MS + 60_000;

    const segment = makeSteadySegment(segStart, segEnd - segStart);
    const sailTags: SailTagData[] = [
      { sailConfig: 'A2', startTime: segStart, endTime: sailChange },
      { sailConfig: 'A3', startTime: sailChange, endTime: segEnd },
    ];
    const ts = makeTimeSeries(segStart, segEnd - segStart);

    const result = splitSegmentsAtSailChanges(
      [segment], sailTags, ts.tws, ts.twa, ts.stw, 30, // 30s minimum
    );

    // First piece is 3s → discarded; second piece is 57s → kept
    expect(result.length).toBe(1);
    expect(result[0].sailConfig).toBe('A3');
  });

  it('statistics recalculated per sub-segment (not inherited from parent)', () => {
    const segStart = BASE_MS;
    const sailChange = BASE_MS + 60_000;
    const segEnd = BASE_MS + 120_000;

    // Parent segment has inherited meanTwa=90 from before splitting
    const segment = makeSteadySegment(segStart, segEnd - segStart, 90);

    // But the actual data has different TWA in each half
    const tws: TimeSeriesPoint[] = [];
    const twa: TimeSeriesPoint[] = [];
    const stw: TimeSeriesPoint[] = [];
    for (let t = segStart; t <= segEnd; t += 1000) {
      tws.push({ time: t, value: 12 });
      // First 60s at TWA=60°, second 60s at TWA=120°
      twa.push({ time: t, value: t < sailChange ? 60 : 120 });
      stw.push({ time: t, value: 6.5 });
    }

    const sailTags: SailTagData[] = [
      { sailConfig: 'Upwind', startTime: segStart, endTime: sailChange },
      { sailConfig: 'Downwind', startTime: sailChange, endTime: segEnd },
    ];

    const result = splitSegmentsAtSailChanges([segment], sailTags, tws, twa, stw, 30);

    expect(result.length).toBe(2);
    // Sub-segment 1: samples where t < sailChange → meanTwa ≈ 60
    expect(result[0].meanTwa).toBeCloseTo(60, 0);
    // Sub-segment 2: samples where t >= sailChange → meanTwa ≈ 120
    expect(result[1].meanTwa).toBeCloseTo(120, 0);
    // Not the parent's inherited value of 90
    expect(result[0].meanTwa).not.toBeCloseTo(90, 0);
  });

  it('segment with no sail-change boundary inside → passed through unchanged', () => {
    const segStart = BASE_MS;
    const segEnd = BASE_MS + 120_000;
    const segment = makeSteadySegment(segStart, segEnd - segStart);
    const sailTags: SailTagData[] = [
      { sailConfig: 'J1', startTime: segStart - 10_000, endTime: segEnd + 10_000 },
    ];
    const ts = makeTimeSeries(segStart, segEnd - segStart);

    const result = splitSegmentsAtSailChanges([segment], sailTags, ts.tws, ts.twa, ts.stw, 30);
    expect(result.length).toBe(1);
    // Unchanged pass-through: same start/end
    expect(result[0].startTime).toBe(segStart);
    expect(result[0].endTime).toBe(segEnd);
  });
});

// ---------------------------------------------------------------------------
// QF1 — Circular-aware TWA band matching in aggregatePerformance (§3.3)
// ---------------------------------------------------------------------------

describe('QF1: aggregatePerformance uses |meanTwa| for band matching (PRD §3.3)', () => {
  it('port-tack downwind segment (meanTwa ≈ -170) maps into [150,180] band', () => {
    const segments: DetectedSegmentData[] = [
      {
        startTime: 0, endTime: 120000, durationS: 120,
        meanTws: 16, meanTwa: -170, meanStw: 8.0,
        stdTws: 0.3, stdTwa: 2, stdStw: 0.1,
        percentPolar: 92, sailConfig: 'A5',
      },
    ];

    const rows = aggregatePerformance(segments);
    expect(rows.length).toBe(1);
    const key = '16-20:150-180';
    expect(rows[0].cells[key]).not.toBeNull();
    expect(rows[0].cells[key]!.segmentCount).toBe(1);
    expect(rows[0].cells[key]!.avgPercentPolar).toBe(92);
  });

  it('starboard-tack and port-tack downwind segments both aggregate into same band', () => {
    const segments: DetectedSegmentData[] = [
      {
        startTime: 0, endTime: 120000, durationS: 120,
        meanTws: 10, meanTwa: 165, meanStw: 7.0,  // starboard tack
        stdTws: 0.3, stdTwa: 2, stdStw: 0.1,
        percentPolar: 88, sailConfig: 'A2',
      },
      {
        startTime: 200000, endTime: 320000, durationS: 120,
        meanTws: 10, meanTwa: -165, meanStw: 7.2, // port tack (same angle, opposite sign)
        stdTws: 0.3, stdTwa: 2, stdStw: 0.1,
        percentPolar: 90, sailConfig: 'A2',
      },
    ];

    const rows = aggregatePerformance(segments);
    expect(rows.length).toBe(1);
    const key = '10-12:150-180';
    expect(rows[0].cells[key]).not.toBeNull();
    expect(rows[0].cells[key]!.segmentCount).toBe(2);
    expect(rows[0].cells[key]!.avgPercentPolar).toBe(Math.round((88 + 90) / 2));
  });
});
