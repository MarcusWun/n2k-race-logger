import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Dynamic import of better-sqlite3 — may fail if native bindings aren't built for this Electron version
let Database: any = null;
let sqliteAvailable = false;

try {
  Database = require('better-sqlite3');
  sqliteAvailable = true;
} catch (err) {
  console.warn('[Database] better-sqlite3 unavailable:', (err as Error).message);
}

type BetterSqlite3 = any;

interface RaceMeta {
  id: number;
  created_at: string;
  label: string | null;
  start_time: string;
  end_time: string | null;
  boat_profile: string | null;
  total_points: number;
  /** 0 = cleanly stopped; 1 = process was killed/crashed before end_time was written (PRD §3.7). */
  was_interrupted: number;
  /** ISO timestamp of the last persisted N2K sample when the recording was interrupted. */
  recovered_end_time: string | null;
}

/** Payload exposed to the renderer for interrupted-recording recovery (PRD §3.7). */
export interface InterruptedRecordingInfo {
  raceId: number;
  wasInterrupted: boolean;
  /** ISO timestamp of the last N2K sample stored before the interruption, or null if no samples exist. */
  recoveredEndTime: string | null;
}

interface N2KPoint {
  raceId: number;
  timestamp: string;
  pgn: number;
  data: string;
}

export class RaceDatabase {
  private db: BetterSqlite3;
  private dataDirectory: string;

