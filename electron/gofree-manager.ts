/**
 * GoFree Ethernet Data Source Manager (GoFree Tier 2 / WebSocket)
 *
 * Connects to the B&G H5000 CPU via WebSocket (default `ws://192.168.1.233:2053`),
 * polls the required channel IDs with one-shot `DataReq` (repeat:false) messages,
 * and converts the resulting JSON observations into ParsedPGN events so the
 * downstream pipeline (Dashboard, analysis engine, recording) treats GoFree data
 * identically to NGT-1 data.
 *
 * Architecture:
 *   H5000 → WebSocket :2053 → GoFree Tier 2 JSON → GoFreeManager → ParsedPGN → common N2K pipeline
 *
 * Polling model (BE5):
 *   Two independent poll groups with separate timers:
 *   - Fast group (CH_BSPD, CH_TWA, CH_TWS, CH_AWA, CH_AWS): default 200 ms / 5 Hz.
 *   - Normal group (CH_SOG, CH_COG, CH_HDG, CH_VMG, CH_LEE, CH_LAT, CH_LON): default 1000 ms / 1 Hz.
 *   Each channel is polled individually with repeat:false. Boat-confirmed: multi-channel
 *   DataReq with repeat:false is silently dropped by the H5000 firmware.
 *
 * Freshness design (BE2 / BE5):
 *   We chose 'stale' state over forced reconnect when the watchdog fires. Rationale:
 *   a silent H5000 is a data-layer problem (instrument may be off, GPS lost, etc.),
 *   not a transport-layer problem. Tearing down a healthy TCP connection would add
 *   reconnect overhead and mask the real cause. If data resumes we flip back to
 *   'connected' without a reconnect cycle.
 *   Per-channel stale windows are 2 × the channel's own group interval
 *   (fast channels stale after ~400 ms, normal channels stale after ~2 000 ms).
 *
 * Reconnect model (BE6):
 *   Indefinite reconnection with capped exponential backoff:
 *     1 s → 2 s → 5 s → 10 s → 10 s → ...
 *   Backoff resets only after `sustainedDataResetMs` (default 5 000 ms) of
 *   continuous valid observations while state remains 'connected'. A bare WebSocket
 *   'open' event does NOT reset the backoff index.
 *
 *   The `error` terminal state is reserved exclusively for a failed WebSocket
 *   constructor (e.g. malformed URL). All transport-layer failures (unexpected close,
 *   'error' event) are handled by indefinite backoff reconnection.
 *
 * Channel probing (BE4):
 *   One-time diagnostic channel probing is disabled by default (`enableChannelProbe:
 *   false`). Set `enableChannelProbe: true` to send a one-shot DataReq for every
 *   channel in the DataList that is not already in REQUIRED_CHANNEL_IDS. Passive
 *   logging of unknown channel IDs arriving in normal poll responses is always on.
 *
 * Send safety (BE7):
 *   Every `send()` call checks `ws.readyState === WS_READY_STATE_OPEN` (1) before
 *   transmitting. The try/catch below that is belt-and-braces.
 *
 * Emits:
 *   'pgn'              — ParsedPGN objects (same shape as SerialManager)
 *   'gofree:status'    — GoFreeStatusEvent with connection state updates
 *   'gofree:freshness' — GoFreeFreshnessEvent with per-value staleness info (BE2)
 *
 * IMPORTANT: This manager NEVER sends the NGT-1 BST initialization command
 * `[0x11, 0x02, 0x00]`. That command is specific to the Actisense NGT-1 serial
 * device and remains entirely within serial-manager.ts.
 *
 * Deprecated options (kept for backward compatibility):
 *   pollIntervalMs      — sets both fastPollIntervalMs and normalPollIntervalMs.
 *   reconnectIntervalMs — derives a backoff ladder scaled from the supplied value.
 *   maxReconnectAttempts — ignored; reconnection is now indefinite.
 */

import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import type { ParsedPGN } from './serial-manager';

// Unit conversions to match the NGT-1 pipeline (m/s and radians).
const KTS_TO_MS = 1 / 1.94384;
const DEG_TO_RAD = Math.PI / 180;

// Timer / reconnect defaults (PRD-specified).
const DEFAULT_KEEPALIVE_INTERVAL_MS = 30_000;

// BE5: Fast group default ~5 Hz; normal group default ~1 Hz.
const DEFAULT_FAST_POLL_INTERVAL_MS = 200;
const DEFAULT_NORMAL_POLL_INTERVAL_MS = 1_000;

