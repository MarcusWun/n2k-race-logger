import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import * as os from 'os';
import { registerIPCHandlers, cleanup } from './ipc-handlers';

// Keep global references to windows to prevent garbage collection
let mainWindow: BrowserWindow | null = null;
let debugWindow: BrowserWindow | null = null;

/**
 * Create the main BrowserWindow.
 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    frame: false, // Dark frameless window
    titleBarStyle: 'hidden',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    backgroundColor: '#0a0a0a',
  });

  // Load app
  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Open (or focus) the debug window.
 */
function openDebugWindow(): void {
  if (debugWindow) {
    debugWindow.focus();
    return;
  }

  debugWindow = new BrowserWindow({
    width: 800,
    height: 500,
    minWidth: 400,
    minHeight: 200,
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'debug-preload.js'),
    },
    backgroundColor: '#0a0a0a',
  });

  if (app.isPackaged) {
    debugWindow.loadFile(path.join(__dirname, '../debug.html'));
  } else {
    // In dev, debug.html is in the project root
    debugWindow.loadFile(path.join(__dirname, '../debug.html'));
  }

  debugWindow.on('closed', () => {
    debugWindow = null;
  });
}

/**
 * Get the main window's webContents for IPC push events.
 * Using a direct reference to mainWindow is safer than BrowserWindow.getAllWindows()[0]
 * because the debug window may be open at the same time, making getAllWindows() ordering unreliable.
 */
export function getMainWebContents() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
}

/**
 * Send raw data line to the debug window (if open).
 */
export function sendDebugData(line: string): void {
  if (debugWindow && !debugWindow.isDestroyed()) {
    const now = new Date();
    const ts = now.toTimeString().slice(0, 8) + '.' + String(now.getMilliseconds()).padStart(3, '0');
    debugWindow.webContents.send('debug:data', ts, line);
  }
}

/**
 * Ensure default directories exist.
 */
function ensureDirectories(): void {
  const baseDir = path.join(os.homedir(), 'n2k-race-logger');
  const dirs = [
    path.join(baseDir, 'races'),
    path.join(baseDir, 'polars'),
    path.join(
      process.env.APPDATA || path.join(os.homedir(), '.config'),
      'n2k-race-logger',
    ),
  ];
  for (const dir of dirs) {
    if (!require('fs').existsSync(dir)) {
      require('fs').mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * App ready — set up everything.
 */
app.whenReady().then(() => {
  ensureDirectories();
  createWindow();
  registerIPCHandlers();

  // Window control handlers
  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());

  // Debug window handlers
  ipcMain.handle('debug:open', () => openDebugWindow());
  ipcMain.handle('debug:close', () => {
    if (debugWindow && !debugWindow.isDestroyed()) {
      debugWindow.close();
      debugWindow = null;
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

/**
 * All windows closed — quit only if main window is closed.
 * Debug window alone shouldn't keep the app alive.
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * Before quit — clean up connections and databases.
 */
app.on('before-quit', async () => {
  await cleanup();
});
