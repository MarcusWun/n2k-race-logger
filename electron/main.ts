import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import * as os from 'os';
import { registerIPCHandlers, cleanup } from './ipc-handlers';

// Keep a global reference to the window to prevent garbage collection
let mainWindow: BrowserWindow | null = null;

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

/**
 * All windows closed — quit on macOS only if Cmd+Q was used.
 * On Windows/Linux, just quit.
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
