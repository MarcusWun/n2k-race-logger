/**
 * Race metadata / acquisition provenance (PRD §3.9 / BE9).
 * Mirrors RaceMetadata interface in electron/database.ts.
 */
export interface RaceMetadata {
  id: number;
  race_id: number;
  data_source: 'ngt1' | 'gofree';
  serial_port: string | null;
  h5000_ip: string | null;
  application_version: string;
  git_commit: string;
  boat_profile_id: number | null;
  polar_file: string | null;
  recording_start: string;
  recording_end: string | null;
}

/**
 * Per-race data-quality metrics (PRD §3.10 / BE10).
 * Mirrors DataQualityRow interface in electron/database.ts.
 */
export interface DataQualityRow {
  id: number;
  race_id: number;
  bsp_availability_pct: number;
  tws_availability_pct: number;
  twa_availability_pct: number;
  gps_availability_pct: number;
  largest_bsp_gap_s: number;
  largest_wind_gap_s: number;
  largest_gps_gap_s: number;
  disconnect_count: number;
  stale_data_events: number;
  invalid_pgn_count: number;
  recording_duration_s: number;
}
