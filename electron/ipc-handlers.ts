import { ipcMain, dialog } from 'electron';
import { SerialManager, ParsedPGN } from './serial-manager';
import { N2KParser, PGNMessage } from './n2k-parser';
import { PolarEngine } from './polar-engine';
import { RaceDatabase, createRaceDatabase } from './database';
import { SourceDiscovery } from './source-discovery';
import {
  reconstructTimeSeries,
  resampleToGrid,
  detectSegments,
  assignSailTags,
  computeSegmentPerformance,
  aggregatePerformance,
} from './analysis-engine';
import type { SegmentThresholds, SailTagData } from './analysis-engine';
import { sendDebugData } from './main';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { loadAppSettings, saveAppSettings, DEFAULT_SOURCE_PREFERENCES } from './settings-store';

// PGN names for debug display (extended set — includes PGNs beyond the default filter)
const PGN_DISPLAY_NAMES: Record<number, string> = {
  59392: 'ISO Acknowledgement',
  59904: 'ISO Request',
  60928: 'ISO Address Claim',
  65240: 'ISO Commanded Address',
  126208: 'NMEA Command/Request/Config',
  126464: 'PGN List',
  126992: 'System Time',
  126993: 'Heartbeat',
  126996: 'Product Information',
  127245: 'Rudder',
  127250: 'Vessel Heading',
  127251: 'Rate of Turn',
  127257: 'Attitude',
  127258: 'Magnetic Variation',
  127488: 'Engine Parameters - Rapid',
  127489: 'Engine Parameters - Dynamic',
  127493: 'Transmission Parameters',
  127497: 'Trip Parameters - Engine',
  127501: 'Binary Switch Bank Status',
  127505: 'Fluid Level',
  127508: 'Battery Status',
  128259: 'Speed - Water Referenced',
  128267: 'Water Depth',
  128275: 'Distance Log',
  129025: 'Position - Rapid Update',
  129026: 'COG & SOG - Rapid Update',
  129029: 'GNSS Position Data',
  129033: 'Time & Date',
  129038: 'AIS Class A Position Report',
  129039: 'AIS Class B Position Report',
  129041: 'AIS Aids to Navigation Report',
  129283: 'Cross Track Error',
  129284: 'Navigation Data',
  129285: 'Navigation Route/WP Info',
  129539: 'GNSS DOPs',
  129540: 'GNSS Satellites in View',
  129793: 'AIS UTC and Date Report',
  129794: 'AIS Class A Static Data',
  129809: 'AIS Class B CS Static Data Part A',
  129810: 'AIS Class B CS Static Data Part B',
  130306: 'Wind Data',
  130310: 'Environmental Parameters',
  130311: 'Environmental Parameters (Extended)',
  130312: 'Temperature',
  130313: 'Humidity',
  130314: 'Actual Pressure',
  130316: 'Temperature - Extended Range',
};

/**
 * Format a parsed PGN message into a human-readable debug line.
 * Example: "Wind Data (PGN 130306): windSpeed=12.3, windAngle=0.82, windReference=True (boat referenced)"
 */
function formatDebugLine(msg: ParsedPGN): string {
  const name = PGN_DISPLAY_NAMES[msg.pgn] || msg.description || `PGN ${msg.pgn}`;
  const fields = msg.fields;

  // Format field values into readable key=value pairs
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'timestamp') continue; // Skip internal timestamp field
    if (value === null || value === undefined) continue;

    let display: string;
    if (typeof value === 'number') {
      // Round floats for readability
      display = Number.isInteger(value) ? String(value) : value.toFixed(2);
    } else {
      display = String(value);
    }
    parts.push(`${key}=${display}`);
  }

  const fieldsStr = parts.length > 0 ? ': ' + parts.join(', ') : '';
  return `${name} (PGN ${msg.pgn})${fieldsStr}`;
}

// App-wide state
let serialManager: SerialManager | null = null;
let n2kParser: N2KParser | null = null;
let polarEngine: PolarEngine | null = null;
let sourceDiscovery: SourceDiscovery | null = null;
let raceDb: RaceDatabase | null = null;
let isRecording = false;
let recordingStartTime: number | null = null;
let recordingRecordCount = 0;

// Cached source preferences — loaded at startup and updated on settings:set.
// Avoids disk reads in the hot PGN event path.
let cachedSourcePreferences: Record<number, number> = {};

// Get the BrowserWindow's webContents to send IPC events to renderer
import { BrowserWindow } from 'electron';

function getWebContents() {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0].webContents : null;
}

/**
 * Initialize all IPC handlers. Call this once during app ready.
 */
