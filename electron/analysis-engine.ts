/**
 * Phase 2 — Analysis Engine
 * Runs in Electron main process. Handles:
 * - Data reconstruction from raw PGN rows (unit conversions, true wind computation, resampling)
 * - Steady-state segment detection via sliding window
 * - Performance aggregation by sail config and TWS/TWA bands
 */

import type { PolarTable } from './polar-engine';
import { normalizeWindAngle, normalizeWindAngleValue, type WindSide } from './wind-utils';

// Unit conversion constants (same as Dashboard.tsx)
const MS_TO_KTS = 1.94384;
const RAD_TO_DEG = 180 / Math.PI;

// --- Types ---

export interface TimeSeriesPoint {
  time: number; // Unix ms
  value: number | null;
}

export interface TimeSeries {
  tws: TimeSeriesPoint[];
  twa: TimeSeriesPoint[];
  /** Port/starboard context for normalized TWA. */
  twaSide: Array<{ time: number; value: WindSide | null }>;
  twd: TimeSeriesPoint[];
  stw: TimeSeriesPoint[];
  aws: TimeSeriesPoint[];
  awa: TimeSeriesPoint[];
  /** Port/starboard context for normalized AWA. */
  awaSide: Array<{ time: number; value: WindSide | null }>;
  heading: TimeSeriesPoint[];
  sog: TimeSeriesPoint[];
  cog: TimeSeriesPoint[];
}

export interface SegmentThresholds {
  tws: number;
  twa: number;
  stw: number;
  minDuration: number;
}

export interface DetectedSegmentData {
  startTime: number; // Unix ms
  endTime: number;
  durationS: number;
  meanTws: number;
  meanTwa: number;
  meanStw: number;
  stdTws: number;
  stdTwa: number;
  stdStw: number;
  percentPolar: number | null;
  sailConfig: string | null;
}

export interface SailTagData {
  sailConfig: string;
  startTime: number; // Unix ms
  endTime: number;
}

export interface PerformanceCell {
  avgPercentPolar: number;
  segmentCount: number;
}

export interface PerformanceSummaryRow {
  sailConfig: string;
  cells: Record<string, PerformanceCell | null>;
  overallAvgPercent: number;
  totalSegments: number;
  coverage: { filled: number; total: number };
}

// --- Data Reconstruction ---

interface RawPGNRow {
  timestamp: string;
  pgn: number;
  data: string; // JSON
}

/** Compute true wind from apparent wind and boat speed (all in knots/degrees). */
function computeTrueWind(awsKts: number, awaDeg: number, stwKts: number): { tws: number; twa: number } {
  const awaRad = (awaDeg * Math.PI) / 180;
  const u = awsKts * Math.sin(awaRad);
  const v = awsKts * Math.cos(awaRad) - stwKts;
  const tws = Math.sqrt(u * u + v * v);
  const twaRad = Math.atan2(u, v);
  const twaDeg = ((twaRad * RAD_TO_DEG) % 360 + 360) % 360;
  return { tws, twa: twaDeg };
}

/**
 * Reconstruct time-series data from raw PGN rows.
 * Applies same unit conversions and true wind computation as the live dashboard.
 */
