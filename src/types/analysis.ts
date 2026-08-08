/** Phase 2 — Analysis types for segment detection, sail tagging, and performance analysis. */

export interface TimeSeriesPoint {
  time: number; // Unix ms
  value: number | null;
}

export type WindSide = 'port' | 'starboard' | 'centerline';

export interface TimeSeries {
  tws: TimeSeriesPoint[];
  twa: TimeSeriesPoint[];
  twaSide?: Array<{ time: number; value: WindSide | null }>;
  twd: TimeSeriesPoint[];
  stw: TimeSeriesPoint[];
  aws: TimeSeriesPoint[];
  awa: TimeSeriesPoint[];
  awaSide?: Array<{ time: number; value: WindSide | null }>;
  heading: TimeSeriesPoint[];
  sog: TimeSeriesPoint[];
  cog: TimeSeriesPoint[];
}

export interface AnalysisData {
  metrics: TimeSeries;
  timeRange: { start: number; end: number };
}

export interface SegmentThresholds {
  tws: number;  // ± kts (default 1.5)
  twa: number;  // ± degrees (default 10)
  stw: number;  // ± kts (default 0.5)
  minDuration: number; // seconds (default 60)
}

export const DEFAULT_THRESHOLDS: SegmentThresholds = {
  tws: 1.5,
  twa: 10,
  stw: 0.5,
  minDuration: 60,
};

export interface DetectedSegment {
  id: number;
  raceId: number;
  startTime: string; // ISO timestamp
  endTime: string;
  durationS: number;
  meanTws: number;
  meanTwa: number;
  meanStw: number;
  meanVmg: number; // knots — STW × cos(TWA); positive = toward wind, negative = away from wind
  stdTws: number;
  stdTwa: number;
  stdStw: number;
  percentPolar: number | null;
  sailConfig: string | null;
  excluded: boolean;
  thresholds: SegmentThresholds;
}

export interface SailTag {
  id?: number;
  raceId: number;
  sailConfig: string;
  startTime: string; // ISO timestamp
  endTime: string;
}

export interface SailInventoryItem {
  id: string;
  label: string;
}

export interface RaceFileInfo {
  path: string;
  label: string | null;
  date: string;
  startTime?: string | null; // ISO8601 wall-clock start time
  duration: number; // seconds
  points: number;
  size: number; // bytes
}

export interface PerformanceCell {
  avgPercentPolar: number;
  segmentCount: number;
}

export interface PerformanceSummaryRow {
  sailConfig: string;
  cells: Record<string, PerformanceCell | null>; // key: "tws_lo-tws_hi:twa_lo-twa_hi"
  overallAvgPercent: number;
  totalSegments: number;
  coverage: { filled: number; total: number };
}

// TWS and TWA bands for performance summary table
export const TWS_BANDS: [number, number][] = [
  [6, 8], [8, 10], [10, 12], [12, 16], [16, 20],
];

export const TWA_BANDS: [number, number][] = [
  [40, 60], [60, 90], [90, 120], [120, 150], [150, 180],
];