// Debounced push of updated source map to renderer (fires 1s after last new source seen)
let sourceUpdateTimer: NodeJS.Timeout | null = null;
function scheduleSourceUpdate(): void {
  if (sourceUpdateTimer) return;
  sourceUpdateTimer = setTimeout(() => {
    sourceUpdateTimer = null;
    if (sourceDiscovery) {
      getWebContents()?.send('sources:discovered', sourceDiscovery.getDiscoveredSources());
    }
  }, 1000);
}

export function registerIPCHandlers(): void {
  serialManager = new SerialManager();
  n2kParser = new N2KParser();
  polarEngine = new PolarEngine();
  sourceDiscovery = new SourceDiscovery();

  // Load cached source preferences at startup (avoids disk I/O in the hot PGN path)
  const startupSettings = loadAppSettings();
  cachedSourcePreferences = startupSettings.sourcePreferences || {};

  // Wire up serial → parser pipeline
  // SerialManager now emits pre-parsed 'pgn' events (binary protocol handled by FromPgn stream)
  serialManager.on('pgn', (parsed: ParsedPGN) => {
    if (!n2kParser) return;

    // Send ALL parsed PGNs to debug window (unfiltered)
    sendDebugData(formatDebugLine(parsed));

    // Track source discovery — notify renderer when new sources appear
    if (parsed.src != null) {
      const isNew = sourceDiscovery!.observe(parsed.pgn, parsed.src);
      if (isNew) scheduleSourceUpdate();
    }

    // Apply source preference filter (uses cached prefs, no disk I/O)
    if (parsed.src != null && !sourceDiscovery!.shouldAccept(parsed.pgn, parsed.src, cachedSourcePreferences)) {
      return;
    }

    // Apply PGN filter for dashboard
    const message = n2kParser.filter(parsed);
    if (message) {
      getWebContents()?.send('pgn:data', message);

      if (isRecording) {
        n2kParser.enqueue(message);
      }
    }
  });

  // Unknown/unparseable data from serial manager
  serialManager.on('pgn-unknown', (msg: any) => {
    sendDebugData(`Unknown N2K data: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
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
  ipcMain.handle('connection:connect', async (_event, payload: { mode?: string; port?: string; baud?: number; host?: string; tcpPort?: number }) => {
    try {
      await serialManager!.connect(payload as any);
      return { success: true };
    } catch (err: any) {
      const status = serialManager!.getStatus();
      return { success: false, error: err?.message || 'Connection failed', status };
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

  // --- polar:open-dialog ---
  ipcMain.handle('polar:open-dialog', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import Polar File',
      filters: [
        { name: 'Polar Files', extensions: ['pol', 'csv', 'txt'] },
        { name: 'POL Polar', extensions: ['pol'] },
        { name: 'CSV Polar', extensions: ['csv'] },
        { name: 'Expedition Polar', extensions: ['txt'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true };
    return { canceled: false, filePath: result.filePaths[0] };
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
    } else if (ext === '.txt') {
      try {
        profile = polarEngine!.importExpeditionFile(payload.filePath, baseName);
      } catch (err) {
        return {
          success: false,
          error: `Not a valid Expedition polar file: ${(err as Error).message}`,
        };
      }
      if (!profile) {
        return {
          success: false,
          error: 'Not a valid Expedition polar file (no valid TWS rows found)',
        };
      }
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
    return loadAppSettings();
  });

  // --- settings:set ---
  ipcMain.handle('settings:set', async (_event, payload: Record<string, any>) => {
    const settings = loadAppSettings();
    if (settings._loadError) {
      const error = settings._loadError;
      getWebContents()?.send('settings:error', { error });
      return { success: false, error, settings };
    }
    // Strip internal error flag before merging
    const { _loadError: _ignored, ...cleanSettings } = settings;
    const updated = { ...cleanSettings, ...payload };
    try {
      saveAppSettings(updated);
    } catch (err: any) {
      console.error('[IPC] settings:set — write failed:', err);
      const error = err?.message || 'Failed to write settings file';
      getWebContents()?.send('settings:error', { error });
      return { success: false, error, settings };
    }

    // Update cached source preferences immediately
    cachedSourcePreferences = updated.sourcePreferences || {};

    return { success: true, settings: updated };
  });

  // --- sources:get ---
  ipcMain.handle('sources:get', async () => {
    return sourceDiscovery ? sourceDiscovery.getDiscoveredSources() : {};
  });

  // --- sources:rescan ---
  ipcMain.handle('sources:rescan', async () => {
    if (sourceDiscovery) {
      sourceDiscovery.clear();
      getWebContents()?.send('sources:discovered', {});
    }
    return { success: true };
  });

  // ========== Phase 2: Analysis IPC Handlers ==========

  let analysisDb: RaceDatabase | null = null;
  let analysisRaceId: number | null = null;
  let analysisTimeSeries: ReturnType<typeof reconstructTimeSeries> | null = null;

  // --- races:list ---
  ipcMain.handle('races:list', async () => {
    const settings = loadAppSettings();
    const dataDir = settings.dataDirectory || path.join(os.homedir(), 'n2k-race-logger', 'races');
    if (!fs.existsSync(dataDir)) return [];

    const files = fs.readdirSync(dataDir).filter((f) => f.endsWith('.db'));
    const result: any[] = [];

    for (const file of files) {
      const fullPath = path.join(dataDir, file);
      try {
        const stat = fs.statSync(fullPath);
        // Open the db briefly to read metadata
        const tempDb = new RaceDatabase(fullPath, dataDir);
        const races = tempDb.getAllRaces();
        const race = races[0]; // Each file has one race
        tempDb.close();

        result.push({
          path: fullPath,
          label: race?.label || null,
          date: race?.created_at || stat.mtime.toISOString(),
          startTime: race?.start_time || null,
          duration: race?.start_time && race?.end_time
            ? (new Date(race.end_time).getTime() - new Date(race.start_time).getTime()) / 1000
            : 0,
          points: race?.total_points || 0,
          size: stat.size,
        });
      } catch {
        // Skip files that can't be read
      }
    }

    // Sort newest first
    result.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return result;
  });

  // --- races:open ---
  ipcMain.handle('races:open', async (_event, payload: { filePath: string }) => {
    try {
      if (analysisDb) {
        analysisDb.close();
        analysisDb = null;
      }
      analysisTimeSeries = null;

      const settings = loadAppSettings();
      const dataDir = settings.dataDirectory || path.join(os.homedir(), 'n2k-race-logger', 'races');
      analysisDb = new RaceDatabase(payload.filePath, dataDir);
      analysisDb.ensureAnalysisTables();

      const races = analysisDb.getAllRaces();
      const race = races[0];
      if (!race) {
        return { success: false, error: 'No race metadata found in file' };
      }
      analysisRaceId = race.id;

      // Reconstruct time series
      const rows = analysisDb.getRacePoints(race.id);
      const rawRows = rows.map((r: any) => ({
        timestamp: r.timestamp,
        pgn: r.pgn,
        data: r.data,
      }));
      const ts = reconstructTimeSeries(rawRows);

      // Determine time range and resample
      const allTimes = ts.tws
        .filter((p) => p.value != null)
        .map((p) => p.time);
      if (allTimes.length === 0) {
        analysisTimeSeries = ts;
        return {
          success: true,
          metrics: ts,
          timeRange: { start: 0, end: 0 },
          raceMeta: race,
        };
      }

      const startMs = Math.min(...allTimes);
      const endMs = Math.max(...allTimes);

      // Resample each metric
      const resampled = {
        tws: resampleToGrid(ts.tws, startMs, endMs),
        twa: resampleToGrid(ts.twa, startMs, endMs),
        twaSide: ts.twaSide,
        twd: resampleToGrid(ts.twd, startMs, endMs),
        stw: resampleToGrid(ts.stw, startMs, endMs),
        aws: resampleToGrid(ts.aws, startMs, endMs),
        awa: resampleToGrid(ts.awa, startMs, endMs),
        awaSide: ts.awaSide,
        heading: resampleToGrid(ts.heading, startMs, endMs),
        sog: resampleToGrid(ts.sog, startMs, endMs),
        cog: resampleToGrid(ts.cog, startMs, endMs),
      };

      analysisTimeSeries = resampled;

      return {
        success: true,
        metrics: resampled,
        timeRange: { start: startMs, end: endMs },
        raceMeta: race,
      };
    } catch (err: any) {
      return { success: false, error: err?.message || 'Failed to open race file' };
    }
  });

  // --- races:delete ---
  ipcMain.handle('races:delete', async (_event, payload: { filePath: string }) => {
    try {
      // Close if it's the currently loaded analysis file
      if (analysisDb && analysisDb.getFilePath() === payload.filePath) {
        analysisDb.close();
        analysisDb = null;
        analysisTimeSeries = null;
        analysisRaceId = null;
      }
      if (fs.existsSync(payload.filePath)) {
        fs.unlinkSync(payload.filePath);
        // Also remove WAL/SHM files if they exist
        const walPath = payload.filePath + '-wal';
        const shmPath = payload.filePath + '-shm';
        if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
        if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);
      }
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message };
    }
  });

  // --- analysis:detect-segments ---
  ipcMain.handle('analysis:detect-segments', async (_event, payload: { thresholds: SegmentThresholds }) => {
    if (!analysisDb || !analysisTimeSeries || analysisRaceId == null) {
      return { success: false, error: 'No race loaded for analysis' };
    }

    const thresholds = payload.thresholds;
    const segments = detectSegments(
      analysisTimeSeries.tws,
      analysisTimeSeries.twa,
      analysisTimeSeries.stw,
      thresholds,
    );

    // Assign sail tags from DB
    const sailTagRows = analysisDb.getSailTags(analysisRaceId);
    const sailTags: SailTagData[] = sailTagRows.map((r: any) => ({
      sailConfig: r.sail_config,
      startTime: new Date(r.start_time).getTime(),
      endTime: new Date(r.end_time).getTime(),
    }));

    let withSails = assignSailTags(segments, sailTags);

    // Compute % of polar
    const profiles = polarEngine!.listProfiles();
    const settings = loadAppSettings();
    const activeProfile = settings.activePolarProfile
      ? polarEngine!.getProfile(settings.activePolarProfile)
      : profiles[0];
    const polarTable = activeProfile?.polarData || null;
    withSails = computeSegmentPerformance(withSails, polarTable);

    // Save to DB
    const thresholdsJson = JSON.stringify(thresholds);
    analysisDb.saveSegments(
      analysisRaceId,
      withSails.map((s) => ({
        startTime: new Date(s.startTime).toISOString(),
        endTime: new Date(s.endTime).toISOString(),
        durationS: s.durationS,
        meanTws: s.meanTws,
        meanTwa: s.meanTwa,
        meanStw: s.meanStw,
        stdTws: s.stdTws,
        stdTwa: s.stdTwa,
        stdStw: s.stdStw,
        percentPolar: s.percentPolar,
        sailConfig: s.sailConfig,
        thresholds: thresholdsJson,
      })),
    );

    // Return segments from DB (with IDs)
    const saved = analysisDb.getSegments(analysisRaceId);
    return { success: true, segments: saved };
  });

  // --- analysis:segments (get current) ---
  ipcMain.handle('analysis:segments', async () => {
    if (!analysisDb || analysisRaceId == null) {
      return { success: false, segments: [] };
    }
    const segments = analysisDb.getSegments(analysisRaceId);
    return { success: true, segments };
  });

  // --- analysis:exclude-segment ---
  ipcMain.handle('analysis:exclude-segment', async (_event, payload: { segmentId: number; excluded: boolean }) => {
    if (!analysisDb) return { success: false };
    analysisDb.setSegmentExcluded(payload.segmentId, payload.excluded);
    return { success: true };
  });

  // --- analysis:sail-tags (save) ---
  ipcMain.handle('analysis:sail-tags', async (_event, payload: { raceId: number; tags: Array<{ config: string; start: string; end: string }> }) => {
    if (!analysisDb) return { success: false };
    analysisDb.saveSailTags(
      payload.raceId,
      payload.tags.map((t) => ({
        sailConfig: t.config,
        startTime: t.start,
        endTime: t.end,
      })),
    );
    return { success: true };
  });

  // --- analysis:get-sail-tags ---
  ipcMain.handle('analysis:get-sail-tags', async (_event, payload: { raceId: number }) => {
    if (!analysisDb) return { success: false, tags: [] };
    const tags = analysisDb.getSailTags(payload.raceId);
    return { success: true, tags };
  });

  // --- analysis:data (get reconstructed time series) ---
  ipcMain.handle('analysis:data', async () => {
    if (!analysisTimeSeries) return { success: false };
    return { success: true, metrics: analysisTimeSeries };
  });

  // --- analysis:performance-summary ---
  ipcMain.handle('analysis:performance-summary', async () => {
    if (!analysisDb || analysisRaceId == null) return { success: false, rows: [] };
    const segments = analysisDb.getSegments(analysisRaceId);
    const nonExcluded = segments
      .filter((s: any) => !s.excluded)
      .map((s: any) => ({
        startTime: new Date(s.start_time).getTime(),
        endTime: new Date(s.end_time).getTime(),
        durationS: s.duration_s,
        meanTws: s.mean_tws,
        meanTwa: s.mean_twa,
        meanStw: s.mean_stw,
        stdTws: s.std_tws,
        stdTwa: s.std_twa,
        stdStw: s.std_stw,
        percentPolar: s.percent_polar,
        sailConfig: s.sail_config,
      }));
    const rows = aggregatePerformance(nonExcluded);
    return { success: true, rows };
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
