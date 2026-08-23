import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RaceDatabase } from './database';

// --- Test helpers ---

function getTempDir(): string {
  const tmp = path.join(os.tmpdir(), 'n2k-test-' + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  return tmp;
}

function cleanupDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ===================================================================
// Test: SQLite schema creation
// ===================================================================
describe('Database schema', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = getTempDir();
    db = new Database(path.join(tmpDir, 'test.db'));
    db.pragma('journal_mode = WAL');
  });

  afterEach(() => {
    db.close();
    cleanupDir(tmpDir);
  });

  it('creates race_meta, n2k_points, and boat_profiles tables', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS race_meta (
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        label TEXT,
        start_time TEXT,
        end_time TEXT,
        boat_profile TEXT,
        total_points INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS n2k_points (
        id INTEGER PRIMARY KEY,
        race_id INTEGER NOT NULL REFERENCES race_meta(id),
        timestamp TEXT NOT NULL,
        pgn INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS boat_profiles (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        hull_type TEXT,
        polar_data TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_n2k_race_timestamp ON n2k_points(race_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_n2k_pgn ON n2k_points(pgn);
    `);

    // Verify tables exist
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    const tableNames = tables.map((t: any) => t.name);
    expect(tableNames).toContain('race_meta');
    expect(tableNames).toContain('n2k_points');
    expect(tableNames).toContain('boat_profiles');
  });

  it('creates indexes on n2k_points', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS n2k_points (
        id INTEGER PRIMARY KEY,
        race_id INTEGER NOT NULL REFERENCES race_meta(id),
        timestamp TEXT NOT NULL,
        pgn INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_n2k_race_timestamp ON n2k_points(race_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_n2k_pgn ON n2k_points(pgn);
    `);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='n2k_points'")
      .all();
    const indexNames = indexes.map((i: any) => i.name);
    expect(indexNames).toContain('idx_n2k_race_timestamp');
    expect(indexNames).toContain('idx_n2k_pgn');
  });
});

// ===================================================================
// Test: Batch write correctness
// ===================================================================
describe('Batch write', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = getTempDir();
    db = new Database(path.join(tmpDir, 'test.db'));
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE race_meta (
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        label TEXT,
        start_time TEXT,
        end_time TEXT,
        boat_profile TEXT,
        total_points INTEGER DEFAULT 0
      );
      CREATE TABLE n2k_points (
        id INTEGER PRIMARY KEY,
        race_id INTEGER NOT NULL REFERENCES race_meta(id),
        timestamp TEXT NOT NULL,
        pgn INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX idx_n2k_race_timestamp ON n2k_points(race_id, timestamp);
      CREATE INDEX idx_n2k_pgn ON n2k_points(pgn);
    `);
  });

  afterEach(() => {
    db.close();
    cleanupDir(tmpDir);
  });

  it('batch inserts multiple N2K points and verifies count', () => {
    // Create a parent race_meta record so FK constraint is satisfied
    db.prepare(
      'INSERT INTO race_meta (id, created_at, label, start_time, end_time, boat_profile, total_points) VALUES (1, ?, ?, ?, NULL, NULL, 0)',
    ).run(new Date().toISOString(), 'Test', new Date().toISOString());

    const insert = db.prepare(
      'INSERT INTO n2k_points (race_id, timestamp, pgn, data) VALUES (@raceId, @timestamp, @pgn, @data)',
    );
    const tx = db.transaction((points: any[]) => {
      let count = 0;
      for (const pt of points) {
        insert.run(pt);
        count++;
      }
      return count;
    });

    const points = [
      { raceId: 1, timestamp: '2026-06-01T12:00:00Z', pgn: 128259, data: '{"speed": 5.2}' },
      { raceId: 1, timestamp: '2026-06-01T12:00:01Z', pgn: 130306, data: '{"tws": 10.5, "twa": 60}' },
      { raceId: 1, timestamp: '2026-06-01T12:00:02Z', pgn: 127250, data: '{"heading": 180}' },
    ];

    const inserted = tx(points);
    expect(inserted).toBe(3);

    const count = db.prepare('SELECT COUNT(*) as cnt FROM n2k_points').get();
    expect((count as any).cnt).toBe(3);
  });
});

// ===================================================================
// Test: Race lifecycle (start creates race_meta + db, stop finalizes)
// ===================================================================
describe('Race lifecycle', () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = getTempDir();
    db = new Database(path.join(tmpDir, 'test.db'));
    db.pragma('journal_mode = WAL');
    db.exec(`
      CREATE TABLE race_meta (
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        label TEXT,
        start_time TEXT,
        end_time TEXT,
        boat_profile TEXT,
        total_points INTEGER DEFAULT 0
      );
      CREATE TABLE n2k_points (
        id INTEGER PRIMARY KEY,
        race_id INTEGER NOT NULL REFERENCES race_meta(id),
        timestamp TEXT NOT NULL,
        pgn INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
  });

  afterEach(() => {
    db.close();
    cleanupDir(tmpDir);
  });

  it('start creates race_meta, stop finalizes end_time and total_points', () => {
    const now = new Date().toISOString();
    const raceId = 1;

    // Start: insert race_meta
    db.prepare(
      'INSERT INTO race_meta (id, created_at, label, start_time, end_time, boat_profile, total_points) VALUES (?, ?, ?, ?, NULL, ?, 0)',
    ).run(raceId, now, 'Test Race', now, null);

    // Insert some points
    db.prepare(
      'INSERT INTO n2k_points (race_id, timestamp, pgn, data) VALUES (?, ?, ?, ?)',
    ).run(raceId, now, 128259, '{"speed":5.0}');
    db.prepare(
      'INSERT INTO n2k_points (race_id, timestamp, pgn, data) VALUES (?, ?, ?, ?)',
    ).run(raceId, now, 130306, '{"tws":8,"twa":55}');

    // Verify active race
    const active = db.prepare('SELECT * FROM race_meta WHERE end_time IS NULL').get();
    expect((active as any).id).toBe(raceId);
    expect((active as any).total_points).toBe(0);

    // Stop: finalize
    const endTime = new Date().toISOString();
    db.prepare(
      `UPDATE race_meta SET end_time = ?, total_points = (SELECT COUNT(*) FROM n2k_points WHERE race_id = ?) WHERE id = ?`,
    ).run(endTime, raceId, raceId);

    // Verify finalized
    const finalized = db.prepare('SELECT * FROM race_meta WHERE id = ?').get(raceId);
    expect((finalized as any).end_time).toBe(endTime);
    expect((finalized as any).total_points).toBe(2);
  });
});

