import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const DEFAULT_SOURCE_PREFERENCES: Record<number, number> = { 130306: 16 };

const DEFAULT_SAIL_INVENTORY = [
  { id: 'j1-main', label: 'J1 + Main' },
  { id: 'j2-main', label: 'J2 + Main' },
  { id: 'j3-main', label: 'J3 + Main' },
  { id: 'a2-main', label: 'A2 + Main' },
  { id: 'a3-main', label: 'A3 + Main' },
  { id: 'j2-reef1', label: 'J2 + Main + 1 reef' },
  { id: 'j3-reef1', label: 'J3 + Main + 1 reef' },
];

export const DEFAULT_SETTINGS: Record<string, any> = {
  serialPort: 'COM3',
  serialBaud: 115200,
  pgnFilter: [128259, 129025, 129026, 129029, 127250, 130306, 130310, 127257, 129284],
  sourcePreferences: { ...DEFAULT_SOURCE_PREFERENCES },
  dataDirectory: path.join(os.homedir(), 'n2k-race-logger', 'races'),
  polarDirectory: path.join(os.homedir(), 'n2k-race-logger', 'polars'),
  activePolarProfile: undefined,
  connectionMode: 'serial',
  tcpHost: '192.168.1.1',
  tcpPort: 2000,
  sailInventory: DEFAULT_SAIL_INVENTORY.map((s) => ({ ...s })),
};

const CRITICAL_PERSISTED_FIELDS = ['dataDirectory', 'activePolarProfile', 'sailInventory'];

let lastKnownSettings: Record<string, any> | null = null;

export function getSettingsPath(): string {
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), '.config'),
    'n2k-race-logger',
    'settings.json',
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function defaultsForFirstRun(): Record<string, any> {
  return clone(DEFAULT_SETTINGS);
}

function mergeSettings(saved: Record<string, any>): Record<string, any> {
  const merged = { ...defaultsForFirstRun(), ...saved };
  merged.sourcePreferences = saved.sourcePreferences ?? { ...DEFAULT_SOURCE_PREFERENCES };

  // Critical fields are only default-filled when truly absent on a successful
  // parse/read. Do not treat falsey saved values as missing.
  for (const field of CRITICAL_PERSISTED_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(saved, field)) {
      merged[field] = saved[field];
    }
  }
  return merged;
}

function withLoadError(message: string): Record<string, any> {
  const base = lastKnownSettings ? clone(lastKnownSettings) : defaultsForFirstRun();
  return { ...base, _loadError: message };
}

/** Load app settings fail-safe. Parse/read failures return the last known good
 * settings (or first-run defaults if none exist) and never mutate disk.
 */
export function loadAppSettings(): Record<string, any> {
  const sp = getSettingsPath();
  try {
    if (!fs.existsSync(sp)) {
      const settings = defaultsForFirstRun();
      lastKnownSettings = clone(settings);
      return settings;
    }

    const raw = fs.readFileSync(sp, 'utf-8');
    const saved = JSON.parse(raw);
    const merged = mergeSettings(saved);
    lastKnownSettings = clone(merged);
    return merged;
  } catch (err: any) {
    console.error('[Settings] Failed to load settings:', err);
    return withLoadError(`Failed to load settings: ${err?.message || String(err)}`);
  }
}

/** Durable settings save: write temp, fsync temp, rename, fsync directory.
 * Updates last-known settings only after disk operations complete.
 */
export function saveAppSettings(settings: Record<string, any>): void {
  const sp = getSettingsPath();
  const dir = path.dirname(sp);
  fs.mkdirSync(dir, { recursive: true });

  const { _loadError: _ignored, ...clean } = settings;
  const json = JSON.stringify(clean, null, 2);
  const tmp = path.join(dir, `.settings.${process.pid}.${Date.now()}.tmp`);

  let fd: number | null = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, json, 'utf-8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, sp);

    try {
      const dirFd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch (dirErr) {
      // Directory fsync is unavailable on some platforms/filesystems; the file
      // has still been written+renamed successfully.
      console.warn('[Settings] Directory fsync skipped:', (dirErr as Error).message);
    }

    lastKnownSettings = clone(clean);
  } catch (err) {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export function resetSettingsCacheForTests(): void {
  lastKnownSettings = null;
}
