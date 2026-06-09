import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';

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

export class SerialManager extends EventEmitter {
  private port: any = null;
  private parser: any = null;
  private tcpSocket: net.Socket | null = null;
  private tcpBuffer = '';
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
   * Connect via serial or Wi-Fi depending on options.mode.
   */
  async connect(options?: {
    mode?: ConnectionMode;
    port?: string;
    baud?: number;
    host?: string;
    tcpPort?: number;
  }): Promise<void> {
    const mode = options?.mode || 'serial';

    // Disconnect any existing connection first
    await this.disconnect();

    if (mode === 'wifi') {
      return this.connectTcp(options?.host, options?.tcpPort);
    }
    return this.connectSerial(options);
  }

  /**
   * Connect to a serial port.
   */
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

      this.parser = new ReadlineParser({ delimiter: '\r\n' });
      this.port.pipe(this.parser as any);

      this.parser.on('data', (data: Buffer) => {
        const line = data.toString('utf-8').trim();
        if (line) {
          this.emit('data', line);
        }
      });

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
      this.parser = null;
    }
  }

  /**
   * Connect to a Wi-Fi/TCP NMEA gateway.
   */
  private connectTcp(host?: string, tcpPort?: number): Promise<void> {
    this.activeMode = 'wifi';
    const h = host || this.wifiSettings.host;
    const p = tcpPort || this.wifiSettings.tcpPort;

    this.emit('status', { mode: 'wifi', host: h, tcpPort: p, status: 'connecting' });

    return new Promise<void>((resolve, reject) => {
      this.tcpSocket = new net.Socket();
      this.tcpBuffer = '';

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
        // Connected — remove the one-shot error handler and set up persistent handlers
        this.tcpSocket!.removeListener('error', onError);

        this.tcpSocket!.on('data', (chunk: Buffer) => {
          this.tcpBuffer += chunk.toString('utf-8');
          const lines = this.tcpBuffer.split(/\r?\n/);
          // Keep the last partial line in the buffer
          this.tcpBuffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
              this.emit('data', trimmed);
            }
          }
        });

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
    this.tcpBuffer = '';
  }

  async disconnect(): Promise<void> {
    // Disconnect serial
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

    // Disconnect TCP
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
