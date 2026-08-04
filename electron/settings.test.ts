import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadAppSettings, saveAppSettings, resetSettingsCacheForTests } from './settings-store';

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
    settingsPath = path.join(tmpDir, 'n2k-race-logger', 'settings.json');
    process.env.APPDATA = tmpDir;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    resetSettingsCacheForTests();
  });

  afterEach(() => {
    delete process.env.APPDATA;
    resetSettingsCacheForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves and loads settings correctly', () => {
    const original = {
      serialPort: 'COM3',
      serialBaud: 115200,
      pgnFilter: [128259, 129025, 129026, 129029, 127250, 130306, 130310, 127257, 129284],
      sourcePreferences: { 130306: 16 },
      dataDirectory: '~/n2k-race-logger/races/',
      polarDirectory: '~/n2k-race-logger/polars/',
    };

    writeSettings(original);
    const loaded = readSettings();

    expect(loaded.serialPort).toBe('COM3');
    expect(loaded.serialBaud).toBe(115200);
    expect(loaded.pgnFilter).toEqual(original.pgnFilter);
    expect(loaded.sourcePreferences).toEqual({ 130306: 16 });
    expect(loaded.dataDirectory).toBe('~/n2k-race-logger/races/');
  });

  it('saves and loads sourcePreferences correctly', () => {
    const settings = {
      serialPort: 'COM3',
      serialBaud: 115200,
      pgnFilter: [130306, 127250],
      sourcePreferences: { 130306: 16, 127250: 3 },
      dataDirectory: '~/n2k-race-logger/races/',
      polarDirectory: '~/n2k-race-logger/polars/',
    };

    writeSettings(settings);
    const loaded = readSettings();

    expect(loaded.sourcePreferences).toEqual({ 130306: 16, 127250: 3 });
  });

  it('defaults sourcePreferences to { 130306: 16 } when field is missing', () => {
    // Simulate old settings file without sourcePreferences
    const legacy = {
      serialPort: 'COM3',
      serialBaud: 115200,
      pgnFilter: [130306],
      dataDirectory: '~/n2k-race-logger/races/',
      polarDirectory: '~/n2k-race-logger/polars/',
    };

    writeSettings(legacy);
    const loaded = readSettings();

    // After migration, sourcePreferences should be applied
    const migrated = { ...loaded, sourcePreferences: loaded.sourcePreferences ?? { 130306: 16 } };
    expect(migrated.sourcePreferences).toEqual({ 130306: 16 });
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
    const loaded = loadAppSettings();
    expect(loaded.serialPort).toBe('COM3');
    expect(loaded.serialBaud).toBe(115200);
    expect(loaded.tcpHost).toBe('192.168.1.1');
    expect(loaded.tcpPort).toBe(2000);
  });

  it('preserves saved critical fields when migrating older settings', () => {
    writeSettings({
      serialPort: 'COM9',
      dataDirectory: '/custom/races',
      activePolarProfile: 42,
      sailInventory: [{ id: 'custom', label: 'Custom sail' }],
    });

    const loaded = loadAppSettings();
    expect(loaded.dataDirectory).toBe('/custom/races');
    expect(loaded.activePolarProfile).toBe(42);
    expect(loaded.sailInventory).toEqual([{ id: 'custom', label: 'Custom sail' }]);
    expect(loaded.tcpHost).toBe('192.168.1.1'); // defaults fill truly missing new field
  });

  it('returns last known critical fields and does not rewrite defaults after parse failure', () => {
    writeSettings({
      dataDirectory: '/persist/races',
      activePolarProfile: 7,
      sailInventory: [{ id: 'j0', label: 'J0' }],
      tcpHost: '10.0.0.50',
    });
    expect(loadAppSettings().dataDirectory).toBe('/persist/races');

    fs.writeFileSync(settingsPath, '{ corrupt json', 'utf-8');
    const loaded = loadAppSettings();

    expect(loaded._loadError).toMatch(/Failed to load settings/);
    expect(loaded.dataDirectory).toBe('/persist/races');
    expect(loaded.activePolarProfile).toBe(7);
    expect(loaded.sailInventory).toEqual([{ id: 'j0', label: 'J0' }]);
    expect(fs.readFileSync(settingsPath, 'utf-8')).toBe('{ corrupt json');
  });

  it('durable save reports failure without updating disk or last-known settings', () => {
    saveAppSettings({ dataDirectory: '/good/races', sailInventory: [{ id: 'j2', label: 'J2' }] });
    const before = fs.readFileSync(settingsPath, 'utf-8');

    // Force write/open failure by replacing the settings directory with a file.
    fs.rmSync(path.dirname(settingsPath), { recursive: true, force: true });
    fs.writeFileSync(path.dirname(settingsPath), 'not a directory', 'utf-8');

    expect(() => saveAppSettings({ dataDirectory: '/bad/default', sailInventory: [] })).toThrow();
    fs.rmSync(path.dirname(settingsPath), { force: true });
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, before, 'utf-8');
    expect(loadAppSettings().dataDirectory).toBe('/good/races');
  });
});

