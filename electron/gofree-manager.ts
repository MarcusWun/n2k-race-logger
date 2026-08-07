/**
 * GoFree Ethernet Data Source Manager (GoFree Tier 2 / WebSocket)
 *
 * Connects to the B&G H5000 CPU via WebSocket (default `ws://192.168.1.233:2053`),
 * subscribes to the required channel IDs with a `DataReq` message, and streams
 * the resulting JSON observations into ParsedPGN events so the downstream
 * pipeline (Dashboard, analysis engine, recording) treats GoFree data
 * identically to NGT-1 data.
 *
 * Emits:
 *   'pgn'            — ParsedPGN objects (same shape as SerialManager)
 *   'gofree:status'  — GoFreeStatusEvent with connection state updates
 *
 * IMPORTANT: This manager NEVER sends the NGT-1 BST initialization command
 * `[0x11, 0x02, 0x00]`. That command is specific to the Actisense NGT-1 serial
 * device and remains entirely within serial-manager.ts.
 */

import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import type { ParsedPGN } from './serial-manager';

// Unit conversions to match the NGT-1 pipeline (m/s and radians).
const KTS_TO_MS = 1 / 1.94384;
const DEG_TO_RAD = Math.PI / 180;

// Timer / reconnect defaults (PRD-specified).
const DEFAULT_KEEPALIVE_INTERVAL_MS = 30_000;
const DEFAULT_RECONNECT_INTERVAL_MS = 5_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 3;

// How long to wait for DataList response before falling back to direct DataReq.
const DISCOVERY_TIMEOUT_MS = 3_000;

// N2K PGN numbers emitted downstream so consumers are source-agnostic.
const PGN_WIND = 130306;      // Wind Data
const PGN_STW = 128259;       // Speed - Water Referenced
const PGN_SOG_COG = 129026;   // COG & SOG - Rapid Update
const PGN_POSITION = 129025;  // Position - Rapid Update
const PGN_HEADING = 127250;   // Vessel Heading

// GoFree Tier 2 channel IDs (H5000).
const CH_TWA = 141;
const CH_TWS = 47;
const CH_BSPD = 42;
const CH_SOG = 41;
const CH_COG = 9;
const CH_HDG = 37;
const CH_LAT = 421;
const CH_LON = 422;
const CH_AWA = 140;
const CH_AWS = 46;
const CH_VMG = 235;
const CH_LEE = 226;

/** Full DataReq subscription list — sent immediately on WebSocket open. */
const REQUIRED_CHANNEL_IDS = [
  CH_TWA,
  CH_TWS,
  CH_BSPD,
  CH_SOG,
  CH_COG,
  CH_HDG,
  CH_LAT,
  CH_LON,
  CH_AWA,
  CH_AWS,
  CH_VMG,
  CH_LEE,
];

export type GoFreeState =
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

export interface GoFreeManagerOptions {
  /** Keepalive tick interval in ms (default 30000). */
  keepaliveIntervalMs?: number;
  /** Reconnect delay in ms (default 5000). */
  reconnectIntervalMs?: number;
  /** Max reconnect attempts before entering the `error` state (default 3). */
  maxReconnectAttempts?: number;
  /**
   * Injectable WebSocket implementation — allows tests to substitute a mock
   * without touching the network. Defaults to the real `ws` client.
   */
  WebSocketImpl?: any;
}

interface Observation {
  id: number;
  inst?: number;
  val?: number | null;
  valid?: boolean;
}

export class GoFreeManager extends EventEmitter {
  private state: GoFreeState = 'disconnected';
  private ws: any = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;

  // Accumulators used to pair TWA/TWS and AWA/AWS observations that arrive
  // in separate messages. Angles are stored already normalized to 0–360°.
  private lastTwaDeg: number | null = null;
  private lastTwsKts: number | null = null;
  private lastAwaDeg: number | null = null;
  private lastAwsKts: number | null = null;
  private discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private discoveryComplete = false;

  private targetHost = '192.168.1.233';
  private targetPort = 2053;

  private readonly keepaliveIntervalMs: number;
  private readonly reconnectIntervalMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly WebSocketImpl: any;

