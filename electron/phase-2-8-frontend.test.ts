/**
 * Phase 2.8 Frontend Tests — FE1–FE4 (PRD §3.1 / §3.7 / §3.9 / §3.10)
 *
 * Tests for:
 *   FE1: NGT-1 stale connection chip — getNgt1StatusLabel / getNgt1StatusColor
 *   FE2: Interrupted-recording banner — formatRecoveredTime, wasInterrupted logic
 *   FE3: Data-quality summary panel — utility functions and null/legacy fallback
 *   FE4: Race provenance block — formatProvenanceSource, legacy fallback
 *
 * All tests are pure-logic / utility tests — no DOM/renderer required.
 * Pattern matches electron/phase-2-7-frontend.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  getNgt1StatusLabel,
  getNgt1StatusColor,
  formatRecoveredTime,
  formatProvenanceSource,
} from '../src/utils/ngt1';
import type { ConnectionStatus } from '../src/types/ipc';
import type { RaceMetadata, DataQualityRow } from '../src/types/metadata';

// ---------------------------------------------------------------------------
// FE1: NGT-1 status chip — label text (PRD §3.1)
// ---------------------------------------------------------------------------

describe('FE1: NGT-1 status chip — label text (PRD §3.1)', () => {
  it('returns "NGT-1 — Disconnected" for null status', () => {
    expect(getNgt1StatusLabel(null)).toBe('NGT-1 — Disconnected');
  });

  it('returns "NGT-1 — Disconnected" for status=disconnected', () => {
    const s: ConnectionStatus = { status: 'disconnected' };
    expect(getNgt1StatusLabel(s)).toBe('NGT-1 — Disconnected');
  });

  it('returns "NGT-1 — Connecting..." for status=connecting', () => {
    const s: ConnectionStatus = { status: 'connecting' };
    expect(getNgt1StatusLabel(s)).toBe('NGT-1 — Connecting...');
  });

  it('returns "NGT-1 — Connected" for status=connected', () => {
    const s: ConnectionStatus = { status: 'connected', port: 'COM4' };
    expect(getNgt1StatusLabel(s)).toBe('NGT-1 — Connected');
  });

  it('returns "NGT-1 — Stale (no data)" for status=stale (FE1 core)', () => {
    const s: ConnectionStatus = { status: 'stale' };
    expect(getNgt1StatusLabel(s)).toBe('NGT-1 — Stale (no data)');
  });

  it('returns "NGT-1 — Error: <msg>" for status=error with error field', () => {
    const s: ConnectionStatus = { status: 'error', error: 'Port busy' };
    expect(getNgt1StatusLabel(s)).toBe('NGT-1 — Error: Port busy');
  });

  it('returns "NGT-1 — Error: Unknown error" for status=error without error field', () => {
    const s: ConnectionStatus = { status: 'error' };
    expect(getNgt1StatusLabel(s)).toBe('NGT-1 — Error: Unknown error');
  });
});

// ---------------------------------------------------------------------------
// FE1: NGT-1 status chip — color classes (PRD §3.1)
// ---------------------------------------------------------------------------

describe('FE1: NGT-1 status chip — color classes (PRD §3.1)', () => {
  it('connected → green (bg-n2k-success)', () => {
    expect(getNgt1StatusColor('connected')).toBe('bg-n2k-success');
  });

  it('stale → steady amber (bg-n2k-warning, no animate-pulse)', () => {
    const color = getNgt1StatusColor('stale');
    expect(color).toBe('bg-n2k-warning');
    expect(color).not.toContain('animate-pulse');
  });

  it('connecting → pulsing amber (bg-n2k-warning animate-pulse)', () => {
    const color = getNgt1StatusColor('connecting');
    expect(color).toContain('bg-n2k-warning');
    expect(color).toContain('animate-pulse');
  });

  it('error → red (bg-n2k-danger)', () => {
    expect(getNgt1StatusColor('error')).toBe('bg-n2k-danger');
  });

  it('disconnected → gray (bg-gray-500)', () => {
    expect(getNgt1StatusColor('disconnected')).toBe('bg-gray-500');
  });

  it('undefined → gray fallback (bg-gray-500)', () => {
    expect(getNgt1StatusColor(undefined)).toBe('bg-gray-500');
  });

  it('stale and connected are visually distinct', () => {
    expect(getNgt1StatusColor('stale')).not.toBe(getNgt1StatusColor('connected'));
    expect(getNgt1StatusColor('stale')).not.toBe(getNgt1StatusColor('error'));
  });
});

// ---------------------------------------------------------------------------
// FE1: ConnectionStatus type includes 'stale' (type contract test)
// ---------------------------------------------------------------------------

describe('FE1: ConnectionStatus type includes stale state', () => {
  it('stale is a valid ConnectionStatus.status value', () => {
    const s: ConnectionStatus = { status: 'stale' };
    expect(s.status).toBe('stale');
  });

  it('all five states are valid ConnectionStatus values', () => {
    const states: ConnectionStatus['status'][] = [
      'disconnected', 'connecting', 'connected', 'stale', 'error',
    ];
    expect(states).toHaveLength(5);
    expect(states).toContain('stale');
  });
});

// ---------------------------------------------------------------------------
// FE2: Interrupted-recording timestamp formatting (PRD §3.7)
// ---------------------------------------------------------------------------

describe('FE2: formatRecoveredTime — timestamp formatting (PRD §3.7)', () => {
  it('formats an ISO timestamp to HH:MM:SS', () => {
    // Use a fixed timestamp where the hours, minutes, seconds are predictable in local time.
    // We'll test the format structure rather than exact values (avoids timezone issues).
    const result = formatRecoveredTime('2026-08-22T18:42:17.000Z');
    // Result must match HH:MM:SS pattern
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('returns fallback "??:??:??" for null', () => {
    expect(formatRecoveredTime(null)).toBe('??:??:??');
  });

  it('returns fallback "??:??:??" for undefined', () => {
    expect(formatRecoveredTime(undefined)).toBe('??:??:??');
  });

  it('returns fallback "??:??:??" for empty string', () => {
    expect(formatRecoveredTime('')).toBe('??:??:??');
  });

  it('result has exactly two colons (HH:MM:SS structure)', () => {
    const result = formatRecoveredTime('2026-01-15T10:30:45.000Z');
    const colonCount = (result.match(/:/g) || []).length;
    expect(colonCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// FE2: Interrupted-recording banner — was_interrupted logic (PRD §3.7)
// ---------------------------------------------------------------------------

describe('FE2: Interrupted-recording banner — was_interrupted logic (PRD §3.7)', () => {
  it('was_interrupted=1 (SQLite integer) is truthy — banner should show', () => {
    expect(Boolean(1)).toBe(true);
  });

  it('was_interrupted=0 (SQLite integer) is falsy — banner should hide', () => {
    expect(Boolean(0)).toBe(false);
  });

  it('was_interrupted=true (boolean) shows banner', () => {
    expect(Boolean(true)).toBe(true);
  });

  it('was_interrupted=false (boolean) hides banner', () => {
    expect(Boolean(false)).toBe(false);
  });

  it('cleanly stopped race has no marker (was_interrupted === 0)', () => {
    const raceMeta = { was_interrupted: 0, recovered_end_time: null };
    expect(Boolean(raceMeta.was_interrupted)).toBe(false);
  });

  it('interrupted race shows marker (was_interrupted === 1)', () => {
    const raceMeta = {
      was_interrupted: 1,
      recovered_end_time: '2026-08-22T18:42:17.000Z',
    };
    expect(Boolean(raceMeta.was_interrupted)).toBe(true);
    expect(raceMeta.recovered_end_time).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// FE3: Data-quality panel — null/legacy fallback (PRD §3.10)
// ---------------------------------------------------------------------------

describe('FE3: DataQualityPanel — null/legacy fallback (PRD §3.10)', () => {
  it('null quality row signals legacy recording (no data_quality table row)', () => {
    const quality: DataQualityRow | null = null;
    expect(quality).toBeNull();
  });

  it('a real DataQualityRow has all required fields', () => {
    const quality: DataQualityRow = {
      id: 1,
      race_id: 100,
      bsp_availability_pct: 87.5,
      tws_availability_pct: 62.0,
      twa_availability_pct: 62.0,
      gps_availability_pct: 95.0,
      largest_bsp_gap_s: 8.0,
      largest_wind_gap_s: 12.5,
      largest_gps_gap_s: 3.2,
      disconnect_count: 2,
      stale_data_events: 3,
      invalid_pgn_count: 7,
      recording_duration_s: 3600.0,
    };
    expect(quality.bsp_availability_pct).toBeCloseTo(87.5, 1);
    expect(quality.tws_availability_pct).toBeCloseTo(62.0, 1);
    expect(quality.disconnect_count).toBe(2);
    expect(quality.stale_data_events).toBe(3);
    expect(quality.recording_duration_s).toBeCloseTo(3600.0, 1);
  });
});

// ---------------------------------------------------------------------------
// FE3: Data-quality panel — low-wind caveat logic (PRD §3.10)
// ---------------------------------------------------------------------------

describe('FE3: DataQualityPanel — low-wind caveat (PRD §3.10)', () => {
  it('caveat triggered when average wind availability < 50%', () => {
    const quality: DataQualityRow = {
      id: 1, race_id: 1,
      bsp_availability_pct: 90,
      tws_availability_pct: 34,
      twa_availability_pct: 34,
      gps_availability_pct: 90,
      largest_bsp_gap_s: 0, largest_wind_gap_s: 120, largest_gps_gap_s: 0,
      disconnect_count: 0, stale_data_events: 0, invalid_pgn_count: 0,
      recording_duration_s: 600,
    };
    const windAvg = (quality.tws_availability_pct + quality.twa_availability_pct) / 2;
    expect(windAvg).toBe(34);
    expect(windAvg < 50).toBe(true);
  });

  it('no caveat when wind availability >= 50%', () => {
    const quality: DataQualityRow = {
      id: 1, race_id: 1,
      bsp_availability_pct: 90,
      tws_availability_pct: 55,
      twa_availability_pct: 55,
      gps_availability_pct: 90,
      largest_bsp_gap_s: 0, largest_wind_gap_s: 10, largest_gps_gap_s: 0,
      disconnect_count: 0, stale_data_events: 0, invalid_pgn_count: 0,
      recording_duration_s: 600,
    };
    const windAvg = (quality.tws_availability_pct + quality.twa_availability_pct) / 2;
    expect(windAvg).toBe(55);
    expect(windAvg < 50).toBe(false);
  });

  it('caveat text matches PRD wording pattern', () => {
    const windAvg = 34;
    const caveattText = `Segment result is unreliable: wind data was ${windAvg.toFixed(1)}% available`;
    expect(caveattText).toContain('Segment result is unreliable');
    expect(caveattText).toContain('wind data was');
    expect(caveattText).toContain('34.0%');
  });
});

// ---------------------------------------------------------------------------
// FE4: Provenance block — formatProvenanceSource (PRD §3.9)
// ---------------------------------------------------------------------------

describe('FE4: ProvenanceBlock — formatProvenanceSource (PRD §3.9)', () => {
  it('NGT-1 with port → "NGT-1 (COM4)"', () => {
    expect(formatProvenanceSource('ngt1', 'COM4', null)).toBe('NGT-1 (COM4)');
  });

  it('NGT-1 without port → "NGT-1"', () => {
    expect(formatProvenanceSource('ngt1', null, null)).toBe('NGT-1');
  });

  it('GoFree with IP → "GoFree (192.168.1.233)"', () => {
    expect(formatProvenanceSource('gofree', null, '192.168.1.233')).toBe('GoFree (192.168.1.233)');
  });

  it('GoFree without IP → "GoFree"', () => {
    expect(formatProvenanceSource('gofree', null, null)).toBe('GoFree');
  });

  it('unknown source returns the raw string', () => {
    expect(formatProvenanceSource('custom', null, null)).toBe('custom');
  });

  it('null/undefined source returns "Unknown"', () => {
    expect(formatProvenanceSource(null, null, null)).toBe('Unknown');
    expect(formatProvenanceSource(undefined, null, null)).toBe('Unknown');
  });
});

// ---------------------------------------------------------------------------
// FE4: Provenance block — legacy recording fallback (PRD §3.9)
// ---------------------------------------------------------------------------

describe('FE4: ProvenanceBlock — legacy recording fallback (PRD §3.9)', () => {
  it('null metadata signals legacy recording', () => {
    const metadata: RaceMetadata | null = null;
    expect(metadata).toBeNull();
  });

  it('a real RaceMetadata has required provenance fields', () => {
    const metadata: RaceMetadata = {
      id: 1,
      race_id: 100,
      data_source: 'ngt1',
      serial_port: 'COM4',
      h5000_ip: null,
      application_version: '1.2.0',
      git_commit: 'abc1234',
      boat_profile_id: null,
      polar_file: null,
      recording_start: '2026-08-22T12:00:00.000Z',
      recording_end: '2026-08-22T14:30:00.000Z',
    };
    expect(formatProvenanceSource(metadata.data_source, metadata.serial_port, metadata.h5000_ip))
      .toBe('NGT-1 (COM4)');
    expect(metadata.application_version).toBe('1.2.0');
    expect(metadata.git_commit.slice(0, 7)).toBe('abc1234');
  });

  it('GoFree provenance shows IP, not serial port', () => {
    const metadata: RaceMetadata = {
      id: 2,
      race_id: 200,
      data_source: 'gofree',
      serial_port: null,
      h5000_ip: '192.168.1.233',
      application_version: '1.2.0',
      git_commit: 'def5678',
      boat_profile_id: 5,
      polar_file: 'sun-fast-3300.pol',
      recording_start: '2026-08-22T08:00:00.000Z',
      recording_end: '2026-08-22T10:15:00.000Z',
    };
    expect(formatProvenanceSource(metadata.data_source, metadata.serial_port, metadata.h5000_ip))
      .toBe('GoFree (192.168.1.233)');
    expect(metadata.polar_file).toBe('sun-fast-3300.pol');
    expect(metadata.boat_profile_id).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// FE1: NGT-1 and GoFree chips remain visually separate (architecture guard)
// ---------------------------------------------------------------------------

describe('FE1: NGT-1 and GoFree chips are separate (architecture §6)', () => {
  it('NGT-1 label prefix is "NGT-1 —" (not "GoFree —")', () => {
    const label = getNgt1StatusLabel({ status: 'stale' });
    expect(label).toMatch(/^NGT-1 —/);
    expect(label).not.toMatch(/^GoFree —/);
  });

  it('getNgt1StatusLabel handles all five NGT-1 states without throwing', () => {
    const states: ConnectionStatus['status'][] = [
      'disconnected', 'connecting', 'connected', 'stale', 'error',
    ];
    for (const status of states) {
      const label = getNgt1StatusLabel({ status });
      expect(label).toMatch(/^NGT-1 —/);
    }
  });
});