  constructor(dbPath: string, dataDir?: string) {
    if (!sqliteAvailable) {
      throw new Error('SQLite module is not available. Reinstall the app or check native module bindings.');
    }

    this.dataDirectory = dataDir || path.join(os.homedir(), 'n2k-race-logger', 'races');
    if (!fs.existsSync(this.dataDirectory)) {
      fs.mkdirSync(this.dataDirectory, { recursive: true });
    }

    // If dbPath is just a filename, resolve against data directory
    if (!path.isAbsolute(dbPath)) {
      dbPath = path.join(this.dataDirectory, dbPath);
    }

    // Ensure parent directory exists
    const parentDir = path.dirname(dbPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    this.db = new Database(dbPath);

    // Enable WAL mode for durability
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');

    this.createSchema();
  }

  /**
   * Create the database schema (race_meta, n2k_points, boat_profiles).
   */
  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS race_meta (
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        label TEXT,
        start_time TEXT,
        end_time TEXT,
        boat_profile TEXT,
        total_points INTEGER DEFAULT 0,
        was_interrupted INTEGER NOT NULL DEFAULT 0,
        recovered_end_time TEXT
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

    // Migration: add interrupted-recording columns to existing databases (PRD §3.7).
    // SQLite does not support ADD COLUMN IF NOT EXISTS; try/catch each ALTER.
    try {
      this.db.exec('ALTER TABLE race_meta ADD COLUMN was_interrupted INTEGER NOT NULL DEFAULT 0');
    } catch { /* column already exists */ }
    try {
      this.db.exec('ALTER TABLE race_meta ADD COLUMN recovered_end_time TEXT');
    } catch { /* column already exists */ }
  }

  /**
   * Create a new race record.
   */
  createRace(label: string, boatProfile?: string): RaceMeta {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO race_meta (id, created_at, label, start_time, end_time, boat_profile, total_points)
      VALUES (?, ?, ?, ?, NULL, ?, 0)
    `);

    // Use current timestamp as race ID (Unix ms, truncated)
    const raceId = Math.floor(Date.now() / 1000);

    stmt.run(raceId, now, label, now, boatProfile || null);
    return {
      id: raceId,
      created_at: now,
      label: label || null,
      start_time: now,
      end_time: null,
      boat_profile: boatProfile || null,
      total_points: 0,
      was_interrupted: 0,
      recovered_end_time: null,
    };
  }

  /**
   * Get the active race (most recent race without an end_time).
   */
  getActiveRace(): RaceMeta | undefined {
    const stmt = this.db.prepare(`
      SELECT * FROM race_meta WHERE end_time IS NULL ORDER BY created_at DESC LIMIT 1
    `);
    const result = stmt.get();
    return result ? (result as unknown as RaceMeta) : undefined;
  }

  /**
   * Batch insert N2K points. Uses a transaction for performance.
   */
  batchInsertPoints(points: N2KPoint[]): number {
    if (points.length === 0) return 0;

    const insert = this.db.prepare(`
      INSERT INTO n2k_points (race_id, timestamp, pgn, data)
      VALUES (@raceId, @timestamp, @pgn, @data)
    `);

    const transaction = this.db.transaction((pts: N2KPoint[]) => {
      let count = 0;
      for (const pt of pts) {
        insert.run(pt);
        count++;
      }
      return count;
    });

    return transaction(points);
  }

  /**
   * Update the total_points count for a race.
   */
  updateTotalPoints(raceId: number, count: number): void {
    const stmt = this.db.prepare(`
      UPDATE race_meta SET total_points = ? WHERE id = ?
    `);
    stmt.run(count, raceId);
  }

  /**
   * Finalize a race: set end_time and update total_points.
   */
  finalizeRace(raceId: number): RaceMeta | undefined {
    const endTime = new Date().toISOString();
    const stmt = this.db.prepare(`
      UPDATE race_meta
      SET end_time = ?, total_points = (
        SELECT COUNT(*) FROM n2k_points WHERE race_id = ?
      )
      WHERE id = ?
    `);
    stmt.run(endTime, raceId, raceId);

    return this.getRaceById(raceId);
  }

  /**
   * Detect and mark an interrupted recording (PRD §3.7).
   *
   * A race is interrupted when its `end_time` is NULL at open time, indicating
   * the process was killed or crashed before `finalizeRace()` could run.
   *
   * On detection:
   *  - Sets `was_interrupted = 1`.
   *  - Sets `recovered_end_time` to the ISO timestamp of the last persisted N2K sample.
   *  - Sets `end_time = recovered_end_time` so the race is no longer treated as active.
   *
   * Returns an `InterruptedRecordingInfo` payload suitable for IPC delivery to the renderer.
   * Returns `null` if the race does not exist.
   * If `end_time` is already set (clean stop), returns `{ wasInterrupted: false }`.
   */
  detectInterruptedRecording(raceId: number): InterruptedRecordingInfo | null {
    const race = this.getRaceById(raceId);
    if (!race) return null;

    if (race.end_time !== null) {
      // Cleanly stopped — not interrupted
      return { raceId, wasInterrupted: false, recoveredEndTime: null };
    }

    // Find the last N2K sample timestamp
    const lastRow = this.db.prepare(
      'SELECT MAX(timestamp) AS last_ts FROM n2k_points WHERE race_id = ?',
    ).get(raceId) as { last_ts: string | null } | undefined;

    const recoveredEndTime = lastRow?.last_ts ?? null;

    // Mark as interrupted and close the race at the recovered end time
    this.db.prepare(`
      UPDATE race_meta
      SET was_interrupted = 1,
          recovered_end_time = ?,
          end_time = ?
      WHERE id = ?
    `).run(recoveredEndTime, recoveredEndTime, raceId);

    return { raceId, wasInterrupted: true, recoveredEndTime };
  }

  /**
   * Get a race by ID.
   */
  getRaceById(raceId: number): RaceMeta | undefined {
    const stmt = this.db.prepare(`SELECT * FROM race_meta WHERE id = ?`);
    const result = stmt.get(raceId);
    return result ? (result as unknown as RaceMeta) : undefined;
  }

  /**
   * Get all races.
   */
  getAllRaces(): RaceMeta[] {
    const stmt = this.db.prepare(`SELECT * FROM race_meta ORDER BY created_at DESC`);
    return stmt.all() as unknown as RaceMeta[];
  }

  /**
   * Get N2K points for a race.
   */
  getRacePoints(raceId: number): N2KPoint[] {
    const stmt = this.db.prepare(`
      SELECT id, race_id as raceId, timestamp, pgn, data
      FROM n2k_points WHERE race_id = ?
      ORDER BY timestamp
    `);
    return stmt.all(raceId) as unknown as N2KPoint[];
  }

  /**
   * Get the point count for a race.
   */
  getRacePointCount(raceId: number): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) as count FROM n2k_points WHERE race_id = ?`);
    const result = stmt.get(raceId) as any;
    return result?.count ?? 0;
  }