// ===================================================================
// BE4 — Atomic segment & sail-tag replacement (PRD §3.4)
// ===================================================================

describe('BE4: Atomic segment & sail-tag replacement (PRD §3.4)', () => {
  let tmpDir: string;
  let raceDb: RaceDatabase;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), 'n2k-be4-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    raceDb = new RaceDatabase(path.join(tmpDir, 'test.db'), tmpDir);
    raceDb.ensureAnalysisTables();
  });

  afterEach(() => {
    raceDb.close();
    cleanupDir(tmpDir);
  });

  const THRESHOLDS = JSON.stringify({ tws: 1.5, twa: 10, stw: 0.5, minDuration: 60 });

  function makeSegments(n: number): Parameters<RaceDatabase['saveSegments']>[1] {
    return Array.from({ length: n }, (_, i) => ({
      startTime: `2026-01-01T10:0${i}:00Z`,
      endTime: `2026-01-01T10:0${i}:59Z`,
      durationS: 59,
      meanTws: 12,
      meanTwa: 90,
      meanStw: 6.5,
      stdTws: 0.3,
      stdTwa: 2,
      stdStw: 0.1,
      percentPolar: 95,
      sailConfig: 'J1',
      thresholds: THRESHOLDS,
    }));
  }

  it('normal replacement succeeds — new records present, old records gone', () => {
    const race = raceDb.createRace('test');
    const raceId = race.id;

    // Save 2 segments, then replace with 3 different ones
    raceDb.saveSegments(raceId, makeSegments(2));
    expect(raceDb.getSegments(raceId).length).toBe(2);

    raceDb.saveSegments(raceId, makeSegments(3));
    expect(raceDb.getSegments(raceId).length).toBe(3);
  });

  it('INSERT failure mid-transaction → original records remain intact (DELETE rolled back)', () => {
    const race = raceDb.createRace('test');
    const raceId = race.id;

    // Seed 2 original segments
    raceDb.saveSegments(raceId, makeSegments(2));
    expect(raceDb.getSegments(raceId).length).toBe(2);

    // Try to save a batch where one entry has a value that will cause an
    // sqlite UNIQUE/NOT NULL constraint violation.  We do this by passing a
    // segment whose raceId doesn't exist (foreign-key violation when FK
    // enforcement is on), or by pushing a null into a NOT NULL column.
    // The simplest portable approach: break a NOT NULL column via the raw DB.
    const raw = raceDb.getRaw();
    raw.pragma('foreign_keys = ON');

    expect(() => {
      // Mix valid segments with one that has null thresholds (NOT NULL column) — forces INSERT failure
      const badSegs = [
        ...makeSegments(1),
        { ...makeSegments(1)[0], thresholds: null },
      ] as Parameters<RaceDatabase['saveSegments']>[1];
      raceDb.saveSegments(raceId, badSegs);
    }).toThrow();

    // Original 2 segments must still be present (transaction was rolled back)
    expect(raceDb.getSegments(raceId).length).toBe(2);
  });

  it('saveSailTags normal replacement — new tags present, old tags gone', () => {
    const race = raceDb.createRace('test');
    const raceId = race.id;

    raceDb.saveSailTags(raceId, [{ sailConfig: 'J1', startTime: '2026-01-01T10:00:00Z', endTime: '2026-01-01T10:30:00Z' }]);
    expect(raceDb.getSailTags(raceId).length).toBe(1);

    raceDb.saveSailTags(raceId, [
      { sailConfig: 'A2', startTime: '2026-01-01T10:00:00Z', endTime: '2026-01-01T10:15:00Z' },
      { sailConfig: 'A3', startTime: '2026-01-01T10:15:00Z', endTime: '2026-01-01T10:30:00Z' },
    ]);
    expect(raceDb.getSailTags(raceId).length).toBe(2);
    expect((raceDb.getSailTags(raceId)[0] as any).sail_config).toBe('A2');
  });
});