// BE6: Capped exponential backoff ladder (ms).  Last value repeats indefinitely.
const DEFAULT_BACKOFF_LADDER_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000];

// BE6: Sustained-data window after which backoff index resets to 0.
// Default matches DEFAULT_WATCHDOG_TIMEOUT_MS so one watchdog-window without a stale
// transition counts as "reliably connected".
const DEFAULT_SUSTAINED_DATA_RESET_MS = 5_000;

// How long to wait for DataList response before subscribing directly.
const DISCOVERY_TIMEOUT_MS = 3_000;

// BE2: Watchdog — transition to 'stale' if no valid observations for this long.
const DEFAULT_WATCHDOG_TIMEOUT_MS = 5_000;

// BE3: Maximum age of a cached wind companion value before it is too old to
// pair with a fresh reading.  1 500 ms comfortably brackets the current poll
// model: at 200 ms fast-poll each value arrives ≤ 200 ms apart.
const MAX_WIND_PAIRING_AGE_MS = 1_500;

// BE7: Numeric constant for WebSocket.OPEN so it is named rather than magic.
const WS_READY_STATE_OPEN = 1;

// N2K PGN numbers emitted downstream so consumers are source-agnostic.
const PGN_WIND = 130306;      // Wind Data
const PGN_STW = 128259;       // Speed - Water Referenced
const PGN_SOG_COG = 129026;   // COG & SOG - Rapid Update
const PGN_POSITION = 129025;  // Position - Rapid Update
const PGN_HEADING = 127250;   // Vessel Heading

// GoFree Tier 2 channel IDs (H5000) — confirmed by boat test (2026-08-23).
//
// IMPORTANT: Two classes of channel on this firmware:
//
//   repeat:false (polled)  — low-numbered channels (≤ 77) respond to one-shot
//     DataReq. These are sent every fast/normal poll tick.
//
//   repeat:true (streaming) — higher-numbered channels (≥ 118) silently ignore
//     repeat:false. Must be subscribed once with repeat:true; the H5000 then
//     streams updates continuously. AWA/TWA calibrated values and GPS all fall
//     in this class. See STREAMING_CHANNEL_IDS below.
//
// Channel mapping discovered via DataReq probe (2026-08-23 boat test):
//   ch44/45  = raw uncalibrated masthead AWA/TWA — always returns 0.0
//   ch140    = calibrated AWA  (~146° observed, repeat:true required)
//   ch141    = calibrated TWA  (~146° observed, repeat:true required)
//   ch46/47  = AWS/TWS — respond to repeat:false, values correct
//   ch37     = Heading — repeat:false, correct
//   ch41/42  = SOG/BSPD — repeat:false
//   ch421/422 = not present on this firmware
//   ch309    = GPS Latitude  (repeat:true, streams "40°042.653' N" etc.)
//   ch310    = GPS Longitude (repeat:true, streams "074°002.760' W" etc.)
const CH_AWA = 140;  // Calibrated Apparent Wind Angle (repeat:true)
const CH_TWA = 141;  // Calibrated True Wind Angle     (repeat:true)
const CH_TWS = 47;   // True Wind Speed
const CH_BSPD = 42;  // Boat Speed (water-referenced)
const CH_SOG = 41;   // Speed Over Ground
const CH_COG = 9;    // Course Over Ground
const CH_HDG = 37;   // Vessel Heading
const CH_LAT = 309;  // GPS Latitude  (repeat:true; ch421 not on this firmware)
const CH_LON = 310;  // GPS Longitude (repeat:true; ch422 not on this firmware)
const CH_AWS = 46;   // Apparent Wind Speed
const CH_VMG = 235;  // VMG
const CH_LEE = 226;  // Leeway

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

/**
 * Channels excluded from freshness/staleness tracking.
 * These are subscribed so they work if the firmware supports them, but they
 * are NOT counted as stale when absent — the H5000 may not expose them on
 * all firmware versions (e.g. GPS position channels).
 */
const OPTIONAL_CHANNEL_IDS: ReadonlySet<number> = new Set([CH_LAT, CH_LON]);

/**
 * Channels that use streaming subscription (repeat:true) rather than polled
 * DataReq (repeat:false). Subscribed once on connect; the H5000 then pushes
 * updates continuously without further requests. These channels silently ignore
 * repeat:false — confirmed by boat test 2026-08-23.
 */
