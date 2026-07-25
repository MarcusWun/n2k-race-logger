import { EventEmitter } from 'events';
import * as net from 'net';
import { loadAppSettings, saveAppSettings } from './settings-store';

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

export type ConnectionMode = 'serial' | 'tcp';

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

export interface SanitizedTcpTarget {
  host: string;
  tcpPort: number;
  corrected: boolean;
  warning?: string;
}

const DEFAULT_TCP_HOST = '192.168.1.1';
const DEFAULT_TCP_PORT = 2000;

export function sanitizeTcpHost(input?: string): SanitizedTcpTarget {
  const raw = input ?? DEFAULT_TCP_HOST;
  const original = String(raw);
  let host = original.trim().replace(/\.+$/, '');
  let corrected = host !== original;
  let warning: string | undefined;

  if (!host) {
    host = DEFAULT_TCP_HOST;
    corrected = true;
    warning = `Blank TCP host corrected to default ${DEFAULT_TCP_HOST}`;
  }

  const ipv4Like = /^\d{1,3}(?:\.\d{1,3})*$/.test(host);
  if (ipv4Like) {
    const parts = host.split('.');
    const validOctets = parts.every((part) => {
      if (!/^\d{1,3}$/.test(part)) return false;
      const n = Number(part);
      return n >= 0 && n <= 255;
    });
    if (!validOctets) {
      throw new Error(`Invalid TCP host "${original}"; IPv4 octets must be 0-255`);
    }
    if (parts.length !== 4) {
      if (host === '192.168.1') {
        host = DEFAULT_TCP_HOST;
        corrected = true;
        warning = `Malformed TCP host "${original}" corrected to default ${DEFAULT_TCP_HOST}`;
      } else {
        throw new Error(`Invalid TCP host "${original}"; expected a full IPv4 address such as ${DEFAULT_TCP_HOST}`);
      }
    }
  }

  return { host, tcpPort: DEFAULT_TCP_PORT, corrected, warning };
}

export function sanitizeTcpPort(input?: number): number {
  const port = Number(input ?? DEFAULT_TCP_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid TCP port "${input}"; expected 1-65535`);
  }
  return port;
}

export class SerialManager extends EventEmitter {
  private port: any = null;
  private pgnParser: any = null;
  private bstDecoder: any = null;
  private tcpSocket: net.Socket | null = null;
  private keepaliveInterval: ReturnType<typeof setInterval> | null = null;
  private activeMode: ConnectionMode = 'serial';
  private settings: SerialSettings = {
    port: 'COM3',
    baud: 115200,
  };
  private tcpSettings = {
    host: DEFAULT_TCP_HOST,
    tcpPort: DEFAULT_TCP_PORT,
  };

  constructor() {
    super();
    this.loadSettings();
  }

  private loadSettings(): void {
    const parsed = loadAppSettings();
    if (parsed.serialPort || parsed.port) this.settings.port = parsed.serialPort || parsed.port;
    if (parsed.serialBaud || parsed.baud) this.settings.baud = parsed.serialBaud || parsed.baud;
    if (parsed.tcpHost) this.tcpSettings.host = sanitizeTcpHost(parsed.tcpHost).host;
    if (parsed.tcpPort) this.tcpSettings.tcpPort = parsed.tcpPort;
  }

  saveSettings(): void {
    try {
      const current = loadAppSettings();
      saveAppSettings({
        ...current,
        serialPort: this.settings.port,
        serialBaud: this.settings.baud,
        // Legacy aliases preserved for compatibility with older code/tests.
        port: this.settings.port,
        baud: this.settings.baud,
        tcpHost: this.tcpSettings.host,
        tcpPort: this.tcpSettings.tcpPort,
      });
    } catch (err) {
      console.error('[SerialManager] Failed to save settings:', err);
      throw err;
    }
  }

  getSettings(): SerialSettings {
    return { ...this.settings };
  }

  getTcpSettings(): { host: string; tcpPort: number } {
    return { ...this.tcpSettings };
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

    if (mode === 'tcp') {
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
      this.bstDecoder = new ActisenseStream({ fromFile: true, reconnect: false, app: new EventEmitter() });
      // Mark output as available so ActisenseStream doesn't try to configure
      // transmit PGNs via this.serial (which is null in fromFile mode).
      this.bstDecoder.outAvailable = true;
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
    this.activeMode = 'tcp';
    const sanitized = sanitizeTcpHost(host || this.tcpSettings.host);
    const h = sanitized.host;
    const p = sanitizeTcpPort(tcpPort || this.tcpSettings.tcpPort);
    const startedAt = Date.now();

    if (sanitized.corrected) this.tcpSettings.host = h;
    if (sanitized.warning) console.warn(`[SerialManager] ${sanitized.warning}`);
    this.emit('status', { mode: 'tcp', host: h, tcpPort: p, status: 'connecting', error: sanitized.warning });
    console.log(`[SerialManager] TCP connecting to ${h}:${p}`);

    return new Promise<void>((resolve, reject) => {
      this.tcpSocket = new net.Socket();
      this.tcpSocket.setTimeout(10000);

      const fail = (err: Error) => {
        const elapsedMs = Date.now() - startedAt;
        const error = `TCP connect failed to ${h}:${p} after ${elapsedMs}ms: ${err.message}`;
        this.emit('status', {
          mode: 'tcp',
          host: h,
          tcpPort: p,
          status: 'error',
          error,
        });
        this.cleanupTcp();
        reject(new Error(error));
      };

      const onError = (err: Error) => fail(err);
      const onTimeout = () => fail(new Error('connection timed out'));

      this.tcpSocket.once('error', onError);
      this.tcpSocket.once('timeout', onTimeout);

      this.tcpSocket.connect(p, h, () => {
        this.tcpSocket!.removeListener('error', onError);
        this.tcpSocket!.removeListener('timeout', onTimeout);
        const actual = `${this.tcpSocket!.remoteAddress || h}:${this.tcpSocket!.remotePort || p}`;
        console.log(`[SerialManager] TCP connected to ${actual} in ${Date.now() - startedAt}ms`);

        // Pipe TCP data through canboatjs — handles both binary and text formats
        this.pgnParser = this.createPgnParser();
        if (this.pgnParser) {
          this.tcpSocket!.pipe(this.pgnParser);
        }

        this.tcpSocket!.on('error', (err: Error) => {
          console.error('[SerialManager] TCP error:', err.message);
          this.emit('status', {
            mode: 'tcp',
            host: h,
            tcpPort: p,
            status: 'error',
            error: `TCP error from ${h}:${p}: ${err.message}`,
          });
          this.cleanupTcp();
        });

        this.tcpSocket!.on('close', () => {
          this.emit('status', {
            mode: 'tcp',
            host: h,
            tcpPort: p,
            status: 'disconnected',
          });
          this.cleanupTcp();
        });

        this.tcpSettings.host = h;
        this.tcpSettings.tcpPort = p;
        this.saveSettings();

        this.emit('status', { mode: 'tcp', host: h, tcpPort: p, status: 'connected' });
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
      host: this.tcpSettings.host,
      tcpPort: this.tcpSettings.tcpPort,
      status: 'disconnected',
    });
  }

  getStatus(): ConnectionStatusEvent {
    return {
      mode: this.activeMode,
      port: this.settings.port,
      baud: this.settings.baud,
      host: this.tcpSettings.host,
      tcpPort: this.tcpSettings.tcpPort,
      status: this.isConnected() ? 'connected' : 'disconnected',
    };
  }
}
