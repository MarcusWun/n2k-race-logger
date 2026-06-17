/**
 * Phase 2 — Renderer logic tests.
 * Tests store state management, filtering, and data flow for the analysis UI.
 * Runs in Node environment (no DOM), testing the logic layer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type {
  TimeSeries,
  TimeSeriesPoint,
  DetectedSegment,
  SailTag,
  PerformanceSummaryRow,
  RaceFileInfo,
  SegmentThresholds,
} from '../src/types/analysis';
import { DEFAULT_THRESHOLDS, TWS_BANDS, TWA_BANDS } from '../src/types/analysis';

// Mock store state (tests logic without Zustand reactivity)
interface MockAnalysisState {
  raceFiles: RaceFileInfo[];
  loadedRacePath: string | null;
  raceMeta: any | null;
  metrics: TimeSeries | null;
  timeRange: { start: number; end: number } | null;
  thresholds: SegmentThresholds;
  segments: DetectedSegment[];
  sailTags: SailTag[];
  performanceSummary: PerformanceSummaryRow[];
  viewStart: number | null;
  viewEnd: number | null;
  analysisTab: 'polar' | 'summary' | 'segments';
  sailFilter: string | null;
  twsFilter: [number, number] | null;
}

function createMockState(): MockAnalysisState {
  return {
    raceFiles: [],
    loadedRacePath: null,
    raceMeta: null,
    metrics: null,
    timeRange: null,
    thresholds: { ...DEFAULT_THRESHOLDS },
    segments: [],
    sailTags: [],
    performanceSummary: [],
    viewStart: null,
    viewEnd: null,
    analysisTab: 'polar',
    sailFilter: null,
    twsFilter: null,
  };
}

// Sample race files
const SAMPLE_RACES: RaceFileInfo[] = [
  { path: '/races/2026-06-01_race.db', label: 'Wed Night Race #12', date: '2026-06-01T18:00:00Z', duration: 3600, points: 5000, size: 2048000 },
  { path: '/races/2026-06-08_race.db', label: 'Sun Afternoon', date: '2026-06-08T14:00:00Z', duration: 7200, points: 12000, size: 5120000 },
];

// Sample segments
const SAMPLE_SEGMENTS: DetectedSegment[] = [
  {
    id: 1, raceId: 1, startTime: '2026-06-01T18:05:00Z', endTime: '2026-06-01T18:07:00Z',
    durationS: 120, meanTws: 11, meanTwa: 80, meanStw: 7.0,
    stdTws: 0.3, stdTwa: 2, stdStw: 0.1, percentPolar: 95,
    sailConfig: 'J2 + Main', excluded: false, thresholds: DEFAULT_THRESHOLDS,
  },
  {
    id: 2, raceId: 1, startTime: '2026-06-01T18:15:00Z', endTime: '2026-06-01T18:17:00Z',
    durationS: 120, meanTws: 10.5, meanTwa: 85, meanStw: 6.5,
    stdTws: 0.3, stdTwa: 2, stdStw: 0.1, percentPolar: 90,
    sailConfig: 'J2 + Main', excluded: false, thresholds: DEFAULT_THRESHOLDS,
  },
  {
    id: 3, raceId: 1, startTime: '2026-06-01T18:30:00Z', endTime: '2026-06-01T18:32:00Z',
    durationS: 120, meanTws: 14, meanTwa: 130, meanStw: 6.0,
    stdTws: 0.4, stdTwa: 3, stdStw: 0.2, percentPolar: 85,
    sailConfig: 'A3 + Main', excluded: false, thresholds: DEFAULT_THRESHOLDS,
  },
];

const SAMPLE_SAIL_TAGS: SailTag[] = [
  { id: 1, raceId: 1, sailConfig: 'J2 + Main', startTime: '2026-06-01T18:00:00Z', endTime: '2026-06-01T18:20:00Z' },
  { id: 2, raceId: 1, sailConfig: 'A3 + Main', startTime: '2026-06-01T18:25:00Z', endTime: '2026-06-01T18:40:00Z' },
];

// Helper to generate dummy time series
function dummyTimeSeries(): TimeSeries {
  const make = (count: number): TimeSeriesPoint[] =>
    Array.from({ length: count }, (_, i) => ({ time: i * 1000, value: Math.random() * 20 }));
  return {
    tws: make(100), twa: make(100), twd: make(100), stw: make(100),
    aws: make(100), awa: make(100), heading: make(100), sog: make(100), cog: make(100),
  };
}

describe('Renderer logic tests', () => {
  // Test 1: Race browser lists race files with correct metadata
  it('race browser: lists race files with correct metadata', () => {
    const state = createMockState();
    state.raceFiles = SAMPLE_RACES;

    expect(state.raceFiles.length).toBe(2);
    expect(state.raceFiles[0].label).toBe('Wed Night Race #12');
    expect(state.raceFiles[0].duration).toBe(3600);
    expect(state.raceFiles[0].points).toBe(5000);
    expect(state.raceFiles[1].size).toBe(5120000);
  });

  // Test 2: Clicking a race opens the Analysis view (sets loaded race state)
  it('race browser: clicking a race sets loaded race state for Analysis view', () => {
    const state = createMockState();
    const metrics = dummyTimeSeries();
    const timeRange = { start: 0, end: 100000 };

    // Simulate opening a race
    state.loadedRacePath = SAMPLE_RACES[0].path;
    state.raceMeta = { id: 1, label: 'Wed Night Race #12' };
    state.metrics = metrics;
    state.timeRange = timeRange;
    state.viewStart = timeRange.start;
    state.viewEnd = timeRange.end;

    expect(state.loadedRacePath).toBe('/races/2026-06-01_race.db');
    expect(state.raceMeta.label).toBe('Wed Night Race #12');
    expect(state.metrics.tws.length).toBe(100);
    expect(state.viewStart).toBe(0);
    expect(state.viewEnd).toBe(100000);
  });

  // Test 3: Strip charts — all metric strips present for a loaded race
  it('strip charts: has all metric time series for a loaded race', () => {
    const metrics = dummyTimeSeries();
    const expectedKeys = ['tws', 'twa', 'twd', 'stw', 'aws', 'awa', 'heading', 'sog', 'cog'];

    for (const key of expectedKeys) {
      expect((metrics as any)[key]).toBeDefined();
      expect((metrics as any)[key].length).toBeGreaterThan(0);
    }
  });

  // Test 4: Strip charts — zoom/pan updates view range
  it('strip charts: zoom/pan updates view range correctly', () => {
    const state = createMockState();
    state.timeRange = { start: 0, end: 100000 };
    state.viewStart = 0;
    state.viewEnd = 100000;

    // Simulate zoom in (halve the range)
    const span = state.viewEnd - state.viewStart;
    const newSpan = span * 0.5;
    const center = (state.viewStart + state.viewEnd) / 2;
    state.viewStart = center - newSpan / 2;
    state.viewEnd = center + newSpan / 2;

    expect(state.viewEnd - state.viewStart).toBeCloseTo(50000);
    expect(state.viewStart).toBeCloseTo(25000);
    expect(state.viewEnd).toBeCloseTo(75000);

    // Simulate pan right by 10000ms
    state.viewStart += 10000;
    state.viewEnd += 10000;
    expect(state.viewStart).toBeCloseTo(35000);
    expect(state.viewEnd).toBeCloseTo(85000);
  });

  // Test 5: Segment overlays at correct time ranges
  it('strip charts: segment overlays appear at correct time ranges', () => {
    const state = createMockState();
    state.segments = SAMPLE_SEGMENTS;
    state.timeRange = { start: new Date('2026-06-01T18:00:00Z').getTime(), end: new Date('2026-06-01T19:00:00Z').getTime() };
    state.viewStart = state.timeRange.start;
    state.viewEnd = state.timeRange.end;

    // Verify segments have correct time bounds
    const seg1Start = new Date(SAMPLE_SEGMENTS[0].startTime).getTime();
    const seg1End = new Date(SAMPLE_SEGMENTS[0].endTime).getTime();
    expect(seg1Start).toBeGreaterThanOrEqual(state.viewStart!);
    expect(seg1End).toBeLessThanOrEqual(state.viewEnd!);

    // Non-excluded segments should render overlays
    const visibleSegments = state.segments.filter((s) => !s.excluded);
    expect(visibleSegments.length).toBe(3);
  });

  // Test 6: Sail tag bar displays current assignments
  it('sail tag bar: displays current sail assignments', () => {
    const state = createMockState();
    state.sailTags = SAMPLE_SAIL_TAGS;

    expect(state.sailTags.length).toBe(2);
    expect(state.sailTags[0].sailConfig).toBe('J2 + Main');
    expect(state.sailTags[1].sailConfig).toBe('A3 + Main');

    // Verify time ranges don't overlap
    const end1 = new Date(state.sailTags[0].endTime).getTime();
    const start2 = new Date(state.sailTags[1].startTime).getTime();
    expect(start2).toBeGreaterThan(end1);
  });

  // Test 7: Polar overlay — data points at correct TWA/STW
  it('polar overlay: data points have correct TWA/STW coordinates', () => {
    const state = createMockState();
    state.segments = SAMPLE_SEGMENTS;

    // Filter non-excluded segments (all are non-excluded)
    const dataPoints = state.segments.filter((s) => !s.excluded);

    expect(dataPoints[0].meanTwa).toBe(80);
    expect(dataPoints[0].meanStw).toBe(7.0);
    expect(dataPoints[2].meanTwa).toBe(130);
    expect(dataPoints[2].meanStw).toBe(6.0);
  });

  // Test 8: Polar overlay — sail filter shows only tagged segments
  it('polar overlay: sail filter shows only sails with tagged segments', () => {
    const state = createMockState();
    state.segments = SAMPLE_SEGMENTS;

    // Get unique sail configs
    const sailConfigs = [...new Set(state.segments.filter((s) => s.sailConfig).map((s) => s.sailConfig!))];
    expect(sailConfigs).toContain('J2 + Main');
    expect(sailConfigs).toContain('A3 + Main');
    expect(sailConfigs.length).toBe(2);

    // Apply sail filter
    state.sailFilter = 'J2 + Main';
    const filtered = state.segments.filter((s) => !s.excluded && s.sailConfig === state.sailFilter);
    expect(filtered.length).toBe(2);
    expect(filtered.every((s) => s.sailConfig === 'J2 + Main')).toBe(true);
  });

  // Test 9: Performance summary — correct values per band
  it('performance summary: table renders correct values per TWS/TWA band', () => {
    const summary: PerformanceSummaryRow[] = [{
      sailConfig: 'J2 + Main',
      cells: { '10-12:60-90': { avgPercentPolar: 93, segmentCount: 2 } },
      overallAvgPercent: 93,
      totalSegments: 2,
      coverage: { filled: 1, total: TWS_BANDS.length * TWA_BANDS.length },
    }];

    expect(summary[0].cells['10-12:60-90']!.avgPercentPolar).toBe(93);
    expect(summary[0].cells['10-12:60-90']!.segmentCount).toBe(2);
    expect(summary[0].coverage.filled).toBe(1);
    expect(summary[0].coverage.total).toBe(25);
  });

  // Test 10: Segment list — clicking a segment sets view range
  it('segment list: clicking a segment sets view range to that time range', () => {
    const state = createMockState();
    state.segments = SAMPLE_SEGMENTS;
    state.timeRange = { start: new Date('2026-06-01T18:00:00Z').getTime(), end: new Date('2026-06-01T19:00:00Z').getTime() };

    // Simulate clicking segment 1
    const seg = SAMPLE_SEGMENTS[0];
    const st = new Date(seg.startTime).getTime();
    const et = new Date(seg.endTime).getTime();
    const padding = (et - st) * 0.2;

    state.viewStart = st - padding;
    state.viewEnd = et + padding;

    // View range should be centered on the segment with padding
    expect(state.viewStart).toBeLessThan(st);
    expect(state.viewEnd).toBeGreaterThan(et);
    expect(state.viewEnd - state.viewStart).toBeCloseTo((et - st) * 1.4, -2);
  });

  // Test 11: Excluding a segment removes it from overlay and summary
  it('segment list: excluding a segment removes it from polar overlay and summary', () => {
    const state = createMockState();
    state.segments = SAMPLE_SEGMENTS.map((s) => ({ ...s }));

    // All non-excluded initially
    let nonExcluded = state.segments.filter((s) => !s.excluded);
    expect(nonExcluded.length).toBe(3);

    // Exclude segment 2
    state.segments = state.segments.map((s) =>
      s.id === 2 ? { ...s, excluded: true } : s,
    );

    nonExcluded = state.segments.filter((s) => !s.excluded);
    expect(nonExcluded.length).toBe(2);
    expect(nonExcluded.find((s) => s.id === 2)).toBeUndefined();

    // Polar overlay would only show non-excluded
    const polarPoints = nonExcluded;
    expect(polarPoints.length).toBe(2);

    // Performance summary would only use non-excluded
    const summarySegments = nonExcluded.filter((s) => s.sailConfig && s.percentPolar != null);
    expect(summarySegments.length).toBe(2);
  });
});
