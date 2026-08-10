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

// How long to wait for DataList response before falling back to direct subscription.
const DISCOVERY_TIMEOUT_MS = 3_000;

// How long to wait for all DataInfo responses before sending DataReq anyway.
const DATA_INFO_TIMEOUT_MS = 3_000;

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
   * How long to wait for DataInfo responses before sending DataReq anyway (default 3000).
   * Set to a smaller value in tests that simulate sequential DataInfo responses.
   */
  dataInfoTimeoutMs?: number;
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
  /** H5000 often sends string values (e.g. "2.45909e+06") instead of numeric val. */
  valStr?: string;
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

  // Sequential subscription state: track DataInfo responses before sending DataReq.
  private pendingDataInfo = new Set<number>();
  private pendingDataReqIds: number[] = [];
  private dataInfoTimer: ReturnType<typeof setTimeout> | null = null;

  private targetHost = '192.168.1.233';
  private targetPort = 2053;

  private readonly keepaliveIntervalMs: number;
  private readonly reconnectIntervalMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly dataInfoTimeoutMs: number;
  private readonly WebSocketImpl: any;

  constructor(options?: GoFreeManagerOptions) {
    super();
    this.keepaliveIntervalMs =
      options?.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
    this.reconnectIntervalMs =
      options?.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS;
    this.maxReconnectAttempts =
      options?.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS;
    this.dataInfoTimeoutMs =
      options?.dataInfoTimeoutMs ?? DATA_INFO_TIMEOUT_MS;
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
        this.emit('debug', '[GoFree] DataList timeout — sending DataInfoReq for required IDs');
        this.sendDataInfoReqPhase(REQUIRED_CHANNEL_IDS);
      }
    }, DISCOVERY_TIMEOUT_MS);
  }

  /**
   * Step 2a: send DataInfoReq for all available channel IDs.
   * DataReq is NOT sent yet — we wait for DataInfo responses from the H5000
   * to complete the registration handshake before requesting streaming data.
   * This sequencing requirement is confirmed by the WsLogger reference
   * implementation (B&G engineer, andy.bryson@navico.com).
   */
  private subscribeAll(availableIds: number[]): void {
    this.discoveryComplete = true;
    if (this.discoveryTimer !== null) {
      clearTimeout(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    this.emit('debug', `[GoFree] Step 2a: Sending DataInfoReq for ${availableIds.length} channels`);
    this.sendDataInfoReqPhase(availableIds);
  }

  /**
   * Send DataInfoReq in batches and arm the DataInfo-wait state machine.
   * DataReq is deferred until all expected DataInfo responses arrive
   * (or the dataInfoTimeoutMs fallback fires).
   */
  private sendDataInfoReqPhase(ids: number[], batchSize = 40): void {
    this.pendingDataInfo.clear();
    for (const id of ids) {
      this.pendingDataInfo.add(id);
    }
    this.pendingDataReqIds = ids;

    for (let i = 0; i < ids.length; i += batchSize) {
      this.send({ DataInfoReq: ids.slice(i, i + batchSize) });
    }

    // Safety net: if DataInfo responses don't all arrive, send DataReq anyway.
    this.dataInfoTimer = setTimeout(() => {
      this.dataInfoTimer = null;
      if (this.pendingDataInfo.size > 0) {
        this.emit('debug',
          `[GoFree] DataInfo timeout — ${this.pendingDataInfo.size} response(s) missing, sending DataReq`);
        this.pendingDataInfo.clear();
        const idsToRequest = this.pendingDataReqIds;
        this.pendingDataReqIds = [];
        this.sendDataReqPhase(idsToRequest);
      }
    }, this.dataInfoTimeoutMs);
  }

  /**
   * Handle a DataInfo response from the H5000.
   * When all expected DataInfo have arrived, send the DataReq to start streaming.
   */
  private handleDataInfoResponse(info: any): void {
    // DataInfo can arrive as a single object {id, ...} or an array.
    const ids: number[] = Array.isArray(info)
      ? info.map((i: any) => i?.id).filter((id: any) => typeof id === 'number')
      : typeof info?.id === 'number' ? [info.id] : [];

    for (const id of ids) {
      this.pendingDataInfo.delete(id);
    }

    if (this.pendingDataInfo.size === 0 && this.pendingDataReqIds.length > 0) {
      if (this.dataInfoTimer !== null) {
        clearTimeout(this.dataInfoTimer);
        this.dataInfoTimer = null;
      }
      const idsToRequest = this.pendingDataReqIds;
      this.pendingDataReqIds = [];
      this.emit('debug',
        `[GoFree] Step 2b: All DataInfo received — sending DataReq for ${idsToRequest.length} channels`);
      this.sendDataReqPhase(idsToRequest);
    }
  }

  /**
   * Step 2b: send DataReq in batches to start streaming data.
   * Called only after all DataInfo responses have been received (or timeout).
   * `repeat: true` is the correct boolean type per the official B&G WsLogger.
   */
  private sendDataReqPhase(ids: number[], batchSize = 40): void {
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      this.send({ DataReq: batch.map((id) => ({ id, repeat: true, inst: 0 })) });
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

    // Step 1 response: DataList → send DataInfoReq for all available channels
    if (parsed.DataList != null) {
      const available: number[] = Array.isArray(parsed.DataList.list)
        ? parsed.DataList.list
        : [];
      this.emit('debug', `[GoFree] DataList received — ${available.length} channels available`);
      const toSubscribe = available.length > 0 ? available : REQUIRED_CHANNEL_IDS;
      this.subscribeAll(toSubscribe);
      return;
    }

    // Step 2a response: DataInfo → track registration completeness, then send DataReq
    if (parsed.DataInfo != null) {
      this.handleDataInfoResponse(parsed.DataInfo);
      return;
    }

    if (Array.isArray(parsed.Many)) {
      for (const item of parsed.Many) {
        if (item?.DataInfo != null) {
          this.handleDataInfoResponse(item.DataInfo);
        }
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

      // Prefer numeric val; fall back to valStr (H5000 often sends string values
      // including scientific notation, e.g. "2.45909e+06").
      let numVal: number;
      if (o.val !== undefined && o.val !== null && Number.isFinite(Number(o.val))) {
        numVal = Number(o.val);
      } else if (o.valStr !== undefined && o.valStr !== null) {
        const parsed = parseFloat(o.valStr);
        if (!Number.isFinite(parsed)) continue;
        numVal = parsed;
      } else {
        continue;
      }

      this.handleObservation(o, numVal);
    }
  }

  private handleObservation(o: Observation, val: number): void {
    const ts = new Date().toISOString();

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
    this.pendingDataInfo.clear();
    this.pendingDataReqIds = [];
    if (this.dataInfoTimer !== null) {
      clearTimeout(this.dataInfoTimer);
      this.dataInfoTimer = null;
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