export function reconstructTimeSeries(rows: RawPGNRow[]): TimeSeries {
  // Accumulate raw values keyed by timestamp
  const rawPoints: Map<number, Record<string, number>> = new Map();

  for (const row of rows) {
    const ts = new Date(row.timestamp).getTime();
    if (isNaN(ts)) continue;

    let fields: Record<string, any>;
    try {
      fields = JSON.parse(row.data);
    } catch {
      continue;
    }

    if (!rawPoints.has(ts)) {
      rawPoints.set(ts, {});
    }
    const point = rawPoints.get(ts)!;

    switch (row.pgn) {
      case 128259: // Speed - Water Referenced
        if (fields.speedWaterReferenced != null) {
          point.stw = Number(fields.speedWaterReferenced) * MS_TO_KTS;
        }
        break;

      case 129026: // COG & SOG
        if (fields.sogWaterReferenced != null || fields.sog != null) {
          point.sog = Number(fields.sogWaterReferenced ?? fields.sog) * MS_TO_KTS;
        }
        if (fields.cogWaterReferenced != null || fields.cog != null) {
          point.cog = Number(fields.cogWaterReferenced ?? fields.cog) * RAD_TO_DEG;
        }
        break;

      case 130306: { // Wind Data
        const speedKts = fields.windSpeed != null ? Number(fields.windSpeed) * MS_TO_KTS : null;
        const angleDeg = fields.windAngle != null ? Number(fields.windAngle) * RAD_TO_DEG : null;
        const ref = fields.reference ?? fields.windReference;

        if (ref === 'Apparent') {
          if (speedKts != null) point.aws = speedKts;
          // Keep raw PGN JSON untouched in SQLite, but normalize reconstructed
          // display/analysis values to match TWA semantics.
          if (angleDeg != null) point.awa = angleDeg;
        } else if (ref === 'True (boat referenced)' || ref === 'True (water referenced)') {
          if (speedKts != null) point.tws_direct = speedKts;
          if (angleDeg != null) point.twa_direct = angleDeg;
        } else if (ref === 'True (ground referenced to North)' || ref === 'Magnetic (ground referenced to Magnetic North)') {
          if (speedKts != null) point.tws_direct = speedKts;
          if (angleDeg != null) point.twd_direct = angleDeg;
        }
        break;
      }

      case 127250: // Vessel Heading
        {
          const heading = fields.heading ?? fields.headingMagnetic ?? fields.headingTrue;
          if (heading != null) {
            point.heading = Number(heading) * RAD_TO_DEG;
          }
        }
        break;

      case 129025: // Position
        // Not needed for analysis metrics but included for completeness
        break;
    }
  }

  // Sort by time
  const sortedTimes = Array.from(rawPoints.keys()).sort((a, b) => a - b);

  // Build per-metric arrays, computing true wind where needed
  const result: TimeSeries = {
    tws: [], twa: [], twaSide: [], twd: [], stw: [],
    aws: [], awa: [], awaSide: [], heading: [], sog: [], cog: [],
  };

  // Track last known values for interpolation of computed fields
  let lastAws: number | null = null;
  let lastAwa: number | null = null;
  let lastStw: number | null = null;
  let lastHeading: number | null = null;
  let lastSog: number | null = null;

  for (const ts of sortedTimes) {
    const p = rawPoints.get(ts)!;

    // Update last known values
    if (p.aws != null) lastAws = p.aws;
    if (p.awa != null) lastAwa = p.awa;
    if (p.stw != null) lastStw = p.stw;
    if (p.heading != null) lastHeading = p.heading;
    if (p.sog != null) lastSog = p.sog;

    // STW, SOG, COG, heading — direct from PGN
    result.stw.push({ time: ts, value: p.stw ?? lastStw });
    result.sog.push({ time: ts, value: p.sog ?? lastSog });
    result.cog.push({ time: ts, value: p.cog ?? null });
    result.heading.push({ time: ts, value: p.heading ?? lastHeading });
    result.aws.push({ time: ts, value: p.aws ?? lastAws });

    const rawAwa = p.awa ?? lastAwa;
    const normalizedAwa = normalizeWindAngleValue(rawAwa);
    result.awa.push({ time: ts, value: normalizedAwa });
    result.awaSide.push({ time: ts, value: rawAwa != null ? normalizeWindAngle(rawAwa).side : null });

    // True wind: prefer direct PGN values, fall back to computed
    let tws: number | null = p.tws_direct ?? null;
    let twa: number | null = p.twa_direct ?? null;
    let twd: number | null = p.twd_direct ?? null;

    if (tws == null || twa == null) {
      // Compute from apparent wind
      const aws = p.aws ?? lastAws;
      const awa = p.awa ?? lastAwa;
      const stw = p.stw ?? lastStw ?? lastSog ?? 0;
      if (aws != null && awa != null) {
        // computeTrueWind needs the raw 0..360 angle to preserve side before
        // final normalization.
        const tw = computeTrueWind(aws, awa, stw);
        if (tws == null) tws = tw.tws;
        if (twa == null) twa = tw.twa;
      }
    }

    if (twd == null && twa != null) {
      const heading = p.heading ?? lastHeading;
      if (heading != null) {
        twd = (heading + twa) % 360;
      }
    }

    // Normalize TWA to 0–180° (port/starboard side tracked separately).
    const normalizedTwa = normalizeWindAngleValue(twa);

    result.tws.push({ time: ts, value: tws });
    result.twa.push({ time: ts, value: normalizedTwa });
    result.twaSide.push({ time: ts, value: twa != null ? normalizeWindAngle(twa).side : null });
    result.twd.push({ time: ts, value: twd });
  }

  return result;
}