  constructor(options?: GoFreeManagerOptions) {
    super();
    this.keepaliveIntervalMs =
      options?.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
    this.reconnectIntervalMs =
      options?.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS;
    this.maxReconnectAttempts =
      options?.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.WebSocketImpl = options?.WebSocketImpl ?? WebSocket;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getStatus(): GoFreeStatusEvent {
    return { state: this.state, ip: this.targetHost, port: this.targetPort };
  }

  /**
   * Open a WebSocket to the H5000 and subscribe to the required channels.
   * If a previous session is active it is closed cleanly first.
   */
  async connect(host?: string, port?: number): Promise<void> {
    await this.disconnect();
    if (host !== undefined) this.targetHost = host;
    if (port !== undefined) this.targetPort = port;
    this.reconnectAttempts = 0;
    this.resetSessionState();
    this.openSocket();
  }

  /** Close the socket cleanly and cancel all timers. */
  async disconnect(): Promise<void> {
    this.clearReconnectTimer();
    this.clearKeepaliveTimer();
    this.cleanupSocket();
    this.setState('disconnected');
  }

  // ---------------------------------------------------------------------------
  // Socket lifecycle
  // ---------------------------------------------------------------------------

  private openSocket(): void {
    const url = `ws://${this.targetHost}:${this.targetPort}`;
    this.setState('connecting', this.targetHost, this.targetPort);
    console.log(`[GoFreeManager] WebSocket connecting to ${url}`);

    let ws: any;
    try {
      ws = new this.WebSocketImpl(url);
    } catch (err) {
      this.handleConnectionFailure(
        `WebSocket construction failed: ${(err as Error).message}`,
      );
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.setState('connected', this.targetHost, this.targetPort);
      console.log(`[GoFreeManager] WebSocket connected to ${url}`);
      this.startDiscovery();
      this.startKeepalive();
    });

    ws.on('message', (data: any) => {
      // `ws` delivers Buffer/ArrayBuffer/Buffer[] depending on binaryType,
      // but GoFree text frames always decode to UTF-8 JSON strings.
      const text =
        typeof data === 'string'
          ? data
          : Buffer.isBuffer(data)
            ? data.toString('utf-8')
            : String(data);
      this.handleMessage(text);
    });

    ws.on('error', (err: Error) => {
      // Log only — the ensuing `close` drives reconnect / state transition.
      console.error('[GoFreeManager] WebSocket error:', err.message);
    });

    ws.on('close', (code?: number) => {
      this.clearKeepaliveTimer();
      const msg = `WebSocket closed${code != null ? ` (code=${code})` : ''}`;
      this.emit('debug', `[GoFree] ${msg}`);
      this.cleanupSocket();
      if (this.state === 'disconnected') return; // user-initiated close
      this.handleConnectionFailure(msg);
    });
  }

  /**
   * Step 1: request the full channel list from the H5000.
   * On success we subscribe to all available channels in batches (step 2).
   * Fallback: if no DataList arrives in time, subscribe directly to
   * REQUIRED_CHANNEL_IDS with inst=0.
   *
   * The C++ B-G-H5000-Logger subscribes to all ~350 available channels in
   * batches of ~40 rather than a curated subset. We match that approach:
   * subscribing to all available IDs ensures the H5000 starts streaming,
   * and we filter the incoming data by channel ID on our side.
   */
  private startDiscovery(): void {
    this.discoveryComplete = false;
    this.emit('debug', '[GoFree] Step 1: Sending DataListReq (group 40)');
    this.send({ DataListReq: { group: 40 } });

    this.discoveryTimer = setTimeout(() => {
      this.discoveryTimer = null;
      if (!this.discoveryComplete) {
        this.emit('debug', '[GoFree] DataList timeout — subscribing to required IDs directly');
        this.subscribeInBatches(REQUIRED_CHANNEL_IDS);
      }
    }, DISCOVERY_TIMEOUT_MS);
  }

