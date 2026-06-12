import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';

// Dynamic import of native serial modules
let SerialPort: any = null;
let serialAvailable = false;

try {
  SerialPort = require('serialport').SerialPort;
  serialAvailable = true;
} catch (err) {
  console.warn('[SerialManager] Native serial modules unavailable:', (err as Error).message);
}

// Dynamic import of canboatjs for Actisense binary protocol parsing
let FromPgn: any = null;
let canboatAvailable = false;

try {
  FromPgn = require('@canboat/canboatjs').FromPgn;
  canboatAvailable = true;
} catch (err) {
  console.warn('[SerialManager] canboatjs unavailable:', (err as Error).message);
}

export interface SerialSettings {
  port: string;
  baud: number;
}

export type ConnectionMode = 'serial' | 'wifi';

export interface ConnectionStatusEvent {
  mode: ConnectionMode;
  port?: string;
  baud?: number;
  host?: string;
  tcpPort?: number;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error?: string;
}

/**
 * Parsed PGN data emitted by the serial manager.
 * This is what canboatjs produces after decoding the Actisense binary protocol.
 */
export interface ParsedPGN {
  pgn: number;
  src?: number;
  dst?: number;
  fields: Record<string, any>;
  description?: string;
  timestamp?: string;
}

export class SerialManager extends EventEmitter {
  private port: any = null;
  private pgnParser: any = null;
  private tcpSocket: net.Socket | null = null;
  private activeMode: ConnectionMode = 'serial';
  private settingsPath: string;
  private settings: SerialSettings = {
    port: 'COM3',
    baud: 115200,
  };
  private wifiSettings = {
    host: '192.168.1.1',
    tcpPort: 2000,
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
        if (parsed.wifiHost) this.wifiSettings.host = parsed.wifiHost;
        if (parsed.wifiPort) this.wifiSettings.tcpPort = parsed.wifiPort;
      }
    } catch {
      // If loading fails, use defaults
    }
  }

  saveSettings(): void {
    try {
      const configDir = path.dirname(this.settingsPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      fs.writeFileSync(
        this.settingsPath,
        JSON.stringify({
          port: this.settings.port,
          baud: this.settings.baud,
          wifiHost: this.wifiSettings.host,
          wifiPort: this.wifiSettings.tcpPort,
        }, null, 2),
        'utf-8',
      );
    } catch (err) {
      console.error('[SerialManager] Failed to save settings:', err);
    }
  }

  getSettings(): SerialSettings {
    return { ...this.settings };
  }

  getWifiSettings(): { host: string; tcpPort: number } {
    return { ...this.wifiSettings };
  }

  isAvailable(): boolean {
    return serialAvailable;
  }

  isConnected(): boolean {
    if (this.activeMode === 'serial') {
      return this.port?.isOpen === true;
    }
    return this.tcpSocket !== null && !this.tcpSocket.destroyed;
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
   * Create a FromPgn parser instance to handle Actisense binary protocol.
   * Listens for 'pgn' events (parsed PGN objects) and 'warning' events.
   */
  private createPgnParser(): any {
    if (!canboatAvailable) return null;

    const parser = new FromPgn({ url: '' });

    // canboatjs FromPgn emits 'pgn' events with parsed PGN data
    parser.on('pgn', (pgn: any) => {
      if (pgn && pgn.pgn != null) {
        const parsed: ParsedPGN = {
          pgn: Number(pgn.pgn),
          src: pgn.src,
          dst: pgn.dst,
          fields: pgn.fields || {},
          description: pgn.description,
          timestamp: pgn.timestamp || new Date().toISOString(),
        };
        this.emit('pgn', parsed);
      }
    });

    parser.on('warning', (msg: any) => {
      // Emit unparseable data events
      this.emit('pgn-unknown', msg);
    });

    return parser;
  }

  async connect(options?: {
    mode?: ConnectionMode;
    port?: string;
    baud?: number;
    host?: string;
    tcpPort?: number;
  }): Promise<void> {
    const mode = options?.mode || 'serial';
    await this.disconnect();

    if (mode === 'wifi') {
      return this.connectTcp(options?.host, options?.tcpPort);
    }
    return this.connectSerial(options);
  }

  private async connectSerial(options?: { port?: string; baud?: number }): Promise<void> {
    if (!serialAvailable) {
      throw new Error('Serial port modules are not available. Reinstall the app or check native module bindings.');
    }

    this.activeMode = 'serial';
    const portPath = options?.port || this.settings.port;
    const baudRate = options?.baud || this.settings.baud;

    this.emit('status', { mode: 'serial', port: portPath, baud: baudRate, status: 'connecting' });

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

      // Pipe raw serial bytes through canboatjs FromPgn transform stream.
      // FromPgn handles Actisense binary protocol framing internally —
      // no ReadlineParser needed.
      this.pgnParser = this.createPgnParser();
      if (this.pgnParser) {
        this.port.pipe(this.pgnParser);
      }

      this.settings.port = portPath;
      this.settings.baud = baudRate;
      this.saveSettings();

      this.emit('status', { mode: 'serial', port: portPath, baud: baudRate, status: 'connected' });
    } catch (err: any) {
      this.emit('status', {
        mode: 'serial',
        port: portPath,
        baud: baudRate,
        status: 'error',
        error: err?.message || 'Unknown connection error',
      });
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
      this.pgnParser = null;
    }
  }

  private connectTcp(host?: string, tcpPort?: number): Promise<void> {
    this.activeMode = 'wifi';
    const h = host || this.wifiSettings.host;
    const p = tcpPort || this.wifiSettings.tcpPort;

    this.emit('status', { mode: 'wifi', host: h, tcpPort: p, status: 'connecting' });

    return new Promise<void>((resolve, reject) => {
      this.tcpSocket = new net.Socket();

      const onError = (err: Error) => {
        this.emit('status', {
          mode: 'wifi',
          host: h,
          tcpPort: p,
          status: 'error',
          error: err.message,
        });
        this.cleanupTcp();
        reject(err);
      };

      this.tcpSocket.once('error', onError);

      this.tcpSocket.connect(p, h, () => {
        this.tcpSocket!.removeListener('error', onError);

        // Pipe TCP data through canboatjs — handles both binary and text formats
        this.pgnParser = this.createPgnParser();
        if (this.pgnParser) {
          this.tcpSocket!.pipe(this.pgnParser);
        }

        this.tcpSocket!.on('error', (err: Error) => {
          console.error('[SerialManager] TCP error:', err.message);
          this.emit('status', {
            mode: 'wifi',
            host: h,
            tcpPort: p,
            status: 'error',
            error: err.message,
          });
          this.cleanupTcp();
        });

        this.tcpSocket!.on('close', () => {
          this.emit('status', {
            mode: 'wifi',
            host: h,
            tcpPort: p,
            status: 'disconnected',
          });
          this.cleanupTcp();
        });

        this.wifiSettings.host = h;
        this.wifiSettings.tcpPort = p;
        this.saveSettings();

        this.emit('status', { mode: 'wifi', host: h, tcpPort: p, status: 'connected' });
        resolve();
      });
    });
  }

  private cleanupTcp(): void {
    if (this.tcpSocket) {
      this.tcpSocket.removeAllListeners();
      if (!this.tcpSocket.destroyed) {
        this.tcpSocket.destroy();
      }
      this.tcpSocket = null;
    }
  }

  async disconnect(): Promise<void> {
    if (this.pgnParser) {
      this.pgnParser.removeAllListeners();
      this.pgnParser = null;
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

    this.cleanupTcp();

    this.emit('status', {
      mode: this.activeMode,
      port: this.settings.port,
      baud: this.settings.baud,
      host: this.wifiSettings.host,
      tcpPort: this.wifiSettings.tcpPort,
      status: 'disconnected',
    });
  }

  getStatus(): ConnectionStatusEvent {
    return {
      mode: this.activeMode,
      port: this.settings.port,
      baud: this.settings.baud,
      host: this.wifiSettings.host,
      tcpPort: this.wifiSettings.tcpPort,
      status: this.isConnected() ? 'connected' : 'disconnected',
    };
  }
}