/**
 * Resample a time series to a uniform 1-second grid.
 * Gaps >= 5 seconds produce null values (rendered as breaks).
 */
export function resampleToGrid(series: TimeSeriesPoint[], startMs: number, endMs: number): TimeSeriesPoint[] {
  if (series.length === 0) return [];

  const result: TimeSeriesPoint[] = [];
  let srcIdx = 0;

  for (let t = startMs; t <= endMs; t += 1000) {
    // Advance srcIdx to the point just before or at t
    while (srcIdx < series.length - 1 && series[srcIdx + 1].time <= t) {
      srcIdx++;
    }

    // Find surrounding points for interpolation
    const before = series[srcIdx];
    const after = srcIdx < series.length - 1 ? series[srcIdx + 1] : null;

    if (before.value == null) {
      result.push({ time: t, value: null });
      continue;
    }

    if (after == null || after.value == null) {
      // Beyond last data point or next is null
      const gap = t - before.time;
      result.push({ time: t, value: gap < 5000 ? before.value : null });
      continue;
    }

    const gap = after.time - before.time;
    if (gap >= 5000) {
      // Large gap — produce null (break in the line)
      result.push({ time: t, value: null });
      continue;
    }

    // Linear interpolation
    const frac = (t - before.time) / gap;
    const interpolated = before.value + frac * (after.value - before.value);
    result.push({ time: t, value: interpolated });
  }

  return result;
}

