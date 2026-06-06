import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