const STREAMING_CHANNEL_IDS: ReadonlySet<number> = new Set([
  CH_AWA, CH_TWA, CH_LAT, CH_LON,
]);

/**
 * BE5: Fast-group channel IDs — polled at fastPollIntervalMs (default 200 ms).
 * Streaming channels (AWA, TWA, LAT, LON) are excluded — they push data
 * continuously and are not polled. All other REQUIRED_CHANNEL_IDS belong to
 * the normal group (default 1 000 ms).
 */
const FAST_CHANNEL_IDS: ReadonlySet<number> = new Set([
  CH_BSPD, CH_TWS, CH_AWS,
]);

export type GoFreeState =
  | 'connecting'
  | 'connected'
  | 'stale'          // BE2: socket is open but no valid H5000 data for watchdogTimeoutMs
  | 'reconnecting'
  | 'error'          // BE6: reserved for terminal constructor failures (malformed URL)
  | 'disconnected';

export interface GoFreeStatusEvent {
  state: GoFreeState;
  ip?: string;
  port?: number;
  error?: string;
}

/**
 * BE2: Per-value freshness event emitted on every poll tick.
 * The renderer should display '--' for any tile whose channel is in staleChannels.
 */
export interface GoFreeFreshnessEvent {
  /**
   * Channel IDs whose last valid observation is older than 2 × (their group's poll interval).
   * Fast channels: stale after 2 × fastPollIntervalMs (~400 ms default).
   * Normal channels: stale after 2 × normalPollIntervalMs (~2 000 ms default).
   */
  staleChannels: number[];
}

export interface GoFreeManagerOptions {
  /** Keepalive tick interval in ms (default 30000). */
  keepaliveIntervalMs?: number;
  /**
   * @deprecated Use fastPollIntervalMs and normalPollIntervalMs instead.
   * When supplied, overrides both fast and normal poll intervals.
   */
  pollIntervalMs?: number;
  /**
   * @deprecated Use backoffLadderMs instead.
   * When supplied, a backoff ladder is derived from this value.
   */
  reconnectIntervalMs?: number;
  /**
   * @deprecated Reconnection is now indefinite; this option is silently ignored.
   */
  maxReconnectAttempts?: number;
  /**
   * BE2: Watchdog timeout in ms. If no valid H5000 observations arrive for this
   * period while the socket is open, the manager transitions to 'stale' state.
   * Default 5000 ms. Set to 0 to disable.
   */
  watchdogTimeoutMs?: number;
  /**
   * BE4: Enable one-time diagnostic probe of all DataList channels not in
   * REQUIRED_CHANNEL_IDS. Default false. Only enable during development/debugging.
   */
  enableChannelProbe?: boolean;
  /**
   * BE5: Poll interval for the fast group (BSPD, TWA, TWS, AWA, AWS) in ms.
   * Default 200 ms (~5 Hz). Do not go below 100 ms on the H5000.
   */
  fastPollIntervalMs?: number;
  /**
   * BE5: Poll interval for the normal group (SOG, COG, HDG, VMG, LEE, LAT, LON) in ms.
   * Default 1000 ms (~1 Hz).
   */
  normalPollIntervalMs?: number;
  /**
   * BE6: Backoff ladder in ms. The last value is used indefinitely.
   * Default [1000, 2000, 5000, 10000].
   */
  backoffLadderMs?: number[];
  /**
   * BE6: How long (ms) the manager must be in 'connected' state with continuous
   * valid observations before the backoff index resets to 0.
   * Default matches watchdogTimeoutMs (5000 ms).
   */
  sustainedDataResetMs?: number;
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

/** BE3: Timestamped wind value for stale-pairing prevention. */
interface WindRecord {
  value: number;
  ts: number;
}

export class GoFreeManager extends EventEmitter {
  private state: GoFreeState = 'disconnected';
  private ws: any = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  // BE5: separate fast and normal poll timers.
  private fastPollTimer: ReturnType<typeof setInterval> | null = null;
  private normalPollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdogTimer: ReturnType<typeof setTimeout> | null = null;    // BE2
  private sustainedDataTimer: ReturnType<typeof setTimeout> | null = null; // BE6

  // BE6: backoff index into backoffLadderMs; increments on each failure.
  private backoffIndex = 0;

  // BE5: channels split into fast and normal groups after DataList discovery.
  private fastPollChannels: number[] = [];
  private normalPollChannels: number[] = [];