// ===================================================================
// BE7 — Interrupted-recording recovery (PRD §3.7)
// ===================================================================

describe('BE7: Interrupted-recording recovery (PRD §3.7)', () => {
  let tmpDir: string;
  let raceDb: RaceDatabase;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), 'n2k-be7-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });
    raceDb = new RaceDatabase(path.join(tmpDir, 'test.db'), tmpDir);
  });

  afterEach(() => {
    raceDb.close();
    cleanupDir(tmpDir);
  });

  it('race with end_time IS NULL → detected as interrupted, not discarded', () => {
    const race = raceDb.createRace('interrupted');
    const raceId = race.id;

    // Simulate some N2K data arriving
    raceDb.batchInsertPoints([
      { raceId, timestamp: '2026-08-22T18:42:10.000Z', pgn: 128259, data: '{"speedWaterReferenced":3.0}' },
      { raceId, timestamp: '2026-08-22T18:42:17.000Z', pgn: 130306, data: '{"windSpeed":5.0}' },
    ]);

    // Do NOT call finalizeRace() — simulate crash

    const info = raceDb.detectInterruptedRecording(raceId);
    expect(info).not.toBeNull();
    expect(info!.wasInterrupted).toBe(true);
    expect(info!.recoveredEndTime).toBe('2026-08-22T18:42:17.000Z');
  });

  it('recovered recording remains accessible for analysis (race has end_time after recovery)', () => {
    const race = raceDb.createRace('interrupted');
    const raceId = race.id;

    raceDb.batchInsertPoints([
      { raceId, timestamp: '2026-08-22T18:42:17.000Z', pgn: 128259, data: '{}' },
    ]);

    raceDb.detectInterruptedRecording(raceId);

    // Race should now have an end_time (derived from last sample) so it is
    // no longer "active" but is accessible via getRaceById
    const recovered = raceDb.getRaceById(raceId);
    expect(recovered).not.toBeUndefined();
    expect(recovered!.end_time).toBe('2026-08-22T18:42:17.000Z');
    expect(recovered!.was_interrupted).toBe(1);
    expect(recovered!.recovered_end_time).toBe('2026-08-22T18:42:17.000Z');
  });

  it('clean stop → not flagged as interrupted', () => {
    const race = raceDb.createRace('clean');
    const raceId = race.id;

    raceDb.batchInsertPoints([
      { raceId, timestamp: '2026-08-22T18:00:00.000Z', pgn: 128259, data: '{}' },
    ]);
    raceDb.finalizeRace(raceId); // clean stop

    const info = raceDb.detectInterruptedRecording(raceId);
    expect(info).not.toBeNull();
    expect(info!.wasInterrupted).toBe(false);
    expect(info!.recoveredEndTime).toBeNull();
  });

  it('interrupted recording with no N2K samples → recoveredEndTime is null', () => {
    const race = raceDb.createRace('empty');
    const raceId = race.id;
    // No points inserted at all

    const info = raceDb.detectInterruptedRecording(raceId);
    expect(info).not.toBeNull();
    expect(info!.wasInterrupted).toBe(true);
    expect(info!.recoveredEndTime).toBeNull();
  });

  it('BE7-idem: detectInterruptedRecording is idempotent — second call returns wasInterrupted:false, no re-mutation', () => {
    const race = raceDb.createRace('interrupted-idem');
    const raceId = race.id;

    raceDb.batchInsertPoints([
      { raceId, timestamp: '2026-08-22T19:00:00.000Z', pgn: 128259, data: '{"speedWaterReferenced":4.0}' },
      { raceId, timestamp: '2026-08-22T19:05:00.000Z', pgn: 130306, data: '{"windSpeed":6.0}' },
    ]);
    // Do NOT call finalizeRace() — simulate crash

    // First call: should detect and recover
    const first = raceDb.detectInterruptedRecording(raceId);
    expect(first).not.toBeNull();
    expect(first!.wasInterrupted).toBe(true);
    expect(first!.recoveredEndTime).toBe('2026-08-22T19:05:00.000Z');

    // Second call: race already has end_time set, should not re-fire
    const second = raceDb.detectInterruptedRecording(raceId);
    expect(second).not.toBeNull();
    expect(second!.wasInterrupted).toBe(false);

    // recovered_end_time must not be mutated by the second call
    const recovered = raceDb.getRaceById(raceId);
    expect(recovered!.recovered_end_time).toBe('2026-08-22T19:05:00.000Z');
  });
});