  /**
   * Get database file size in bytes.
   */
  getFileSize(): number {
    try {
      const stats = fs.statSync((this.db as any).name);
      return stats.size;
    } catch {
      return 0;
    }
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  /**
   * Get the raw database instance (for advanced queries).
   */
  getRaw(): BetterSqlite3 {
    return this.db;
  }

  /**
   * Get the database file path.
   */
  getFilePath(): string {
    return (this.db as any).name;
  }

  // --- Phase 2: Analysis Tables ---

  /**
   * Ensure Phase 2 tables exist (migration-style: create if not present).
   */
  ensureAnalysisTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sail_tags (
        id INTEGER PRIMARY KEY,
        race_id INTEGER NOT NULL REFERENCES race_meta(id),
        sail_config TEXT NOT NULL,
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sail_tags_race_time ON sail_tags(race_id, start_time);

      CREATE TABLE IF NOT EXISTS detected_segments (
        id INTEGER PRIMARY KEY,
        race_id INTEGER NOT NULL REFERENCES race_meta(id),
        start_time TEXT NOT NULL,
        end_time TEXT NOT NULL,
        duration_s REAL NOT NULL,
        mean_tws REAL NOT NULL,
        mean_twa REAL NOT NULL,
        mean_stw REAL NOT NULL,
        std_tws REAL NOT NULL,
        std_twa REAL NOT NULL,
        std_stw REAL NOT NULL,
        percent_polar REAL,
        sail_config TEXT,
        excluded INTEGER NOT NULL DEFAULT 0,
        thresholds TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_segments_race ON detected_segments(race_id);
    `);
  }

  /**
   * Save detected segments (replaces all existing for the race).
   */
  saveSegments(raceId: number, segments: Array<{
    startTime: string; endTime: string; durationS: number;
    meanTws: number; meanTwa: number; meanStw: number;
    stdTws: number; stdTwa: number; stdStw: number;
    percentPolar: number | null; sailConfig: string | null;
    thresholds: string;
  }>): void {
    const deleteStmt = this.db.prepare('DELETE FROM detected_segments WHERE race_id = ?');
    const insert = this.db.prepare(`
      INSERT INTO detected_segments (
        race_id, start_time, end_time, duration_s,
        mean_tws, mean_twa, mean_stw,
        std_tws, std_twa, std_stw,
        percent_polar, sail_config, excluded, thresholds
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `);
    // DELETE and all INSERTs are wrapped in a single transaction (PRD §3.4).
    // If any INSERT fails the DELETE is rolled back, preserving existing records.
    const txn = this.db.transaction((segs: typeof segments) => {
      deleteStmt.run(raceId);
      for (const s of segs) {
        insert.run(
          raceId, s.startTime, s.endTime, s.durationS,
          s.meanTws, s.meanTwa, s.meanStw,
          s.stdTws, s.stdTwa, s.stdStw,
          s.percentPolar, s.sailConfig, s.thresholds,
        );
      }
    });
    txn(segments);
  }

  /**
   * Get all detected segments for a race.
   */
  getSegments(raceId: number): any[] {
    return this.db.prepare(
      'SELECT * FROM detected_segments WHERE race_id = ? ORDER BY start_time',
    ).all(raceId) as any[];
  }

  /**
   * Toggle segment exclusion.
   */
  setSegmentExcluded(segmentId: number, excluded: boolean): void {
    this.db.prepare('UPDATE detected_segments SET excluded = ? WHERE id = ?').run(excluded ? 1 : 0, segmentId);
  }

  /**
   * Save sail tags (replaces all existing for the race).
   */
  saveSailTags(raceId: number, tags: Array<{ sailConfig: string; startTime: string; endTime: string }>): void {
    const deleteStmt = this.db.prepare('DELETE FROM sail_tags WHERE race_id = ?');
    const insert = this.db.prepare(
      'INSERT INTO sail_tags (race_id, sail_config, start_time, end_time) VALUES (?, ?, ?, ?)',
    );
    // DELETE and all INSERTs are wrapped in a single transaction (PRD §3.4).
    // If any INSERT fails the DELETE is rolled back, preserving existing records.
    const txn = this.db.transaction((ts: typeof tags) => {
      deleteStmt.run(raceId);
      for (const t of ts) {
        insert.run(raceId, t.sailConfig, t.startTime, t.endTime);
      }
    });
    txn(tags);
  }

  /**
   * Get sail tags for a race.
   */
  getSailTags(raceId: number): any[] {
    return this.db.prepare(
      'SELECT * FROM sail_tags WHERE race_id = ? ORDER BY start_time',
    ).all(raceId) as any[];
  }
}

/**
 * Factory function to create a new per-race database file.
 * Returns the RaceDatabase instance and the filename.
 */
export function createRaceDatabase(
  label?: string,
  dataDir?: string,
): { db: RaceDatabase; filename: string } {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19); // YYYY-MM-DDTHH-MM-SS
  const safeLabel = label ? label.replace(/[^a-zA-Z0-9_-]/g, '_') : 'race';
  const filename = `${timestamp}_${safeLabel}.db`;

  const fullPath = dataDir
    ? path.join(dataDir, filename)
    : path.join(os.homedir(), 'n2k-race-logger', 'races', filename);

  const db = new RaceDatabase(fullPath, dataDir);
  return { db, filename };
}