  // BE3: Wind pairing accumulators with timestamps. Angles are stored
  // already normalized to 0–360°.  We only combine angle + speed into a
  // single PGN 130306 when the cached companion is ≤ MAX_WIND_PAIRING_AGE_MS old.
  private lastTwa: WindRecord | null = null;
  private lastTws: WindRecord | null = null;
  private lastAwa: WindRecord | null = null;
  private lastAws: WindRecord | null = null;

  private discoveryComplete = false;

  // BE2: Freshness tracking.
  private lastValidObservationAt: number | null = null;
  private lastSeenAt: Map<number, number> = new Map();

  private targetHost = '192.168.1.233';
  private targetPort = 2053;

  private readonly keepaliveIntervalMs: number;
  private readonly fastPollIntervalMs: number;
  private readonly normalPollIntervalMs: number;
  // BE5: pre-computed stale windows per group (2 × poll interval).
  private readonly fastStaleWindowMs: number;
  private readonly normalStaleWindowMs: number;
  private readonly backoffLadderMs: readonly number[];
  private readonly sustainedDataResetMs: number;
  private readonly watchdogTimeoutMs: number;
  private readonly enableChannelProbe: boolean;
  private readonly WebSocketImpl: any;

  constructor(options?: GoFreeManagerOptions) {
    super();
    this.keepaliveIntervalMs =
      options?.keepaliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
    this.watchdogTimeoutMs =
      options?.watchdogTimeoutMs ?? DEFAULT_WATCHDOG_TIMEOUT_MS;
    this.WebSocketImpl = options?.WebSocketImpl ?? WebSocket;

    // BE4: diagnostic probe disabled by default.
    this.enableChannelProbe = options?.enableChannelProbe ?? false;

    // BE5: pollIntervalMs backward-compat — treats it as override for both groups.
    const legacyPoll = options?.pollIntervalMs;
    this.fastPollIntervalMs =
      options?.fastPollIntervalMs ?? legacyPoll ?? DEFAULT_FAST_POLL_INTERVAL_MS;
    this.normalPollIntervalMs =
      options?.normalPollIntervalMs ?? legacyPoll ?? DEFAULT_NORMAL_POLL_INTERVAL_MS;
    this.fastStaleWindowMs = 2 * this.fastPollIntervalMs;
    this.normalStaleWindowMs = 2 * this.normalPollIntervalMs;

    // BE6: backoffLadderMs — can be set directly, or derived from legacy reconnectIntervalMs.
    const legacyReconnect = options?.reconnectIntervalMs;
    if (options?.backoffLadderMs !== undefined) {
      this.backoffLadderMs = options.backoffLadderMs;
    } else if (legacyReconnect !== undefined) {
      // Derive a proportional ladder so legacy test timing still works.
      const v = legacyReconnect;
      this.backoffLadderMs = [v, v * 2, Math.min(v * 5, 10_000), 10_000];
    } else {
      this.backoffLadderMs = DEFAULT_BACKOFF_LADDER_MS;
    }
    this.sustainedDataResetMs =
      options?.sustainedDataResetMs ?? DEFAULT_SUSTAINED_DATA_RESET_MS;
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
    this.backoffIndex = 0;
    this.openSocket();
  }

