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

// BST (Binary Serial Transfer) protocol constants for Actisense NGT-1
const BST_DLE = 0x10;
const BST_STX = 0x02;
const BST_ETX = 0x03;
const NGT_MSG_SEND = 0xA1;
const NGT_STARTUP_SEQ = Buffer.from([0x11, 0x02, 0x00]);

/**
 * Build a BST protocol frame for the Actisense NGT-1.
 * Frame format: DLE STX <command> <len> <escaped-data> <checksum> DLE ETX
 * Any DLE (0x10) bytes in data or checksum are escaped by doubling (DLE DLE).
 */
function buildBSTFrame(command: number, payload: Buffer): Buffer {
  const len = payload.length;
  // Checksum: (256 - (command + len + sum_of_payload_bytes)) & 0xFF
  let sum = command + len;
  for (let i = 0; i < payload.length; i++) {
    sum += payload[i];
  }
  const checksum = (256 - sum) & 0xFF;

  // Build the inner bytes (command, len, payload, checksum) with DLE escaping
  const inner: number[] = [];
  const addByte = (b: number) => {
    inner.push(b);
    if (b === BST_DLE) inner.push(BST_DLE); // escape
  };

  addByte(command);
  addByte(len);
  for (let i = 0; i < payload.length; i++) {
    addByte(payload[i]);
  }
  addByte(checksum);

  return Buffer.from([BST_DLE, BST_STX, ...inner, BST_DLE, BST_ETX]);
}

// Dynamic import of canboatjs for Actisense binary protocol parsing
let FromPgn: any = null;
let ActisenseStream: any = null;
let canboatAvailable = false;

try {
  const canboatjs = require('@canboat/canboatjs');
  FromPgn = canboatjs.FromPgn;
  ActisenseStream = canboatjs.serial;
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
  private bstDecoder: any = null;
  private tcpSocket: net.Socket | null = null;
  private keepaliveInterval: ReturnType<typeof setInterval> | null = null;
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

  /**
   * Send the NGT-1 startup/initialization command over BST protocol.
   * Without this, the NGT-1 stays silent and sends no N2K data.
   */
  private sendNGTStartup(): void {
    if (this.port && this.port.isOpen) {
      const frame = buildBSTFrame(NGT_MSG_SEND, NGT_STARTUP_SEQ);
      this.port.write(frame);
    }
  }

  private static readonly BAUD_RATES = [115200, 230400];
  private static readonly BAUD_DETECT_TIMEOUT_MS = 5000;

  private async connectSerial(options?: { port?: string; baud?: number }): Promise<void> {
    if (!serialAvailable) {
      throw new Error('Serial port modules are not available. Reinstall the app or check native module bindings.');
    }

    this.activeMode = 'serial';
    const portPath = options?.port || this.settings.port;
    const requestedBaud = options?.baud || this.settings.baud;

    // Try the requested/saved baud rate first, then fall back to alternatives
    const baudOrder = [requestedBaud, ...SerialManager.BAUD_RATES.filter(b => b !== requestedBaud)];

    for (let i = 0; i < baudOrder.length; i++) {
      const baudRate = baudOrder[i];
      const isLastAttempt = i === baudOrder.length - 1;

      this.emit('status', { mode: 'serial', port: portPath, baud: baudRate, status: 'connecting' });

      try {
        const connected = await this.tryConnectAtBaud(portPath, baudRate, isLastAttempt);
        if (connected) return;
        // No data at this baud rate — try the next one
        console.log(`[SerialManager] No data at ${baudRate} baud, trying next rate...`);
      } catch (err: any) {
        this.emit('status', {
          mode: 'serial',
          port: portPath,
          baud: baudRate,
          status: 'error',
          error: err?.message || 'Unknown connection error',
        });
        this.port = null;
        this.pgnParser = null;
        return;
      }
    }
  }

  /**
   * Attempt a serial connection at a specific baud rate.
   * Returns true if PGN data is received within the timeout, false if no data.
   * On the last attempt, connects without waiting for data confirmation.
   */
  private async tryConnectAtBaud(portPath: string, baudRate: number, isLastAttempt: boolean): Promise<boolean> {
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

    // Send NGT-1 initialization command, wait for device to respond,
    // then decode BST framing and parse PGN data.
    this.sendNGTStartup();
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    this.pgnParser = this.createPgnParser();
    if (this.pgnParser && ActisenseStream) {
      // ActisenseStream is a proper Transform stream that decodes BST framing
      // (DLE/STX/ETX with byte stuffing) and pushes decoded N2K binary frames.
      // FromPgn is NOT a stream — feed decoded frames via parseBuffer().
      this.bstDecoder = new ActisenseStream({ fromFile: true, reconnect: false });
      this.bstDecoder.on('data', (frame: Buffer) => {
        this.pgnParser.parseBuffer(frame);
      });
      this.port.pipe(this.bstDecoder);
    }

    // Wait for PGN data to confirm the baud rate is correct (skip on last attempt)
    if (!isLastAttempt) {
      const gotData = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => {
          this.removeListener('pgn', onPgn);
          resolve(false);
        }, SerialManager.BAUD_DETECT_TIMEOUT_MS);

        const onPgn = () => {
          clearTimeout(timeout);
          this.removeListener('pgn', onPgn);
          resolve(true);
        };
        this.once('pgn', onPgn);
      });

      if (!gotData) {
        // Clean up this attempt before trying next baud rate
        if (this.keepaliveInterval) {
          clearInterval(this.keepaliveInterval);
          this.keepaliveInterval = null;
        }
        if (this.bstDecoder) {
          this.bstDecoder.removeAllListeners();
          this.bstDecoder = null;
        }
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
        return false;
      }
    }

    // Re-send startup periodically to keep the NGT-1 alive
    this.keepaliveInterval = setInterval(() => this.sendNGTStartup(), 20000);

    this.settings.port = portPath;
    this.settings.baud = baudRate;
    this.saveSettings();

    this.emit('status', { mode: 'serial', port: portPath, baud: baudRate, status: 'connected' });
    return true;
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
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }
    if (this.bstDecoder) {
      this.bstDecoder.removeAllListeners();
      this.bstDecoder = null;
    }
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
