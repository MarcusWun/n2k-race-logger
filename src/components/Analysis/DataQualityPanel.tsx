import React from 'react';
import type { DataQualityRow } from '../../types/metadata';

interface DataQualityPanelProps {
  quality: DataQualityRow | null;
}

/** Format an availability percentage as "87.5%" with one decimal place. */
function fmtPct(v: number): string {
  return `${v.toFixed(1)}%`;
}

/** Format a gap in seconds as "12.3 s". */
function fmtGap(v: number): string {
  return `${v.toFixed(1)} s`;
}

/** Format seconds as "1h 23m 45s" or "23m 45s" or "45s". */
function fmtDuration(totalS: number): string {
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const s = Math.floor(totalS % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Color class for an availability percentage pill. */
function availColor(pct: number): string {
  if (pct >= 80) return 'text-green-400';
  if (pct >= 50) return 'text-yellow-400';
  return 'text-red-400';
}

/**
 * FE3 — Per-race data-quality summary panel (PRD §3.10).
 *
 * Displays availability %, largest gaps, disconnect counters, and recording duration.
 * If wind availability < 50%, shows a caveat per PRD wording.
 * Legacy races (no data_quality row): shows a one-line fallback.
 */
export default function DataQualityPanel({ quality }: DataQualityPanelProps) {
  if (!quality) {
    return (
      <div className="text-gray-500 text-xs italic py-2" data-testid="quality-unavailable">
        Data quality unavailable for this recording.
      </div>
    );
  }

  const windAvg = (quality.tws_availability_pct + quality.twa_availability_pct) / 2;
  const lowWindCaveat = windAvg < 50;

  return (
    <div className="flex flex-col gap-3 text-xs" data-testid="quality-panel">
      {/* Caveat for low-quality data */}
      {lowWindCaveat && (
        <div
          className="bg-yellow-900/40 border border-yellow-700/60 rounded px-2 py-1 text-yellow-300"
          data-testid="quality-wind-caveat"
        >
          Segment result is unreliable: wind data was{' '}
          {fmtPct(windAvg)} available
        </div>
      )}

      {/* Availability % */}
      <div>
        <div className="text-gray-400 uppercase tracking-wider mb-1 text-[10px]">Availability</div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-0.5">
          {[
            { label: 'BSP', value: quality.bsp_availability_pct },
            { label: 'TWS', value: quality.tws_availability_pct },
            { label: 'TWA', value: quality.twa_availability_pct },
            { label: 'GPS', value: quality.gps_availability_pct },
          ].map(({ label, value }) => (
            <div key={label} className="flex justify-between">
              <span className="text-gray-400">{label}</span>
              <span className={availColor(value)} data-testid={`avail-${label.toLowerCase()}`}>
                {fmtPct(value)}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Largest gaps */}
      <div>
        <div className="text-gray-400 uppercase tracking-wider mb-1 text-[10px]">Largest gaps</div>
        <div className="grid grid-cols-1 gap-y-0.5">
          {[
            { label: 'BSP gap', value: quality.largest_bsp_gap_s, testid: 'gap-bsp' },
            { label: 'Wind gap', value: quality.largest_wind_gap_s, testid: 'gap-wind' },
            { label: 'GPS gap', value: quality.largest_gps_gap_s, testid: 'gap-gps' },
          ].map(({ label, value, testid }) => (
            <div key={label} className="flex justify-between">
              <span className="text-gray-400">{label}</span>
              <span className="text-white" data-testid={testid}>{fmtGap(value)}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Counters */}
      <div>
        <div className="text-gray-400 uppercase tracking-wider mb-1 text-[10px]">Events</div>
        <div className="grid grid-cols-1 gap-y-0.5">
          <div className="flex justify-between">
            <span className="text-gray-400">Disconnects</span>
            <span className="text-white" data-testid="counter-disconnects">{quality.disconnect_count}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Stale events</span>
            <span className="text-white" data-testid="counter-stale">{quality.stale_data_events}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Invalid PGNs</span>
            <span className="text-white" data-testid="counter-invalid-pgn">{quality.invalid_pgn_count}</span>
          </div>
        </div>
      </div>

      {/* Duration */}
      <div className="flex justify-between border-t border-gray-800 pt-2">
        <span className="text-gray-400">Recording duration</span>
        <span className="text-white" data-testid="recording-duration">
          {fmtDuration(quality.recording_duration_s)}
        </span>
      </div>
    </div>
  );
}