  /** Close the socket cleanly and cancel all timers. */
  async disconnect(): Promise<void> {
    this.clearReconnectTimer();
    this.resetForReconnect();
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
      // BE6: WebSocket constructor failure is a terminal error (e.g. malformed URL).
      // Do not schedule a reconnect for this class of failure.
      const msg = `WebSocket construction failed: ${(err as Error).message}`;
      console.error(`[GoFreeManager] ${msg}`);
      this.setState('error', this.targetHost, this.targetPort, msg);
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      // BE6: do NOT reset backoffIndex here — reset only after sustained valid data.
      this.setState('connected', this.targetHost, this.targetPort);
      console.log(`[GoFreeManager] WebSocket connected to ${url}`);
      this.startDiscovery();
      this.startKeepalive();
      this.startWatchdog();          // BE2: begin liveness monitoring
      this.startSustainedDataTimer(); // BE6: begin sustained-data window
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
      const msg = `WebSocket closed${code != null ? ` (code=${code})` : ''}`;
      this.emit('debug', `[GoFree] ${msg}`);
      this.cleanupSocket();
      if (this.state === 'disconnected') return; // user-initiated close
      this.handleConnectionFailure(msg);
    });
  }

  /**
   * Step 1: request the full channel list from the H5000.
   * On success we subscribe to required channels (step 2).
   * Fallback: if no DataList arrives in time, subscribe directly to
   * REQUIRED_CHANNEL_IDS with inst=0.
   */
  private startDiscovery(): void {
    this.discoveryComplete = false;
    this.emit('debug', '[GoFree] Step 1: Sending DataListReq (group 40)');
    this.send({ DataListReq: { group: 40 } });

    this.discoveryTimer = setTimeout(() => {
      this.discoveryTimer = null;
      if (!this.discoveryComplete) {
        this.emit('debug', '[GoFree] DataList timeout — subscribing to required channels directly');
        this.subscribeAll([]);
      }
    }, DISCOVERY_TIMEOUT_MS);
  }

  /**
   * Step 2: split channels into fast and normal groups and start two independent
   * poll timers. Both use repeat:false DataReq — one message per channel.
   *
   * BE4: One-time diagnostic channel probe is only executed when
   * enableChannelProbe === true. By default it is skipped.
   */
  private subscribeAll(availableIds: number[]): void {
    this.discoveryComplete = true;
    this.clearDiscoveryTimer();

    // Log which required channels are absent from the DataList (informational only).
    if (availableIds.length > 0) {
      const available = new Set(availableIds);
      const missing = REQUIRED_CHANNEL_IDS.filter((id) => !available.has(id));
      if (missing.length > 0) {
        this.emit(
          'debug',
          `[GoFree] Note: ${missing.length} required channel(s) absent from DataList (will poll anyway): ${missing.join(',')}`,
        );
      }
    }

    // Subscribe streaming channels once with repeat:true. These channels
    // (AWA, TWA, LAT, LON) silently ignore repeat:false — they must be
    // subscribed once and then push data continuously.
    const streamingChannels = REQUIRED_CHANNEL_IDS.filter((id) => STREAMING_CHANNEL_IDS.has(id));
    if (streamingChannels.length > 0) {
      this.emit(
        'debug',
        `[GoFree] Step 2a: Subscribing ${streamingChannels.length} streaming channels (repeat:true): ${streamingChannels.join(',')}`,
      );
      for (const id of streamingChannels) {
        this.send({ DataReq: [{ id, repeat: true, inst: 0 }] });
      }
    }

    // BE5: split non-streaming REQUIRED_CHANNEL_IDS into fast and normal poll groups.
    this.fastPollChannels = REQUIRED_CHANNEL_IDS.filter(
      (id) => FAST_CHANNEL_IDS.has(id) && !STREAMING_CHANNEL_IDS.has(id),
    );
    this.normalPollChannels = REQUIRED_CHANNEL_IDS.filter(
      (id) => !FAST_CHANNEL_IDS.has(id) && !STREAMING_CHANNEL_IDS.has(id),
    );

    this.emit(
      'debug',
      `[GoFree] Step 2b: Polling ${this.fastPollChannels.length} fast channels every ${this.fastPollIntervalMs} ms` +
      ` + ${this.normalPollChannels.length} normal channels every ${this.normalPollIntervalMs} ms (repeat:false)`,
    );

    // BE4: One-time diagnostic probe — only when explicitly enabled.
    if (this.enableChannelProbe && availableIds.length > 0) {
      const knownSet = new Set(REQUIRED_CHANNEL_IDS);
      const probeIds = availableIds.filter((id) => !knownSet.has(id));

      // Channels ≤ 100 respond to one-shot DataReq (repeat:false) and are
      // probed once. Higher-numbered channels appear to require streaming
      // subscriptions (repeat:true) — the H5000 silently ignores repeat:false
      // for these (confirmed: no PROBE log appears for channels 118–515 with
      // repeat:false). Subscribe them with repeat:true so they stream data and
      // we can identify which channel carries the calibrated AWA/TWA value.
      const lowIds = probeIds.filter((id) => id <= 100);
      const highIds = probeIds.filter((id) => id > 100);

      this.emit(
        'debug',
        `[GoFree PROBE] One-shot probing ${lowIds.length} channels ≤ 100 (repeat:false)…`,
      );
      for (const id of lowIds) {
        this.send({ DataReq: [{ id, repeat: false, inst: 0 }] });
      }

      if (highIds.length > 0) {
        this.emit(
          'debug',
          `[GoFree PROBE] Streaming probe of ${highIds.length} channels > 100 (repeat:true) — look for channel with AWA value (~145°)…`,
        );
        for (const id of highIds) {
          this.send({ DataReq: [{ id, repeat: true, inst: 0 }] });
        }
      }
    }

    // Poll immediately so the dashboard fills in without waiting for the first tick.
    this.sendFastPoll();
    this.sendNormalPoll();
    this.startFastPollTimer();
    this.startNormalPollTimer();
  }

  /**
   * Send one DataReq (repeat:false) per fast-group channel.
   *
   * The H5000 only responds to single-channel DataReq — a multi-channel
   * DataReq with repeat:false is silently dropped (confirmed by boat test).
   */
  private sendFastPoll(): void {
    for (const id of this.fastPollChannels) {
      this.send({ DataReq: [{ id, repeat: false, inst: 0 }] });
    }
  }

  /** Send one DataReq (repeat:false) per normal-group channel. */
  private sendNormalPoll(): void {
    for (const id of this.normalPollChannels) {
      this.send({ DataReq: [{ id, repeat: false, inst: 0 }] });
    }
  }

  private startFastPollTimer(): void {
    this.clearFastPollTimer();
    this.fastPollTimer = setInterval(() => {
      this.sendFastPoll();
      this.emitFreshness(); // BE2: freshness on every fast tick for timely stale detection
    }, this.fastPollIntervalMs);
  }

  private startNormalPollTimer(): void {
    this.clearNormalPollTimer();
    this.normalPollTimer = setInterval(() => {
      this.sendNormalPoll();
      this.emitFreshness(); // BE2: also emit on normal tick
    }, this.normalPollIntervalMs);
  }

  /**
   * BE7: Transmit a JSON payload. Checks readyState before sending.
   * WS_READY_STATE_OPEN (1) is the only state that accepts sends.
   * The try/catch is belt-and-braces in case the socket closes between the
   * readyState check and the actual send call.
   */
  private send(obj: any): void {
    if (!this.ws || this.ws.readyState !== WS_READY_STATE_OPEN) return;
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

    // Step 1 response: DataList → subscribe to required channels
    if (parsed.DataList != null) {
      const available: number[] = Array.isArray(parsed.DataList.list)
        ? parsed.DataList.list
        : [];
      // Log the full channel list so we can identify unknown channels.
      this.emit(
        'debug',
        `[GoFree] DataList received — ${available.length} channels: [${available.join(',')}]`,
      );
      this.subscribeAll(available.length > 0 ? available : []);
      return;
    }

    // DataInfo — log it for diagnostics (we don't use it for subscription logic).
    if (Array.isArray(parsed.DataInfo)) {
      const ids = (parsed.DataInfo as any[])
        .map((item: any) => item?.id)
        .filter((id: any) => typeof id === 'number');
      this.emit('debug', `[GoFree DataInfo] received for ${ids.length} channel(s): ${ids.join(',')}`);
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
    let validCount = 0;
    for (const o of obs) {
      if (!o || typeof o.id !== 'number') continue;
      if (o.valid === false) {
        // In probe mode, log invalid responses so we can see if the H5000 is
        // responding at all for high-numbered channels (diagnosis for AWA/TWA).
        if (this.enableChannelProbe) {
          this.emit(
            'debug',
            `[GoFree PROBE-INVALID] ch${o.id}: valid=false val=${o.val ?? 'n/a'} valStr="${o.valStr ?? ''}"`,
          );
        }
        continue; // discard invalid observations
      }

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

      validCount++;
      this.handleObservation(o, numVal);
    }

    // BE2: Update liveness tracking whenever at least one valid observation is accepted.
    if (validCount > 0) {
      this.lastValidObservationAt = Date.now();
      // Only reset the watchdog when we have an active connection.
      if (this.state === 'connected' || this.state === 'stale') {
        this.resetWatchdog();
      }
    }
  }

  private handleObservation(o: Observation, val: number): void {
    const now = Date.now();
    const ts = new Date(now).toISOString();

    // BE2: Record when this channel was last seen for per-value freshness.
    this.lastSeenAt.set(o.id, now);

    switch (o.id) {
      case CH_TWA: {
        // Signed degrees (negative = port). Normalize to 0–360° so downstream
        // normalizeWindAngle() logic matches the NGT-1 path.
        this.emit('debug', `[GoFree ch45/TWA] raw val=${val.toFixed(4)}`);
        const deg360 = ((val % 360) + 360) % 360;
        this.lastTwa = { value: deg360, ts: now };  // BE3: store with timestamp
        const fields: Record<string, any> = {
          windAngle: deg360 * DEG_TO_RAD,
          reference: 'True (boat referenced)',
        };
        // BE3: Only include TWS if the cached companion is fresh enough.
        if (this.lastTws !== null && (now - this.lastTws.ts) <= MAX_WIND_PAIRING_AGE_MS) {
          fields.windSpeed = this.lastTws.value * KTS_TO_MS;
        }
        this.emitPgn(PGN_WIND, fields, ts);
        break;
      }
      case CH_TWS: {
        this.lastTws = { value: val, ts: now };  // BE3: store with timestamp
        const fields: Record<string, any> = {
          windSpeed: val * KTS_TO_MS,
          reference: 'True (boat referenced)',
        };
        // BE3: Only include TWA if the cached companion is fresh enough.
        if (this.lastTwa !== null && (now - this.lastTwa.ts) <= MAX_WIND_PAIRING_AGE_MS) {
          fields.windAngle = this.lastTwa.value * DEG_TO_RAD;
        }
        this.emitPgn(PGN_WIND, fields, ts);
        break;
      }
      case CH_AWA: {
        this.emit('debug', `[GoFree ch44/AWA] raw val=${val.toFixed(4)}`);
        const deg360 = ((val % 360) + 360) % 360;
        this.lastAwa = { value: deg360, ts: now };  // BE3: store with timestamp
        const fields: Record<string, any> = {
          windAngle: deg360 * DEG_TO_RAD,
          reference: 'Apparent',
        };
        // BE3: Only include AWS if the cached companion is fresh enough.
        if (this.lastAws !== null && (now - this.lastAws.ts) <= MAX_WIND_PAIRING_AGE_MS) {
          fields.windSpeed = this.lastAws.value * KTS_TO_MS;
        }
        this.emitPgn(PGN_WIND, fields, ts);
        break;
      }
      case CH_AWS: {
        this.lastAws = { value: val, ts: now };  // BE3: store with timestamp
        const fields: Record<string, any> = {
          windSpeed: val * KTS_TO_MS,
          reference: 'Apparent',
        };
        // BE3: Only include AWA if the cached companion is fresh enough.
        if (this.lastAwa !== null && (now - this.lastAwa.ts) <= MAX_WIND_PAIRING_AGE_MS) {
          fields.windAngle = this.lastAwa.value * DEG_TO_RAD;
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
        // Unknown channel — passive log for diagnostics (BE4: always on, no probing).
        this.emit(
          'debug',
          `[GoFree PROBE] ch${o.id}: val=${val.toFixed(4)} valStr="${o.valStr ?? ''}"`,
        );
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // BE2: Data-freshness watchdog
  // ---------------------------------------------------------------------------

  /**
   * Start (or restart) the watchdog timer.  If no valid observations arrive
   * within watchdogTimeoutMs the manager transitions to 'stale'.
   */
  private startWatchdog(): void {
    if (this.watchdogTimeoutMs <= 0) return;
    this.clearWatchdogTimer();
    this.watchdogTimer = setTimeout(() => {
      this.watchdogTimer = null;
      if (this.state === 'connected' || this.state === 'stale') {
        this.setState('stale', this.targetHost, this.targetPort);
      }
    }, this.watchdogTimeoutMs);
  }

  /**
   * Called whenever a valid observation arrives while connected.
   * Transitions out of 'stale' back to 'connected' and resets the watchdog window.
   */
  private resetWatchdog(): void {
    if (this.state === 'stale') {
      this.setState('connected', this.targetHost, this.targetPort);
    }
    this.startWatchdog();
  }

  /**
   * BE2: Emit a freshness snapshot on every poll tick.
   * BE5: Each channel's stale window is 2 × its own group's poll interval.
   */
  private emitFreshness(): void {
    const now = Date.now();
    const staleChannels: number[] = [];

    for (const channelId of REQUIRED_CHANNEL_IDS) {
      // Optional channels (e.g. GPS position) are subscribed but not tracked
      // for staleness — they may not be exposed on all H5000 firmware versions.
      if (OPTIONAL_CHANNEL_IDS.has(channelId)) continue;
      const lastSeen = this.lastSeenAt.get(channelId);
      const staleWindowMs = FAST_CHANNEL_IDS.has(channelId)
        ? this.fastStaleWindowMs
        : this.normalStaleWindowMs;
      if (lastSeen === undefined || (now - lastSeen) > staleWindowMs) {
        staleChannels.push(channelId);
      }
    }

    const event: GoFreeFreshnessEvent = { staleChannels };
    this.emit('gofree:freshness', event);
  }

  // ---------------------------------------------------------------------------
  // BE6: Sustained-data timer — resets backoff after stable connection window
  // ---------------------------------------------------------------------------

  /**
   * Start the sustained-data timer. If it fires while still 'connected', the
   * backoff index is reset to 0, treating this connection as reliably established.
   * Cleared by resetForReconnect() if the connection drops before it fires.
   */
  private startSustainedDataTimer(): void {
    this.clearSustainedDataTimer();
    this.sustainedDataTimer = setTimeout(() => {
      this.sustainedDataTimer = null;
      if (this.state === 'connected') {
        this.backoffIndex = 0;
      }
    }, this.sustainedDataResetMs);
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
  // BE6: Reconnect logic with capped exponential backoff
  // ---------------------------------------------------------------------------

  /**
   * BE1 + BE6: Central failure handler. Clears ALL timers and session state
   * (via resetForReconnect) before scheduling a reconnect attempt so that
   * old timers can never fire against a newly opened socket.
   *
   * BE6: Uses the backoff ladder; increments backoffIndex on each failure.
   * Reconnection is indefinite — no terminal state is set here.
   */
  private handleConnectionFailure(message: string): void {
    this.resetForReconnect();  // BE1: clear everything before reconnect

    const delay =
      this.backoffLadderMs[Math.min(this.backoffIndex, this.backoffLadderMs.length - 1)];
    this.backoffIndex++;

    console.log(
      `[GoFreeManager] Reconnecting (attempt ${this.backoffIndex}, delay ${delay}ms): ${message}`,
    );
    this.setState('reconnecting', this.targetHost, this.targetPort);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
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
  // BE1: Cleanup helpers — resetForReconnect() is the single authority
  // ---------------------------------------------------------------------------

  /**
   * BE1: Clear ALL connection/session timers and pending state so that no
   * timer can fire against a subsequent (re)connection's socket.
   *
   * Called by:
   *   - disconnect()            — user-initiated clean shutdown
   *   - handleConnectionFailure — unexpected close / reconnect path
   *
   * Does NOT clear reconnectTimer (handled separately by disconnect/connect).
   * Does NOT clear backoffIndex — that is managed by handleConnectionFailure
   * and the sustainedDataTimer callback.
   */
  private resetForReconnect(): void {
    this.clearKeepaliveTimer();
    this.clearFastPollTimer();
    this.clearNormalPollTimer();
    this.clearDiscoveryTimer();
    this.clearWatchdogTimer();
    this.clearSustainedDataTimer(); // BE6
    // BE3: clear wind pairing state
    this.lastTwa = null;
    this.lastTws = null;
    this.lastAwa = null;
    this.lastAws = null;
    // Session state
    this.fastPollChannels = [];
    this.normalPollChannels = [];
    this.discoveryComplete = false;
    // BE2: freshness state
    this.lastValidObservationAt = null;
    this.lastSeenAt.clear();
  }

  private clearKeepaliveTimer(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  private clearFastPollTimer(): void {
    if (this.fastPollTimer !== null) {
      clearInterval(this.fastPollTimer);
      this.fastPollTimer = null;
    }
  }

  private clearNormalPollTimer(): void {
    if (this.normalPollTimer !== null) {
      clearInterval(this.normalPollTimer);
      this.normalPollTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearDiscoveryTimer(): void {
    if (this.discoveryTimer !== null) {
      clearTimeout(this.discoveryTimer);
      this.discoveryTimer = null;
    }
  }

  private clearWatchdogTimer(): void {
    if (this.watchdogTimer !== null) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private clearSustainedDataTimer(): void {
    if (this.sustainedDataTimer !== null) {
      clearTimeout(this.sustainedDataTimer);
      this.sustainedDataTimer = null;
    }
  }

  private cleanupSocket(): void {
    if (this.ws !== null) {
      try {
        this.ws.removeAllListeners?.();
        const rs = this.ws.readyState;
        if (rs === 0 /* CONNECTING */ || rs === WS_READY_STATE_OPEN /* OPEN */) {
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