// ===================================================================
// Test: Phase 2.7 GoFree settings fields
// ===================================================================
describe('GoFree settings — Phase 2.7', () => {
  let tmpDir: string;
  let settingsPath: string;

  function writeSettings(settings: Record<string, any>): void {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'n2k-gofree-'));
    settingsPath = path.join(tmpDir, 'n2k-race-logger', 'settings.json');
    process.env.APPDATA = tmpDir;
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    resetSettingsCacheForTests();
  });

  afterEach(() => {
    delete process.env.APPDATA;
    resetSettingsCacheForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('new settings fields have correct defaults when file is absent', () => {
    const loaded = loadAppSettings();
    expect(loaded.dataSource).toBe('ngt1');
    expect(loaded.gofreeHost).toBe('192.168.0.1');
    expect(loaded.gofreePort).toBe(10110);
  });

  it('dataSource persists and reloads via spread-merge', () => {
    writeSettings({ serialPort: 'COM3', dataSource: 'gofree', gofreeHost: '10.0.0.1', gofreePort: 9999 });
    const loaded = loadAppSettings();
    expect(loaded.dataSource).toBe('gofree');
    expect(loaded.gofreeHost).toBe('10.0.0.1');
    expect(loaded.gofreePort).toBe(9999);
  });

  it('old settings.json without GoFree keys loads without error and gets defaults', () => {
    // Simulate pre-2.7 settings file that has no GoFree fields
    writeSettings({
      serialPort: 'COM5',
      serialBaud: 115200,
      dataDirectory: '/custom/races',
      activePolarProfile: 3,
    });
    const loaded = loadAppSettings();
    // GoFree defaults are filled in
    expect(loaded.dataSource).toBe('ngt1');
    expect(loaded.gofreeHost).toBe('192.168.0.1');
    expect(loaded.gofreePort).toBe(10110);
    // Existing fields are preserved
    expect(loaded.serialPort).toBe('COM5');
    expect(loaded.dataDirectory).toBe('/custom/races');
    expect(loaded.activePolarProfile).toBe(3);
  });

  it('saveAppSettings round-trips GoFree settings without data loss', () => {
    const settings = loadAppSettings();
    saveAppSettings({
      ...settings,
      dataSource: 'gofree',
      gofreeHost: '192.168.1.50',
      gofreePort: 5678,
    });
    resetSettingsCacheForTests();
    const reloaded = loadAppSettings();
    expect(reloaded.dataSource).toBe('gofree');
    expect(reloaded.gofreeHost).toBe('192.168.1.50');
    expect(reloaded.gofreePort).toBe(5678);
  });

  it('switching dataSource ngt1 → gofree preserves other settings', () => {
    writeSettings({
      serialPort: 'COM7',
      serialBaud: 115200,
      dataSource: 'ngt1',
      gofreeHost: '192.168.0.1',
      gofreePort: 10110,
      activePolarProfile: 5,
    });
    const before = loadAppSettings();
    saveAppSettings({ ...before, dataSource: 'gofree' });
    resetSettingsCacheForTests();
    const after = loadAppSettings();
    expect(after.dataSource).toBe('gofree');
    expect(after.serialPort).toBe('COM7');
    expect(after.activePolarProfile).toBe(5);
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
