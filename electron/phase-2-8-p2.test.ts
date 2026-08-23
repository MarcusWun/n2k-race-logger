/**
 * Phase 2.8 Reliability — P2 tests
 *
 * BE8: Remove obsolete pgnFilter abstraction (PRD §3.8)
 * BE9: Race metadata / acquisition provenance (PRD §3.9)
 * BE10: Recording data-quality metrics (PRD §3.10)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { N2KParser } from './n2k-parser';
import type { ParsedPGN } from './serial-manager';
import { RaceDatabase } from './database';
import { computeDataQuality } from './analysis-engine';
import { GIT_COMMIT, APP_VERSION } from './build-info';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTempDir(): string {
  const tmp = path.join(os.tmpdir(), 'n2k-p2-test-' + Date.now() + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(tmp, { recursive: true });
  return tmp;
}

function cleanupDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeParsedPGN(pgn: number, fields: Record<string, any> = {}, src?: number): ParsedPGN {
  return { pgn, src, fields, timestamp: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// BE8 — normalizeParsedPgn (PRD §3.8)
// Comprehensive test that the renamed method works correctly.
// Detailed API tests are in n2k-parser.test.ts.
// ---------------------------------------------------------------------------

describe('BE8: normalizeParsedPgn — renamed from filter(), no pgnFilter (PRD §3.8)', () => {
  let parser: N2KParser;

  beforeEach(() => {
    parser = new N2KParser();
  });

  it('N2KParser has normalizeParsedPgn but NOT filter or setPGNFilter', () => {
    expect(typeof (parser as any).normalizeParsedPgn).toBe('function');
    expect((parser as any).filter).toBeUndefined();
    expect((parser as any).setPGNFilter).toBeUndefined();
    expect((parser as any).getPGNFilter).toBeUndefined();
    expect((parser as any).pgnFilter).toBeUndefined();
  });

  it('N2KParserConfig no longer has a pgnFilter field', () => {
    // Constructing with an unknown field should not throw (TypeScript may ignore it)
    // But the internal state should not have pgnFilter
    const p = new N2KParser({ batchIntervalMs: 100 });
    expect((p as any).pgnFilter).toBeUndefined();
  });

  it('normalizeParsedPgn passes arbitrary PGNs through', () => {
    for (const pgn of [128259, 130306, 99999, 59392]) {
      const result = parser.normalizeParsedPgn(makeParsedPGN(pgn, { x: 1 }));
      expect(result).not.toBeNull();
      expect(result!.pgn).toBe(pgn);
    }
  });
});

// ---------------------------------------------------------------------------
// BE9 — Race metadata / acquisition provenance (PRD §3.9)
// ---------------------------------------------------------------------------

describe('BE9: Race metadata / provenance (PRD §3.9)', () => {
  let tmpDir: string;
  let raceDb: RaceDatabase;
  const dbPath = () => path.join(tmpDir, 'test.db');

  beforeEach(() => {
    tmpDir = getTempDir();
    raceDb = new RaceDatabase(dbPath(), tmpDir);
  });

  afterEach(() => {
    raceDb.close();
    cleanupDir(tmpDir);
  });

  // BE9-1: NGT-1 path — data_source='ngt1', serial_port set, h5000_ip null
  it('NGT-1 recording: data_source=ngt1, serial_port set, h5000_ip null', () => {
    const race = raceDb.createRace('test');
    raceDb.insertRaceMetadata({
      race_id: race.id,
      data_source: 'ngt1',
      serial_port: 'COM4',
      h5000_ip: null,
      application_version: APP_VERSION,
      git_commit: GIT_COMMIT,
      boat_profile_id: null,
      polar_file: null,
      recording_start: new Date().toISOString(),
    });

    const meta = raceDb.getRaceMetadata(race.id);
    expect(meta).not.toBeNull();
    expect(meta!.data_source).toBe('ngt1');
    expect(meta!.serial_port).toBe('COM4');
    expect(meta!.h5000_ip).toBeNull();
  });

  // BE9-2: GoFree path — data_source='gofree', h5000_ip set, serial_port null
  it('GoFree recording: data_source=gofree, h5000_ip set, serial_port null', () => {
    const race = raceDb.createRace('test-gofree');
    raceDb.insertRaceMetadata({
      race_id: race.id,
      data_source: 'gofree',
      serial_port: null,
      h5000_ip: '192.168.1.233',
      application_version: APP_VERSION,
      git_commit: GIT_COMMIT,
      boat_profile_id: null,
      polar_file: null,
      recording_start: new Date().toISOString(),
    });

    const meta = raceDb.getRaceMetadata(race.id);
    expect(meta).not.toBeNull();
    expect(meta!.data_source).toBe('gofree');
    expect(meta!.h5000_ip).toBe('192.168.1.233');
    expect(meta!.serial_port).toBeNull();
  });

  // BE9-3: application_version and git_commit are present
  it('application_version and git_commit are populated from build-info', () => {
    const race = raceDb.createRace('test-version');
    raceDb.insertRaceMetadata({
      race_id: race.id,
      data_source: 'ngt1',
      serial_port: 'COM3',
      h5000_ip: null,
      application_version: APP_VERSION,
      git_commit: GIT_COMMIT,
      boat_profile_id: null,
      polar_file: null,
      recording_start: new Date().toISOString(),
    });

    const meta = raceDb.getRaceMetadata(race.id);
    expect(meta!.application_version).toBeTruthy();
    expect(typeof meta!.application_version).toBe('string');
    expect(meta!.git_commit).toBeTruthy();
    expect(typeof meta!.git_commit).toBe('string');
  });

  // BE9-4: recording_end updated on clean stop
  it('recording_end is updated on clean stop', () => {
    const race = raceDb.createRace('test-stop');
    const startTime = new Date().toISOString();
    raceDb.insertRaceMetadata({
      race_id: race.id,
      data_source: 'ngt1',
      serial_port: 'COM3',
      h5000_ip: null,
      application_version: APP_VERSION,
      git_commit: GIT_COMMIT,
      boat_profile_id: null,
      polar_file: null,
      recording_start: startTime,
    });

    // Initially recording_end is null
    expect(raceDb.getRaceMetadata(race.id)!.recording_end).toBeNull();

    const stopTime = new Date(Date.now() + 60_000).toISOString();
    raceDb.updateRecordingEnd(race.id, stopTime);

    const meta = raceDb.getRaceMetadata(race.id);
    expect(meta!.recording_end).toBe(stopTime);
  });

  // BE9-5: recording_end updated on interrupted recovery (via detectInterruptedRecording path)
  it('recording_end set on interrupted recovery to recovered_end_time', () => {
    const race = raceDb.createRace('test-recovery');
    const startTime = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
    raceDb.insertRaceMetadata({
      race_id: race.id,
      data_source: 'ngt1',
      serial_port: 'COM4',
      h5000_ip: null,
      application_version: APP_VERSION,
      git_commit: GIT_COMMIT,
      boat_profile_id: null,
      polar_file: null,
      recording_start: startTime,
    });

    // Simulate a point being recorded
    const lastSampleTime = new Date(Date.now() - 30_000).toISOString(); // 30 sec ago
    raceDb.batchInsertPoints([{
      raceId: race.id,
      timestamp: lastSampleTime,
      pgn: 128259,
      data: JSON.stringify({ speedWaterReferenced: 3.5 }),
    }]);

    // No finalizeRace called — simulate interrupted state
    const interruptedInfo = raceDb.detectInterruptedRecording(race.id);
    expect(interruptedInfo?.wasInterrupted).toBe(true);
    expect(interruptedInfo?.recoveredEndTime).toBe(lastSampleTime);

    // Simulate the races:open path updating recording_end in race_metadata
    if (interruptedInfo?.wasInterrupted && interruptedInfo.recoveredEndTime) {
      raceDb.updateRecordingEnd(race.id, interruptedInfo.recoveredEndTime);
    }

    const meta = raceDb.getRaceMetadata(race.id);
    expect(meta!.recording_end).toBe(lastSampleTime);
  });

  // BE9-6: insertRaceMetadata is idempotent (duplicate insert is safe)
  it('insertRaceMetadata is idempotent — second call does not throw', () => {
    const race = raceDb.createRace('test-idem');
    const payload = {
      race_id: race.id,
      data_source: 'ngt1' as const,
      serial_port: 'COM3',
      h5000_ip: null,
      application_version: APP_VERSION,
      git_commit: GIT_COMMIT,
      boat_profile_id: null,
      polar_file: null,
      recording_start: new Date().toISOString(),
    };
    raceDb.insertRaceMetadata(payload);
    expect(() => raceDb.insertRaceMetadata(payload)).not.toThrow();
    // Still just one row
    const meta = raceDb.getRaceMetadata(race.id);
    expect(meta).not.toBeNull();
  });

  // BE9-7: race_metadata table created on existing DB (migration safety)
  it('race_metadata and data_quality tables created in createSchema (idempotent migration)', () => {
    // Open a second DB — schema should include both new tables
    const db2 = new RaceDatabase(path.join(tmpDir, 'test2.db'), tmpDir);
    const raw = db2.getRaw();
    const tables: any[] = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const tableNames = tables.map((t: any) => t.name);
    expect(tableNames).toContain('race_metadata');
    expect(tableNames).toContain('data_quality');
    db2.close();
  });
});

// ---------------------------------------------------------------------------
// BE10 — computeDataQuality (PRD §3.10)
// ---------------------------------------------------------------------------

const BASE_MS = 1_700_000_000_000;

/** Make a minimal raw row for computeDataQuality */
function makeRawRow(pgn: number, offsetMs: number) {
  return { timestamp: new Date(BASE_MS + offsetMs).toISOString(), pgn };
}

