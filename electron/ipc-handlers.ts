import { ipcMain, dialog } from 'electron';
import { SerialManager } from './serial-manager';
import { N2KParser } from './n2k-parser';
import { PolarEngine } from './polar-engine';
import { RaceDatabase, createRaceDatabase } from './database';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// App-wide state
let serialManager: SerialManager | null = null;
let n2kParser: N2KParser | null = null;
let polarEngine: PolarEngine | null = null;
let raceDb: RaceDatabase | null = null;
let isRecording = false;
let recordingStartTime: number | null = null;
let recordingRecordCount = 0;

// Settings file path
function getSettingsPath(): string {
  return path.join(
    process.env.APPDATA || path.join(os.homedir(), '.config'),
    'n2k-race-logger',
    'settings.json',
  );
}

// Load app settings
function loadAppSettings(): Record<string, any> {
  const sp = getSettingsPath();
  try {
    if (fs.existsSync(sp)) {
      return JSON.parse(fs.readFileSync(sp, 'utf-8'));
    }
  } catch {
    // ignore
  }
  return {
    serialPort: 'COM3',
    serialBaud: 115200,
    pgnFilter: [128259, 129025, 129026, 129029, 127250, 130306, 130310, 127257, 129284],
    dataDirectory: path.join(os.homedir(), 'n2k-race-logger', 'races'),
    polarDirectory: path.join(os.homedir(), 'n2k-race-logger', 'polars'),
    activePolarProfile: undefined,
  };
}

// Save app settings
function saveAppSettings(settings: Record<string, any>): void {
  const sp = getSettingsPath();
  try {
    const dir = path.dirname(sp);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(sp, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    console.error('[IPC] Failed to save settings:', err);
  }
}

// Get the BrowserWindow's webContents to send IPC events to renderer
import { BrowserWindow } from 'electron';

function getWebContents() {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0].webContents : null;
}

/**
 * Initialize all IPC handlers. Call this once during app ready.
 */