// --- Segment Detection ---

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stddev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  const variance = values.reduce((s, v) => s + (v - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

interface QualifyingWindow {
  startIdx: number;
  endIdx: number;
}

/**
 * Detect steady-state segments from resampled time series.
 * Uses a sliding window approach.
 */
export function detectSegments(
  tws: TimeSeriesPoint[],
  twa: TimeSeriesPoint[],
  stw: TimeSeriesPoint[],
  thresholds: SegmentThresholds,
): DetectedSegmentData[] {
  if (tws.length === 0 || twa.length === 0 || stw.length === 0) return [];

  const n = Math.min(tws.length, twa.length, stw.length);
  const minWindowSize = thresholds.minDuration; // 1 point per second on resampled grid

  // Step 1: Find all qualifying windows of minDuration length
  const qualifying: QualifyingWindow[] = [];
  const twsThresh = thresholds.tws * 2; // range threshold (±threshold → total spread = 2×)
  const twaThresh = thresholds.twa * 2;
  const stwThresh = thresholds.stw * 2;

  for (let start = 0; start <= n - minWindowSize; start++) {
    // Check if window [start, start+minWindowSize) qualifies
    let twsMin = Infinity, twsMax = -Infinity;
    let twaMin = Infinity, twaMax = -Infinity;
    let stwMin = Infinity, stwMax = -Infinity;
    let valid = true;

    for (let i = start; i < start + minWindowSize; i++) {
      if (tws[i].value == null || twa[i].value == null || stw[i].value == null) {
        valid = false;
        break;
      }
      const tv = tws[i].value!;
      const av = twa[i].value!;
      const sv = stw[i].value!;
      if (tv < twsMin) twsMin = tv;
      if (tv > twsMax) twsMax = tv;
      if (av < twaMin) twaMin = av;
      if (av > twaMax) twaMax = av;
      if (sv < stwMin) stwMin = sv;
      if (sv > stwMax) stwMax = sv;
    }

    if (!valid) continue;

    if (twsMax - twsMin <= twsThresh &&
        twaMax - twaMin <= twaThresh &&
        stwMax - stwMin <= stwThresh) {
      qualifying.push({ startIdx: start, endIdx: start + minWindowSize - 1 });
    }
  }

  if (qualifying.length === 0) return [];

  // Step 2: Merge overlapping/adjacent qualifying windows
  const merged: QualifyingWindow[] = [{ ...qualifying[0] }];
  for (let i = 1; i < qualifying.length; i++) {
    const last = merged[merged.length - 1];
    const curr = qualifying[i];
    // Merge if overlapping or gap < 10 seconds (10 indices on 1s grid)
    if (curr.startIdx <= last.endIdx + 10) {
      last.endIdx = Math.max(last.endIdx, curr.endIdx);
    } else {
      merged.push({ ...curr });
    }
  }

  // Step 3: Extract segments with stats
  const segments: DetectedSegmentData[] = [];

  for (const win of merged) {
    const twsVals: number[] = [];
    const twaVals: number[] = [];
    const stwVals: number[] = [];

    for (let i = win.startIdx; i <= win.endIdx; i++) {
      if (tws[i].value != null && twa[i].value != null && stw[i].value != null) {
        twsVals.push(tws[i].value!);
        twaVals.push(twa[i].value!);
        stwVals.push(stw[i].value!);
      }
    }

    if (twsVals.length === 0) continue;

    const meanStw = mean(stwVals);

    // Exclusion: discard segments with mean STW < 1.0 kts
    if (meanStw < 1.0) continue;

    const meanTws = mean(twsVals);
    const meanTwa = mean(twaVals);
    const durationS = (tws[win.endIdx].time - tws[win.startIdx].time) / 1000;

    segments.push({
      startTime: tws[win.startIdx].time,
      endTime: tws[win.endIdx].time,
      durationS,
      meanTws,
      meanTwa,
      meanStw,
      stdTws: stddev(twsVals, meanTws),
      stdTwa: stddev(twaVals, meanTwa),
      stdStw: stddev(stwVals, meanStw),
      percentPolar: null,
      sailConfig: null,
    });
  }

  return segments;
}

// --- Sail Tag Assignment ---

/**
 * Assign sail config to segments based on overlapping sail tags.
 */
export function assignSailTags(
  segments: DetectedSegmentData[],
  sailTags: SailTagData[],
): DetectedSegmentData[] {
  return segments.map((seg) => {
    const matching = sailTags.find(
      (tag) => tag.startTime <= seg.startTime && tag.endTime >= seg.endTime,
    );
    return { ...seg, sailConfig: matching?.sailConfig ?? null };
  });
}

// --- Polar Performance ---

/**
 * Compute % of polar for each segment using the polar table.
 * Uses the same bilinear interpolation as polar-engine.ts.
 */
export function computeSegmentPerformance(
  segments: DetectedSegmentData[],
  polarTable: PolarTable | null,
): DetectedSegmentData[] {
  if (!polarTable) return segments;

  return segments.map((seg) => {
    const targetSpeed = interpolateSpeed(polarTable, seg.meanTws, seg.meanTwa);
    if (targetSpeed == null || targetSpeed === 0) {
      return { ...seg, percentPolar: null };
    }
    return { ...seg, percentPolar: Math.round((seg.meanStw / targetSpeed) * 100) };
  });
}

/** Bilinear interpolation — mirrors PolarEngine.interpolateSpeed. */
export function interpolateSpeed(table: PolarTable, tws: number, twa: number): number | null {
  if (isNaN(tws) || isNaN(twa) || tws <= 0 || twa <= 0) return null;

  const minTWS = table.tws[0];
  const maxTWS = table.tws[table.tws.length - 1];
  if (tws < minTWS || tws > maxTWS) return null;

  const minTWA = table.twa[0];
  const maxTWA = table.twa[table.twa.length - 1];
  twa = Math.max(minTWA, Math.min(maxTWA, twa));

  let twsLow = 0;
  while (twsLow < table.tws.length - 1 && table.tws[twsLow + 1] <= tws) twsLow++;
  const twsHigh = Math.min(twsLow + 1, table.tws.length - 1);

  let twaLow = 0;
  while (twaLow < table.twa.length - 1 && table.twa[twaLow + 1] <= twa) twaLow++;
  const twaHigh = Math.min(twaLow + 1, table.twa.length - 1);

  const tws0 = table.tws[twsLow];
  const tws1 = table.tws[twsHigh];
  const twa0 = table.twa[twaLow];
  const twa1 = table.twa[twaHigh];

  const v00 = table.speeds[twsLow]?.[twaLow] ?? 0;
  const v01 = table.speeds[twsLow]?.[twaHigh] ?? 0;
  const v10 = table.speeds[twsHigh]?.[twaLow] ?? 0;
  const v11 = table.speeds[twsHigh]?.[twaHigh] ?? 0;

  if (twsLow === twsHigh) {
    if (twaLow === twaHigh) return v00;
    const t = (twa - twa0) / (twa1 - twa0);
    return Math.round((v00 * (1 - t) + v01 * t) * 100) / 100;
  }
  if (twaLow === twaHigh) {
    const t = (tws - tws0) / (tws1 - tws0);
    return Math.round((v00 * (1 - t) + v10 * t) * 100) / 100;
  }

  const tTWS = (tws - tws0) / (tws1 - tws0);
  const tTWA = (twa - twa0) / (twa1 - twa0);
  const edge0 = v00 * (1 - tTWA) + v01 * tTWA;
  const edge1 = v10 * (1 - tTWA) + v11 * tTWA;
  const result = edge0 * (1 - tTWS) + edge1 * tTWS;
  return Math.round(result * 100) / 100;
}

// --- Performance Aggregation ---

const TWS_BANDS: [number, number][] = [
  [6, 8], [8, 10], [10, 12], [12, 16], [16, 20],
];

const TWA_BANDS: [number, number][] = [
  [40, 60], [60, 90], [90, 120], [120, 150], [150, 180],
];

function bandKey(twsBand: [number, number], twaBand: [number, number]): string {
  return `${twsBand[0]}-${twsBand[1]}:${twaBand[0]}-${twaBand[1]}`;
}

/**
 * Aggregate segments into performance summary by sail × TWS/TWA band.
 */
export function aggregatePerformance(
  segments: DetectedSegmentData[],
): PerformanceSummaryRow[] {
  // Group non-excluded segments by sail config
  const bySail: Map<string, DetectedSegmentData[]> = new Map();
  for (const seg of segments) {
    if (seg.sailConfig == null || seg.percentPolar == null) continue;
    const key = seg.sailConfig;
    if (!bySail.has(key)) bySail.set(key, []);
    bySail.get(key)!.push(seg);
  }

  const totalCells = TWS_BANDS.length * TWA_BANDS.length;
  const rows: PerformanceSummaryRow[] = [];

  for (const [sail, segs] of bySail) {
    const cells: Record<string, PerformanceCell | null> = {};
    let filledCount = 0;
    let totalPercent = 0;
    let totalCount = 0;

    for (const twsBand of TWS_BANDS) {
      for (const twaBand of TWA_BANDS) {
        const key = bandKey(twsBand, twaBand);
        const matching = segs.filter(
          (s) =>
            s.meanTws >= twsBand[0] && s.meanTws < twsBand[1] &&
            s.meanTwa >= twaBand[0] && s.meanTwa < twaBand[1] &&
            s.percentPolar != null,
        );

        if (matching.length > 0) {
          const avg = mean(matching.map((s) => s.percentPolar!));
          cells[key] = { avgPercentPolar: Math.round(avg), segmentCount: matching.length };
          filledCount++;
          totalPercent += avg * matching.length;
          totalCount += matching.length;
        } else {
          cells[key] = null;
        }
      }
    }

    rows.push({
      sailConfig: sail,
      cells,
      overallAvgPercent: totalCount > 0 ? Math.round(totalPercent / totalCount) : 0,
      totalSegments: totalCount,
      coverage: { filled: filledCount, total: totalCells },
    });
  }

  return rows;
}
