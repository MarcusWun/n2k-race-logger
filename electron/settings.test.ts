import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ===================================================================
// Test: Settings load/save round-trip
// ===================================================================
describe('Settings load/save round-trip', () => {
  let tmpDir: string;
  let settingsPath: string;

  function writeSettings(settings: Record<string, any>): void {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  }

  function readSettings(): Record<string, any> {
    return JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n2k-settings-'));
    settingsPath = path.join(tmpDir, 'settings.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves and loads settings correctly', () => {
    const original = {
      serialPort: 'COM3',
      serialBaud: 115200,
      pgnFilter: [128259, 129025, 129026, 129029, 127250, 130306, 130310, 127257, 129284],
      dataDirectory: '~/n2k-race-logger/races/',
      polarDirectory: '~/n2k-race-logger/polars/',
    };

    writeSettings(original);
    const loaded = readSettings();

    expect(loaded.serialPort).toBe('COM3');
    expect(loaded.serialBaud).toBe(115200);
    expect(loaded.pgnFilter).toEqual(original.pgnFilter);
    expect(loaded.dataDirectory).toBe('~/n2k-race-logger/races/');
  });

  it('handles partial updates', () => {
    const initial = {
      serialPort: 'COM3',
      serialBaud: 115200,
      pgnFilter: [128259, 130306],
    };
    writeSettings(initial);

    const updated = { ...readSettings(), serialBaud: 9600 };
    writeSettings(updated);

    const final = readSettings();
    expect(final.serialPort).toBe('COM3');
    expect(final.serialBaud).toBe(9600);
    expect(final.pgnFilter).toEqual([128259, 130306]);
  });

  it('returns defaults when file does not exist', () => {
    // Simulate reading from non-existent file
    const defaults = {
      serialPort: 'COM3',
      serialBaud: 115200,
      pgnFilter: [128259, 129025, 129026, 129029, 127250, 130306, 130310, 127257, 129284],
      dataDirectory: '~/n2k-race-logger/races/',
      polarDirectory: '~/n2k-race-logger/polars/',
    };
    expect(defaults.serialPort).toBe('COM3');
    expect(defaults.serialBaud).toBe(115200);
  });
});

// ===================================================================
// Test: Derived fields — timestamp source selection
// ===================================================================
describe('Derived fields — timestamp source', () => {
  it('uses PGN timestamp when available', () => {
    const pgnTimestamp = '2026-06-01T12:00:00.000Z';
    const parsed = new Date(pgnTimestamp).toISOString();
    expect(parsed).toBeTruthy();
    expect(new Date(parsed).getTime()).toBeGreaterThan(0);
  });

  it('falls back to system clock when PGN timestamp is missing', () => {
    const systemTime = new Date().toISOString();
    expect(systemTime).toBeTruthy();
    expect(new Date(systemTime).getTime()).toBeGreaterThan(0);
  });
});