export function registerIPCHandlers(): void {
  serialManager = new SerialManager();
  n2kParser = new N2KParser();
  polarEngine = new PolarEngine();

  // Wire up serial → parser pipeline
  serialManager.on('data', (line: string) => {
    if (!n2kParser) return;
    const message = n2kParser.parse(line as any);
    if (message) {
      // Forward to renderer for dashboard
      getWebContents()?.send('pgn:data', message);

      // If recording, enqueue for batch write
      if (isRecording) {
        n2kParser.enqueue(message);
      }
    }
  });

  // Batch write from parser
  n2kParser.on('batch', (messages: any[]) => {
    if (!isRecording || !raceDb) return;
    const currentDb = raceDb;
    const points = messages.map((m) => ({
      raceId: (currentDb.getActiveRace() || { id: 0 }).id,
      timestamp: m.timestamp,
      pgn: m.pgn,
      data: JSON.stringify(m.fields),
    }));
    const inserted = currentDb.batchInsertPoints(points);
    recordingRecordCount += inserted;
  });

  // --- connection:status ---
  // Main → Renderer: emitted by serialManager events
  serialManager.on('status', (status: any) => {
    getWebContents()?.send('connection:status', status);
  });

  // --- connection:connect ---
  ipcMain.handle('connection:connect', async (_event, payload: { port?: string; baud?: number }) => {
    try {
      await serialManager!.connect(payload);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Connection failed' };
    }
  });

  // --- connection:disconnect ---
  ipcMain.handle('connection:disconnect', async () => {
    try {
      await serialManager!.disconnect();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message };
    }
  });

  // --- serial:list-ports ---
  ipcMain.handle('serial:list-ports', async () => {
    const ports = await serialManager!.listPorts();
    getWebContents()?.send('serial:ports', ports);
    return ports;
  });

  // --- recording:start ---
  ipcMain.handle('recording:start', async (_event, payload: { label?: string }) => {
    const settings = loadAppSettings();
    const dataDir = settings.dataDirectory || path.join(os.homedir(), 'n2k-race-logger', 'races');
    const { db, filename } = createRaceDatabase(payload?.label, dataDir);

    // Create race meta record
    const activeProfile = polarEngine!.listProfiles()[0];
    const profileName = activeProfile?.name || null;
    db.createRace(payload?.label || '', profileName ?? undefined);

    raceDb = db;
    isRecording = true;
    recordingStartTime = Date.now();
    recordingRecordCount = 0;

    n2kParser!.startBatching();

    return { success: true, filename };
  });

  // --- recording:stop ---
  ipcMain.handle('recording:stop', async () => {
    if (!isRecording || !raceDb) {
      return { success: false, error: 'Not recording' };
    }

    n2kParser!.stopBatching();
    // Flush any remaining buffer
    const remaining = n2kParser!.flush();
    if (remaining.length > 0) {
      const active = raceDb.getActiveRace();
      if (active) {
        const points = remaining.map((m) => ({
          raceId: active.id,
          timestamp: m.timestamp,
          pgn: m.pgn,
          data: JSON.stringify(m.fields),
        }));
        raceDb.batchInsertPoints(points);
        recordingRecordCount += points.length;
      }
    }

    const active = raceDb.getActiveRace();
    if (active) {
      raceDb.finalizeRace(active.id);
    }

    raceDb.close();
    raceDb = null;
    isRecording = false;
    recordingStartTime = null;

    return { success: true };
  });

  // --- recording:status ---
  ipcMain.handle('recording:status', async () => {
    const active = isRecording && raceDb ? raceDb.getActiveRace() : null;
    return {
      active: isRecording,
      elapsed: recordingStartTime ? Date.now() - recordingStartTime : 0,
      count: recordingRecordCount,
      fileSize: raceDb ? raceDb.getFileSize() : 0,
    };
  });

  // --- polar:import ---
  ipcMain.handle('polar:import', async (_event, payload: { filePath: string }) => {
    if (!payload?.filePath) return { success: false, error: 'No file path provided' };

    const ext = path.extname(payload.filePath).toLowerCase();
    const baseName = path.basename(payload.filePath, ext);
    let profile = null;

    if (ext === '.pol') {
      profile = polarEngine!.importPolFile(payload.filePath, baseName);
    } else if (ext === '.csv') {
      profile = polarEngine!.importCsvFile(payload.filePath, baseName);
    } else {
      return { success: false, error: `Unsupported file type: ${ext}` };
    }

    if (!profile) {
      return { success: false, error: 'Failed to parse polar file' };
    }

    // Notify renderer
    getWebContents()?.send('polar:profiles', polarEngine!.listProfiles());
    return { success: true, profile };
  });

  // --- polar:list ---
  ipcMain.handle('polar:list', async () => {
    const profiles = polarEngine!.listProfiles();
    getWebContents()?.send('polar:profiles', profiles);
    return profiles;
  });

  // --- polar:get ---
  ipcMain.handle('polar:get', async (_event, payload: { id: number }) => {
    const profile = polarEngine!.getProfile(payload.id);
    if (!profile) {
      return { success: false, error: 'Profile not found' };
    }
    return { success: true, polarData: profile.polarData };
  });

  // --- polar:performance ---
  ipcMain.handle('polar:performance', async (_event, payload: { tws: number | null; twa: number | null; stw: number | null; profileId: number }) => {
    const profile = polarEngine!.getProfile(payload.profileId);
    if (!profile) {
      return { success: false, error: 'Profile not found' };
    }
    const result = polarEngine!.computePerformance(
      profile.polarData,
      payload.tws,
      payload.twa,
      payload.stw,
    );

    // Notify renderer
    getWebContents()?.send('polar:performance', result);
    return result;
  });

  // --- settings:get ---
  ipcMain.handle('settings:get', async () => {
    const settings = loadAppSettings();
    return settings;
  });

  // --- settings:set ---
  ipcMain.handle('settings:set', async (_event, payload: Record<string, any>) => {
    const settings = loadAppSettings();
    const updated = { ...settings, ...payload };
    saveAppSettings(updated);

    // Update parser filter if changed
    if (updated.pgnFilter) {
      n2kParser!.setPGNFilter(updated.pgnFilter);
    }

    return { success: true, settings: updated };
  });

  console.log('[IPC] All handlers registered.');
}

/**
 * Cleanup: called on app quit.
 */
export async function cleanup(): Promise<void> {
  if (isRecording && raceDb) {
    n2kParser?.stopBatching();
    const remaining = n2kParser?.flush();
    if (remaining && remaining.length > 0) {
      const active = raceDb.getActiveRace();
      if (active) {
        const points = remaining.map((m) => ({
          raceId: active.id,
          timestamp: m.timestamp,
          pgn: m.pgn,
          data: JSON.stringify(m.fields),
        }));
        raceDb.batchInsertPoints(points);
      }
    }
    const active = raceDb.getActiveRace();
    if (active) {
      raceDb.finalizeRace(active.id);
    }
    raceDb.close();
    raceDb = null;
  }
  if (serialManager) {
    await serialManager.disconnect();
  }
  n2kParser?.stopBatching();
}
