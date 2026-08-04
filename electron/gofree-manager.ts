/**
 * GoFree Ethernet Data Source Manager
 *
 * Handles auto-discovery of a B&G GoFree router via UDP multicast (239.2.1.1:2052),
 * falls back to a configured IP/port if discovery times out, then opens a TCP socket
 * and streams NMEA 0183 sentences.
 *
 * Emits:
 *   'pgn'          — ParsedPGN objects (same shape as SerialManager) for the N2K pipeline
 *   'gofree:status' — GoFreeStatusEvent with connection state updates
 *
 * IMPORTANT: This manager NEVER sends the NGT-1 BST initialization command
 * [0x11, 0x02, 0x00]. That command is specific to the Actisense NGT-1 serial device
 * and must remain entirely within serial-manager.ts.
 */

import { EventEmitter } from 'events';
import * as net from 'net';
import * as dgram from 'dgram';
import { parseNmeaSentence } from 'nmea-simple';
import type { ParsedPGN } from './serial-manager';

// Unit conversion constants
const KTS_TO_MS = 1 / 1.94384; // knots → m/s (N2K unit for speed)
const DEG_TO_RAD = Math.PI / 180; // degrees → radians (N2K unit for angles)

// GoFree multicast discovery constants (GoFree specification)
const GOFREE_MULTICAST_GROUP = '239.2.1.1';
const GOFREE_DISCOVERY_PORT = 2052;

// Default discovery timeout and reconnect settings
const DEFAULT_DISCOVERY_TIMEOUT_MS = 5000;
const RECONNECT_INTERVAL_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 3;

// N2K PGN numbers used to make data source-agnostic to the downstream pipeline.
// GoFree data is emitted with these real PGN numbers so the renderer, analysis
// engine, and recording pipeline treat it identically to NGT-1 data.
const PGN_WIND = 130306; // Wind Data
const PGN_STW = 128259; // Speed - Water Referenced
const PGN_SOG_COG = 129026; // COG & SOG - Rapid Update
const PGN_POSITION = 129025; // Position - Rapid Update
const PGN_HEADING = 127250; // Vessel Heading

export type GoFreeState =
  | 'searching'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error'
  | 'disconnected';

export interface GoFreeStatusEvent {
  state: GoFreeState;
  ip?: string;
  port?: number;
  error?: string;
}

/**
 * Compute true wind speed and angle from apparent wind and boat speed.
 * All inputs/outputs in knots and degrees (0–360°).
 * Matches the formula used by the renderer Dashboard and analysis-engine.ts.
 */
function computeTrueWind(
  awsKts: number,
  awaDeg: number,
  stwKts: number,
): { tws: number; twa: number } {
  const awaRad = awaDeg * DEG_TO_RAD;
  const u = awsKts * Math.sin(awaRad);
  const v = awsKts * Math.cos(awaRad) - stwKts;
  const tws = Math.sqrt(u * u + v * v);
  const twaRad = Math.atan2(u, v);
  const twaDeg = (((twaRad * 180) / Math.PI) % 360 + 360) % 360;
  return { tws, twa: twaDeg };
}

export interface GoFreeManagerOptions {
  /**
   * Timeout for UDP multicast discovery before falling back to configured host.
   * Defaults to 5000ms. Set to 0 in unit/integration tests to skip discovery.
   */
  discoveryTimeoutMs?: number;
}

export class GoFreeManager extends EventEmitter {
  private state: GoFreeState = 'disconnected';
  private tcpSocket: net.Socket | null = null;
  private udpSocket: dgram.Socket | null = null;
  private discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private lineBuffer = '';

  // Last known values used for true wind fallback computation
  private lastStwKts: number | null = null;
  private lastAwsKts: number | null = null;
  private lastAwaDeg: number | null = null; // 0–360° normalized
  /** True once we receive a WIMWV ref=T in this connection session. */
  private hasTrueWindSentence = false;

  // Resolved TCP target (may be updated by multicast discovery)
  private targetIp: string = '192.168.0.1';
  private targetPort: number = 10110;

  private readonly discoveryTimeoutMs: number;