  /**
   * Step 2: subscribe to all available channel IDs in batches of 40.
   * Matching the C++ logger's approach: subscribe broadly, filter locally.
   */
  private subscribeAll(availableIds: number[]): void {
    this.discoveryComplete = true;
    if (this.discoveryTimer !== null) {
      clearTimeout(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    this.emit('debug', `[GoFree] Step 2: Subscribing to all ${availableIds.length} available channels in batches`);
    this.subscribeInBatches(availableIds);
  }

  /** Send DataReq in batches of 40, inst=0 for all. */
  private subscribeInBatches(ids: number[], batchSize = 40): void {
    const batches: number[][] = [];
    for (let i = 0; i < ids.length; i += batchSize) {
      batches.push(ids.slice(i, i + batchSize));
    }
    this.emit('debug', `[GoFree] Sending ${batches.length} DataReq batch(es) for ${ids.length} channels`);
    for (const batch of batches) {
      const req = {
        DataReq: batch.map((id) => ({ id, repeat: true, inst: 0 })),
      };
      this.send(req);
    }
  }

  private send(obj: any): void {
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (err) {
      console.warn('[GoFreeManager] send failed:', (err as Error).message);
    }
  }

  // ---------------------------------------------------------------------------
  // Message handling
  // ---------------------------------------------------------------------------

  /**
   * Parse a raw JSON message from the H5000 and dispatch any observations.
   * Handles both `{Data:[...]}` and `{Many:[{Data:[...]}, ...]}` envelopes.
   * Malformed / non-JSON / non-object payloads are silently skipped.
   */
  private handleMessage(raw: string): void {
    if (!raw || typeof raw !== 'string') return;

    // Emit raw message to debug window so we can inspect H5000 output.
    this.emit('debug', `[GoFree RAW] ${raw.length > 500 ? raw.slice(0, 500) + '…' : raw}`);

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.emit('debug', '[GoFree] non-JSON message skipped');
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;

    // Log the top-level keys so we can see the envelope structure.
    this.emit('debug', `[GoFree keys] ${Object.keys(parsed).join(', ')}`);

    // Step 1 response: DataList → subscribe to all available channels in batches
    if (parsed.DataList != null) {
      const available: number[] = Array.isArray(parsed.DataList.list)
        ? parsed.DataList.list
        : [];
      this.emit('debug', `[GoFree] DataList received — ${available.length} channels available`);
      const toSubscribe = available.length > 0 ? available : REQUIRED_CHANNEL_IDS;
      this.subscribeAll(toSubscribe);
      return;
    }

    if (Array.isArray(parsed.Many)) {
      for (const item of parsed.Many) {
        if (item && Array.isArray(item.Data)) {
          this.processObservations(item.Data);
        }
      }
      return;
    }

    if (Array.isArray(parsed.Data)) {
      this.processObservations(parsed.Data);
      return;
    }

    // Log unhandled envelope types so we can detect unexpected formats.
    this.emit('debug', `[GoFree unhandled] ${JSON.stringify(parsed).slice(0, 200)}`);
  }

  private processObservations(obs: Observation[]): void {
    for (const o of obs) {
      if (!o || typeof o.id !== 'number') continue;
      if (o.valid === false) continue; // discard invalid observations
      if (o.val === undefined || o.val === null || !Number.isFinite(o.val)) continue;
      this.handleObservation(o);
    }
  }

  private handleObservation(o: Observation): void {
    const ts = new Date().toISOString();
    const val = o.val as number;

    switch (o.id) {
      case CH_TWA: {
        // Signed degrees (negative = port). Normalize to 0–360° so downstream
        // normalizeWindAngle() logic matches the NGT-1 path.
        const deg360 = ((val % 360) + 360) % 360;
        this.lastTwaDeg = deg360;
        const fields: Record<string, any> = {
          windAngle: deg360 * DEG_TO_RAD,
          reference: 'True (boat referenced)',
        };
        if (this.lastTwsKts !== null) {
          fields.windSpeed = this.lastTwsKts * KTS_TO_MS;
        }
        this.emitPgn(PGN_WIND, fields, ts);
        break;
      }
      case CH_TWS: {
        this.lastTwsKts = val;
        const fields: Record<string, any> = {
          windSpeed: val * KTS_TO_MS,
          reference: 'True (boat referenced)',
        };
        if (this.lastTwaDeg !== null) {
          fields.windAngle = this.lastTwaDeg * DEG_TO_RAD;
        }
        this.emitPgn(PGN_WIND, fields, ts);
        break;
      }
      case CH_AWA: {
        const deg360 = ((val % 360) + 360) % 360;
        this.lastAwaDeg = deg360;
        const fields: Record<string, any> = {
          windAngle: deg360 * DEG_TO_RAD,
          reference: 'Apparent',
        };
        if (this.lastAwsKts !== null) {
          fields.windSpeed = this.lastAwsKts * KTS_TO_MS;
        }
        this.emitPgn(PGN_WIND, fields, ts);
        break;
      }
      case CH_AWS: {
        this.lastAwsKts = val;
        const fields: Record<string, any> = {
          windSpeed: val * KTS_TO_MS,
          reference: 'Apparent',
        };
        if (this.lastAwaDeg !== null) {
          fields.windAngle = this.lastAwaDeg * DEG_TO_RAD;
        }
        this.emitPgn(PGN_WIND, fields, ts);
        break;
      }
      case CH_BSPD: {
        this.emitPgn(PGN_STW, { speedWaterReferenced: val * KTS_TO_MS }, ts);
        break;
      }
      case CH_SOG: {
        this.emitPgn(PGN_SOG_COG, { sog: val * KTS_TO_MS }, ts);
        break;
      }
      case CH_COG: {
        this.emitPgn(PGN_SOG_COG, { cog: val * DEG_TO_RAD }, ts);
        break;
      }
      case CH_HDG: {
        this.emitPgn(PGN_HEADING, { heading: val * DEG_TO_RAD }, ts);
        break;
      }
      case CH_LAT: {
        this.emitPgn(PGN_POSITION, { latitude: val }, ts);
        break;
      }
      case CH_LON: {
        this.emitPgn(PGN_POSITION, { longitude: val }, ts);
        break;
      }
      case CH_VMG: {
        // Logged but no dashboard tile required — attach to PGN_WIND payload
        // as an auxiliary field so downstream store code can pick it up if
        // it wants without breaking source-agnosticism.
        this.emitPgn(PGN_WIND, { vmg: val * KTS_TO_MS }, ts);
        break;
      }
      case CH_LEE: {
        // Leeway in degrees — attached to PGN_HEADING for downstream storage.
        this.emitPgn(PGN_HEADING, { leeway: val * DEG_TO_RAD }, ts);
        break;
      }
      default:
        // Unknown channel ID — silently ignored.
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Keepalive
  // ---------------------------------------------------------------------------

  private startKeepalive(): void {
    this.clearKeepaliveTimer();
    this.keepaliveTimer = setInterval(() => {
      this.send({ SettingListReq: [{ groupId: 2 }] });
    }, this.keepaliveIntervalMs);
  }

  // ---------------------------------------------------------------------------
  // Reconnect logic
  // ---------------------------------------------------------------------------

  private handleConnectionFailure(message: string): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(`[GoFreeManager] Max reconnect attempts reached: ${message}`);
      this.setState('error', this.targetHost, this.targetPort, message);
      return;
    }
    this.reconnectAttempts++;
    console.log(
      `[GoFreeManager] Reconnecting (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${this.reconnectIntervalMs}ms`,
    );
    this.setState('reconnecting', this.targetHost, this.targetPort);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, this.reconnectIntervalMs);
  }

  // ---------------------------------------------------------------------------
  // Event helpers
  // ---------------------------------------------------------------------------

  private emitPgn(
    pgn: number,
    fields: Record<string, any>,
    timestamp: string,
  ): void {
    const parsed: ParsedPGN = { pgn, fields, timestamp };
    this.emit('pgn', parsed);
  }

  private setState(
    state: GoFreeState,
    ip?: string,
    port?: number,
    error?: string,
  ): void {
    this.state = state;
    const event: GoFreeStatusEvent = { state };
    if (ip !== undefined) event.ip = ip;
    if (port !== undefined) event.port = port;
    if (error !== undefined) event.error = error;
    this.emit('gofree:status', event);
  }

  // ---------------------------------------------------------------------------
  // Cleanup helpers
  // ---------------------------------------------------------------------------

  private resetSessionState(): void {
    this.lastTwaDeg = null;
    this.lastTwsKts = null;
    this.lastAwaDeg = null;
    this.lastAwsKts = null;
    this.discoveryComplete = false;
    if (this.discoveryTimer !== null) {
      clearTimeout(this.discoveryTimer);
      this.discoveryTimer = null;
    }
  }

  private clearKeepaliveTimer(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private cleanupSocket(): void {
    if (this.ws !== null) {
      try {
        this.ws.removeAllListeners?.();
        const rs = this.ws.readyState;
        if (rs === 0 /* CONNECTING */ || rs === 1 /* OPEN */) {
          this.ws.close?.();
        } else {
          this.ws.terminate?.();
        }
      } catch {
        // Ignore cleanup errors
      }
      this.ws = null;
    }
  }
}
