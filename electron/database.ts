import Database, { Database as BetterSqlite3 } from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

interface RaceMeta {
  id: number;
  created_at: string;
  label: string | null;
  start_time: string;
  end_time: string | null;
  boat_profile: string | null;
  total_points: number;
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

    const result = stmt.get(raceId, now, label, boatProfile || null);
    return result as RaceMeta;
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