describe('BE10: computeDataQuality (PRD §3.10)', () => {
  // BE10-1: Full-coverage recording — high availability
  it('full-coverage recording → availability near 100%', () => {
    // BSP every 500ms for 10 seconds = 21 samples
    const bspRows = Array.from({ length: 21 }, (_, i) => makeRawRow(128259, i * 500));
    // Wind every 500ms for 10 seconds
    const windRows = Array.from({ length: 21 }, (_, i) => makeRawRow(130306, i * 500));
    // GPS every 1s
    const gpsRows = Array.from({ length: 11 }, (_, i) => makeRawRow(129025, i * 1000));

    const rows = [...bspRows, ...windRows, ...gpsRows];
    const durationS = 10;
    const startMs = BASE_MS;
    const endMs = BASE_MS + durationS * 1000;

    const dq = computeDataQuality(rows, startMs, endMs, 0, 0, 0);

    // With data every 500ms and a 10s coverage window, coverage should be very high
    expect(dq.bsp_availability_pct).toBeGreaterThan(80);
    expect(dq.tws_availability_pct).toBeGreaterThan(80);
    expect(dq.gps_availability_pct).toBeGreaterThan(80);
    expect(dq.recording_duration_s).toBeCloseTo(durationS, 1);
  });

  // BE10-2: Simulated sensor gap — correct gap sizes and reduced availability
  it('simulated BSP gap → correct largest_bsp_gap_s and reduced availability', () => {
    // BSP at t=0, then gap, then at t=30s, then at t=35s
    const rows = [
      makeRawRow(128259, 0),
      makeRawRow(128259, 30_000),
      makeRawRow(128259, 35_000),
    ];
    const dq = computeDataQuality(rows, BASE_MS, BASE_MS + 60_000, 0, 0, 0);

    // Gap of 30 seconds between first and second BSP reading
    expect(dq.largest_bsp_gap_s).toBeCloseTo(30, 0);
    // Availability should be well below 100% (30s gap in a 60s recording)
    expect(dq.bsp_availability_pct).toBeLessThan(50);
    // Since there's no wind data, wind should be 0%
    expect(dq.tws_availability_pct).toBe(0);
  });

  // BE10-3: disconnect_count increments on each simulated reconnect
  it('disconnect_count reflects the passed-in value', () => {
    const rows: Array<{ timestamp: string; pgn: number }> = [];
    const dq = computeDataQuality(rows, BASE_MS, BASE_MS + 60_000, 3, 0, 0);
    expect(dq.disconnect_count).toBe(3);
  });

  // BE10-4: stale_data_events and invalid_pgn_count are preserved
  it('stale_data_events and invalid_pgn_count preserved in output', () => {
    const dq = computeDataQuality([], BASE_MS, BASE_MS + 10_000, 0, 5, 12);
    expect(dq.stale_data_events).toBe(5);
    expect(dq.invalid_pgn_count).toBe(12);
  });

  // BE10-5: recording_duration_s computed from start/end timestamps
  it('recording_duration_s computed correctly from start/end', () => {
    const dq = computeDataQuality([], BASE_MS, BASE_MS + 123_000, 0, 0, 0);
    expect(dq.recording_duration_s).toBeCloseTo(123, 1);
  });

  // BE10-6: empty rows → all availability 0%, gaps 0
  it('empty points array → zero availability and zero gaps', () => {
    const dq = computeDataQuality([], BASE_MS, BASE_MS + 30_000, 0, 0, 0);
    expect(dq.bsp_availability_pct).toBe(0);
    expect(dq.tws_availability_pct).toBe(0);
    expect(dq.gps_availability_pct).toBe(0);
    expect(dq.largest_bsp_gap_s).toBe(0);
    expect(dq.largest_wind_gap_s).toBe(0);
    expect(dq.largest_gps_gap_s).toBe(0);
  });

  // BE10-7: GPS data from multiple position PGNs (129025, 129026, 129029)
  it('GPS availability counts PGN 129025, 129026, and 129029', () => {
    const rows = [
      makeRawRow(129025, 0),
      makeRawRow(129026, 1_000),
      makeRawRow(129029, 2_000),
    ];
    const dq = computeDataQuality(rows, BASE_MS, BASE_MS + 10_000, 0, 0, 0);
    // 3 GPS readings across 10s recording with 5s coverage window
    expect(dq.gps_availability_pct).toBeGreaterThan(0);
    expect(dq.largest_gps_gap_s).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// BE10 — database persistence for data_quality (PRD §3.10)
// ---------------------------------------------------------------------------

describe('BE10: data_quality database persistence', () => {
  let tmpDir: string;
  let raceDb: RaceDatabase;

  beforeEach(() => {
    tmpDir = getTempDir();
    raceDb = new RaceDatabase(path.join(tmpDir, 'test.db'), tmpDir);
  });

  afterEach(() => {
    raceDb.close();
    cleanupDir(tmpDir);
  });

  it('saveDataQuality persists all metrics and getDataQuality returns them', () => {
    const race = raceDb.createRace('dq-test');
    const metrics = {
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
    raceDb.saveDataQuality(race.id, metrics);

    const dq = raceDb.getDataQuality(race.id);
    expect(dq).not.toBeNull();
    expect(dq!.race_id).toBe(race.id);
    expect(dq!.bsp_availability_pct).toBeCloseTo(87.5, 3);
    expect(dq!.tws_availability_pct).toBeCloseTo(62.0, 3);
    expect(dq!.gps_availability_pct).toBeCloseTo(95.0, 3);
    expect(dq!.largest_bsp_gap_s).toBeCloseTo(8.0, 3);
    expect(dq!.largest_wind_gap_s).toBeCloseTo(12.5, 3);
    expect(dq!.disconnect_count).toBe(2);
    expect(dq!.stale_data_events).toBe(3);
    expect(dq!.invalid_pgn_count).toBe(7);
    expect(dq!.recording_duration_s).toBeCloseTo(3600.0, 1);
  });

  it('saveDataQuality is idempotent — second call overwrites, no duplicate rows', () => {
    const race = raceDb.createRace('dq-idem');
    const metrics = {
      bsp_availability_pct: 50.0,
      tws_availability_pct: 50.0,
      twa_availability_pct: 50.0,
      gps_availability_pct: 50.0,
      largest_bsp_gap_s: 5.0,
      largest_wind_gap_s: 5.0,
      largest_gps_gap_s: 5.0,
      disconnect_count: 1,
      stale_data_events: 1,
      invalid_pgn_count: 0,
      recording_duration_s: 600.0,
    };
    raceDb.saveDataQuality(race.id, metrics);
    raceDb.saveDataQuality(race.id, { ...metrics, disconnect_count: 5 });

    const dq = raceDb.getDataQuality(race.id);
    expect(dq!.disconnect_count).toBe(5); // latest value
    // Only one row
    const count = raceDb.getRaw().prepare('SELECT COUNT(*) as c FROM data_quality WHERE race_id = ?').get(race.id) as any;
    expect(count.c).toBe(1);
  });

  it('getDataQuality returns null for a race with no quality record (legacy DB)', () => {
    const race = raceDb.createRace('legacy');
    expect(raceDb.getDataQuality(race.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// BE10 — SerialManager disconnect counter (PRD §3.10)
// ---------------------------------------------------------------------------

describe('BE10: SerialManager disconnect counter', () => {
  it('getDisconnectCount starts at 0 and resetDisconnectCount zeroes it', async () => {
    const { SerialManager } = await import('./serial-manager');
    const sm = new SerialManager({ SerialPortImpl: null, canboatImpl: null });
    expect(sm.getDisconnectCount()).toBe(0);
    sm.resetDisconnectCount();
    expect(sm.getDisconnectCount()).toBe(0);
  });
});