  constructor(options?: GoFreeManagerOptions) {
    super();
    this.discoveryTimeoutMs = options?.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getStatus(): GoFreeStatusEvent {
    return {
      state: this.state,
      ip: this.targetIp,
      port: this.targetPort,
    };
  }

  /**
   * Begin the connection sequence: UDP multicast discovery → TCP connection.
   * If host/port are provided they are used as the fallback target when
   * discovery times out.
   */
  async connect(host?: string, port?: number): Promise<void> {
    await this.disconnect();
    if (host !== undefined) this.targetIp = host;
    if (port !== undefined) this.targetPort = port;
    this.reconnectAttempts = 0;
    this.resetSessionState();
    this.startDiscovery();
  }

  /** Close all sockets and cancel timers cleanly. */
  async disconnect(): Promise<void> {
    this.clearDiscoveryTimer();
    this.clearReconnectTimer();
    this.cleanupUdp();
    this.cleanupTcp();
    this.setState('disconnected');
  }

  // ---------------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------------

  private startDiscovery(): void {
    this.setState('searching');

    if (this.discoveryTimeoutMs === 0) {
      // Skip discovery (used in tests or when configured to connect directly)
      this.connectTcp(this.targetIp, this.targetPort);
      return;
    }

    // Start discovery timeout: fall back to configured host if no announcement arrives
    this.discoveryTimer = setTimeout(() => {
      this.discoveryTimer = null;
      this.cleanupUdp();
      this.connectTcp(this.targetIp, this.targetPort);
    }, this.discoveryTimeoutMs);

    try {
      this.udpSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.udpSocket.on('error', (err: Error) => {
        console.warn('[GoFreeManager] UDP discovery error:', err.message);
        this.clearDiscoveryTimer();
        this.cleanupUdp();
        this.connectTcp(this.targetIp, this.targetPort);
      });

      this.udpSocket.on('message', (msg: Buffer) => {
        try {
          const json = JSON.parse(msg.toString('utf-8'));
          const nmeaService = Array.isArray(json.Services)
            ? json.Services.find((s: any) => s.Service === 'nmea-0183')
            : null;
          if (nmeaService && json.IP && nmeaService.Port) {
            this.clearDiscoveryTimer();
            this.cleanupUdp();
            this.targetIp = String(json.IP);
            this.targetPort = Number(nmeaService.Port);
            console.log(`[GoFreeManager] Discovered GoFree at ${this.targetIp}:${this.targetPort}`);
            this.connectTcp(this.targetIp, this.targetPort);
          }
        } catch {
          // Malformed discovery packet — ignore
        }
      });

      this.udpSocket.bind(GOFREE_DISCOVERY_PORT, () => {
        try {
          this.udpSocket!.addMembership(GOFREE_MULTICAST_GROUP);
          console.log(`[GoFreeManager] Listening for GoFree on ${GOFREE_MULTICAST_GROUP}:${GOFREE_DISCOVERY_PORT}`);
        } catch (err) {
          console.warn('[GoFreeManager] Multicast join failed, falling back to configured host:', (err as Error).message);
          this.clearDiscoveryTimer();
          this.cleanupUdp();
          this.connectTcp(this.targetIp, this.targetPort);
        }
      });
    } catch (err) {
      console.warn('[GoFreeManager] UDP socket creation failed:', (err as Error).message);
      this.clearDiscoveryTimer();
      this.cleanupUdp();
      this.connectTcp(this.targetIp, this.targetPort);
    }
  }

  // ---------------------------------------------------------------------------
  // TCP connection
  // ---------------------------------------------------------------------------

  private connectTcp(ip: string, port: number): void {
    this.setState('connecting', ip, port);
    console.log(`[GoFreeManager] TCP connecting to ${ip}:${port}`);

    const socket = new net.Socket();
    socket.setTimeout(10000);

    const fail = (err: Error) => {
      socket.removeAllListeners();
      if (!socket.destroyed) socket.destroy();
      this.tcpSocket = null;
      this.handleConnectionFailure(`TCP connect failed to ${ip}:${port}: ${err.message}`);
    };

    socket.once('error', fail);
    socket.once('timeout', () => fail(new Error('connection timed out')));

    socket.connect(port, ip, () => {
      socket.removeListener('error', fail);
      socket.removeListener('timeout', () => {});

      this.tcpSocket = socket;
      this.reconnectAttempts = 0;
      this.lineBuffer = '';
      this.setState('connected', ip, port);
      console.log(`[GoFreeManager] TCP connected to ${ip}:${port}`);

      socket.on('data', (data: Buffer) => this.handleData(data));

      socket.on('error', (err: Error) => {
        console.error('[GoFreeManager] TCP error:', err.message);
        this.cleanupTcp();
        if (this.state === 'connected' || this.state === 'reconnecting') {
          this.handleConnectionFailure(err.message);
        }
      });

      socket.on('close', () => {
        this.cleanupTcp();
        if (this.state === 'connected') {
          this.handleConnectionFailure('Connection closed unexpectedly');
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // NMEA data handling
  // ---------------------------------------------------------------------------

  private handleData(data: Buffer): void {
    // Accumulate in a line buffer; split on newlines
    this.lineBuffer += data.toString('ascii');
    const lines = this.lineBuffer.split('\n');
    // Keep the incomplete last chunk in the buffer
    this.lineBuffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        this.parseSentence(trimmed);
      }
    }
  }

  private parseSentence(sentence: string): void {
    try {
      const parsed = parseNmeaSentence(sentence);
      // nmea-simple throws on bad checksum, so chxOk should always be true here.
      // Guard defensively anyway.
      if (!parsed.chxOk) return;
      this.dispatchSentence(parsed);
    } catch {
      // Malformed sentence (bad checksum, missing fields, unknown type) — silently skip
    }
  }

  /**
   * Map parsed NMEA sentence fields to N2K-compatible PGN events.
   *
   * Unit conversions applied to match N2K / canboatjs field format:
   *   - Speeds: knots → m/s  (÷ 1.94384)
   *   - Angles: degrees → radians (× π/180), with 0–2π wrapping for port/stbd
   *   - Position: already in decimal degrees (no conversion)
   *
   * This makes the downstream pipeline (Dashboard.tsx, analysis-engine.ts,
   * recording) source-agnostic — identical to NGT-1 data.
   */
  private dispatchSentence(parsed: any): void {
    const ts = new Date().toISOString();

    switch (parsed.sentenceId) {
      case 'MWV': {
        // $WIMWV — Wind Speed and Angle
        // nmea-simple returns NaN (not null) for missing numeric fields;
        // JSON.stringify shows NaN as null but NaN == null is false.
        if (!Number.isFinite(parsed.speed) || !Number.isFinite(parsed.windAngle)) return;
        // NMEA angles can be signed (negative = port); normalize to 0–360°
        const angleDeg360 = ((parsed.windAngle % 360) + 360) % 360;
        const angleRad = angleDeg360 * DEG_TO_RAD;
        const speedMs = (parsed.speed as number) * KTS_TO_MS;

        if (parsed.reference === 'relative') {
          // Apparent wind
          this.lastAwsKts = parsed.speed as number;
          this.lastAwaDeg = angleDeg360;

          this.emitPgn(PGN_WIND, {
            windSpeed: speedMs,
            windAngle: angleRad,
            reference: 'Apparent',
          }, ts);

          // True wind fallback: compute from apparent wind + STW when no ref=T sentence
          // arrives in this connection session (mirrors the renderer's computeTrueWind path)
          if (!this.hasTrueWindSentence && this.lastStwKts !== null) {
            const tw = computeTrueWind(parsed.speed as number, angleDeg360, this.lastStwKts);
            const twaRad = tw.twa * DEG_TO_RAD;
            this.emitPgn(PGN_WIND, {
              windSpeed: tw.tws * KTS_TO_MS,
              windAngle: twaRad,
              reference: 'True (boat referenced)',
            }, ts);
          }
        } else if (parsed.reference === 'true') {
          // True wind — use directly
          this.hasTrueWindSentence = true;
          this.emitPgn(PGN_WIND, {
            windSpeed: speedMs,
            windAngle: angleRad,
            reference: 'True (boat referenced)',
          }, ts);
        }
        break;
      }

      case 'VHW': {
        // $IIVHW — Speed Through Water + Heading Magnetic
        if (Number.isFinite(parsed.speedKnots)) {
          this.lastStwKts = parsed.speedKnots as number;
          this.emitPgn(PGN_STW, {
            speedWaterReferenced: (parsed.speedKnots as number) * KTS_TO_MS,
          }, ts);
        }
        if (Number.isFinite(parsed.degreesMagnetic)) {
          this.emitPgn(PGN_HEADING, {
            heading: (parsed.degreesMagnetic as number) * DEG_TO_RAD,
          }, ts);
        }
        break;
      }

      case 'GLL': {
        // $GPGLL — Geographic Position: Latitude/Longitude
        if (Number.isFinite(parsed.latitude) && Number.isFinite(parsed.longitude)) {
          this.emitPgn(PGN_POSITION, {
            latitude: parsed.latitude as number,
            longitude: parsed.longitude as number,
          }, ts);
        }
        break;
      }

      case 'RMC': {
        // $GPRMC — Recommended Minimum Navigation Information
        if (Number.isFinite(parsed.latitude) && Number.isFinite(parsed.longitude)) {
          this.emitPgn(PGN_POSITION, {
            latitude: parsed.latitude as number,
            longitude: parsed.longitude as number,
          }, ts);
        }
        if (Number.isFinite(parsed.speedKnots) || Number.isFinite(parsed.trackTrue)) {
          const sogMs = Number.isFinite(parsed.speedKnots) ? (parsed.speedKnots as number) * KTS_TO_MS : undefined;
          const cogRad = Number.isFinite(parsed.trackTrue) ? (parsed.trackTrue as number) * DEG_TO_RAD : undefined;
          this.emitPgn(PGN_SOG_COG, {
            ...(sogMs !== undefined ? { sog: sogMs } : {}),
            ...(cogRad !== undefined ? { cog: cogRad } : {}),
          }, ts);
        }
        break;
      }

      case 'VTG': {
        // $GPVTG — Track Made Good and Ground Speed
        const sogMs = Number.isFinite(parsed.speedKnots) ? (parsed.speedKnots as number) * KTS_TO_MS : undefined;
        const cogRad = Number.isFinite(parsed.trackTrue) ? (parsed.trackTrue as number) * DEG_TO_RAD : undefined;
        if (sogMs !== undefined || cogRad !== undefined) {
          this.emitPgn(PGN_SOG_COG, {
            ...(sogMs !== undefined ? { sog: sogMs } : {}),
            ...(cogRad !== undefined ? { cog: cogRad } : {}),
          }, ts);
        }
        break;
      }

      case 'HDG': {
        // $HCHDG — Heading, Deviation and Variation
        if (Number.isFinite(parsed.heading)) {
          this.emitPgn(PGN_HEADING, {
            heading: (parsed.heading as number) * DEG_TO_RAD,
          }, ts);
        }
        break;
      }

      case 'HDT': {
        // $HCHDT — Heading, True (fallback heading source)
        if (Number.isFinite(parsed.heading)) {
          this.emitPgn(PGN_HEADING, {
            headingTrue: (parsed.heading as number) * DEG_TO_RAD,
          }, ts);
        }
        break;
      }

      default:
        // Unknown sentence type — silently ignore per spec
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Event helpers
  // ---------------------------------------------------------------------------

  private emitPgn(pgn: number, fields: Record<string, any>, timestamp: string): void {
    const parsed: ParsedPGN = { pgn, fields, timestamp };
    this.emit('pgn', parsed);
  }

  private setState(state: GoFreeState, ip?: string, port?: number, error?: string): void {
    this.state = state;
    const event: GoFreeStatusEvent = { state };
    if (ip !== undefined) event.ip = ip;
    if (port !== undefined) event.port = port;
    if (error !== undefined) event.error = error;
    this.emit('gofree:status', event);
  }

  // ---------------------------------------------------------------------------
  // Reconnect logic
  // ---------------------------------------------------------------------------

  private handleConnectionFailure(message: string): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(`[GoFreeManager] Max reconnect attempts reached: ${message}`);
      this.setState('error', this.targetIp, this.targetPort, message);
      return;
    }

    this.reconnectAttempts++;
    console.log(`[GoFreeManager] Reconnecting (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}) in ${RECONNECT_INTERVAL_MS}ms`);
    this.setState('reconnecting', this.targetIp, this.targetPort);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectTcp(this.targetIp, this.targetPort);
    }, RECONNECT_INTERVAL_MS);
  }

  // ---------------------------------------------------------------------------
  // Cleanup helpers
  // ---------------------------------------------------------------------------

  private resetSessionState(): void {
    this.hasTrueWindSentence = false;
    this.lastStwKts = null;
    this.lastAwsKts = null;
    this.lastAwaDeg = null;
    this.lineBuffer = '';
  }

  private clearDiscoveryTimer(): void {
    if (this.discoveryTimer !== null) {
      clearTimeout(this.discoveryTimer);
      this.discoveryTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private cleanupUdp(): void {
    if (this.udpSocket !== null) {
      try {
        this.udpSocket.close();
      } catch {
        // Ignore close errors
      }
      this.udpSocket = null;
    }
  }

  private cleanupTcp(): void {
    if (this.tcpSocket !== null) {
      this.tcpSocket.removeAllListeners();
      if (!this.tcpSocket.destroyed) {
        this.tcpSocket.destroy();
      }
      this.tcpSocket = null;
    }
  }
}
