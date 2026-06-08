import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Dynamic import of native serial modules — they may fail if bindings aren't built for this Electron version
let SerialPort: any = null;
let ReadlineParser: any = null;
let serialAvailable = false;

try {
  SerialPort = require('serialport').SerialPort;
  ReadlineParser = require('@serialport/parser-readline').ReadlineParser;
  serialAvailable = true;
} catch (err) {
  console.warn('[SerialManager] Native serial modules unavailable:', (err as Error).message);
}

export interface SerialSettings {
  port: string;
  baud: number;
}

export interface ConnectionStatusEvent {
  port: string;
  baud: number;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error?: string;
}

export class SerialManager extends EventEmitter {
  private port: any = null;
  private parser: any = null;
  private settingsPath: string;
  private settings: SerialSettings = {
    port: 'COM3',
    baud: 115200,
  };

  constructor() {
    super();
    this.settingsPath = path.join(
      process.env.APPDATA || path.join(os.homedir(), '.config'),
      'n2k-race-logger',
      'settings.json',
    );
    this.loadSettings();
  }

  /**
   * Load persisted settings from settings.json.
   */
  private loadSettings(): void {
    try {
      const configDir = path.dirname(this.settingsPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      if (fs.existsSync(this.settingsPath)) {
        const raw = fs.readFileSync(this.settingsPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.port) this.settings.port = parsed.port;
        if (parsed.baud) this.settings.baud = parsed.baud;
      }
    } catch {
      // If loading fails, use defaults
    }
  }

  /**
   * Persist current settings to settings.json.
   */
  saveSettings(): void {
    try {
      const configDir = path.dirname(this.settingsPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      fs.writeFileSync(
        this.settingsPath,
        JSON.stringify({ port: this.settings.port, baud: this.settings.baud }, null, 2),
        'utf-8',
      );
    } catch (err) {
      console.error('[SerialManager] Failed to save settings:', err);
    }
  }

  /**
   * Get the current settings.
   */
  getSettings(): SerialSettings {
    return { ...this.settings };
  }

  /**
   * List available serial ports. Identifies Actisense by vendor/product ID
   * when available (vendorId '0403', productId '6001' for FTDI-based NGT-1).
   */
  isAvailable(): boolean {
    return serialAvailable;
  }

  async listPorts(): Promise<Array<{ path: string; manufacturer?: string; productId?: string; vendorId?: string }>> {
    if (!serialAvailable) return [];
    try {
      const ports = await SerialPort.list();
      return ports.map((p: any) => ({
        path: p.path,
        manufacturer: p.manufacturer || undefined,
        productId: p.productId || undefined,
        vendorId: p.vendorId || undefined,
      }));
    } catch (err) {
      console.error('[SerialManager] Failed to list ports:', err);
      return [];
    }
  }

  /**
   * Connect to the serial port with the configured or specified settings.
   */
  async connect(options?: { port?: string; baud?: number }): Promise<void> {
    if (!serialAvailable) {
      throw new Error('Serial port modules are not available. Reinstall the app or check native module bindings.');
    }

    if (this.port && this.port.isOpen) {
      this.disconnect();
    }

    const portPath = options?.port || this.settings.port;
    const baudRate = options?.baud || this.settings.baud;

    this.emit('status', { port: portPath, baud: baudRate, status: 'connecting' });

    try {
      this.port = new SerialPort({
        path: portPath,
        baudRate,
        parity: 'none',
        autoOpen: false,
      });

      await new Promise<void>((resolve, reject) => {
        this.port!.open((err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // Set up readline parser for line-delimited ASCII (Actisense format)
      this.parser = new ReadlineParser({ delimiter: '\r\n' });
      this.port.pipe(this.parser as any);

      this.parser.on('data', (data: Buffer) => {
        const line = data.toString('utf-8').trim();
        if (line) {
          this.emit('data', line);
        }
      });

      // Update settings and persist
      this.settings.port = portPath;
      this.settings.baud = baudRate;
      this.saveSettings();

      this.emit('status', { port: portPath, baud: baudRate, status: 'connected' });
    } catch (err: any) {
      this.emit('status', {
        port: portPath,
        baud: baudRate,
        status: 'error',
        error: err?.message || 'Unknown connection error',
      });
      // Clean up on failure
      if (this.port && this.port.isOpen) {
        try {
          await new Promise<void>((resolve) => {
            this.port!.close(() => resolve());
          });
        } catch {
          // ignore close errors
        }
      }
      this.port = null;
      this.parser = null;
    }
  }

  /**
   * Disconnect from the serial port.
   */
  async disconnect(): Promise<void> {
    if (this.parser) {
      this.parser.removeAllListeners('data');
      this.parser = null;
    }
    if (this.port && this.port.isOpen) {
      try {
        await new Promise<void>((resolve) => {
          this.port!.close(() => resolve());
        });
      } catch {
        // ignore close errors
      }
    }
    this.port = null;
    this.emit('status', {
      port: this.settings.port,
      baud: this.settings.baud,
      status: 'disconnected',
    });
  }

  /**
   * Get current connection status.
   */
  getStatus(): ConnectionStatusEvent {
    return {
      port: this.settings.port,
      baud: this.settings.baud,
      status: this.port?.isOpen ? 'connected' : 'disconnected',
    };
  }
}
