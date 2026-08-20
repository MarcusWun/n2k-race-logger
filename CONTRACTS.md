# Contracts — n2k-race-logger

Shared contracts for Electron main process, preload bridge, renderer, and QA.

## Settings IPC

### `settings:get`

Returns current settings plus error metadata when load fallback occurred.

Critical user fields:

- `dataDirectory`
- `activePolarProfile`
- `sailInventory`

Defaults may fill truly missing first-run fields only. Load/parse/migration errors must preserve last-known-good critical fields where available and surface a visible error to the renderer.

### `settings:set`

Returns a result object:

```ts
{
  success: boolean
  settings?: AppSettings
  error?: string
}
```

`success: true` is allowed only after settings have been durably written to disk. On failure, renderer draft values must not be replaced by defaults or stale disk values.

### `settings:error`

Renderer-visible notification for settings load/save failures. The UI must show this error clearly enough that Save Settings cannot appear successful when persistence failed.

## Wind Angle Data Contract

Raw PGN payloads in SQLite remain canboat/native data and are not rewritten for display normalization.

Derived/display analysis values for relative wind angles use:

```ts
type WindSide = 'port' | 'starboard' | 'centerline'
```

- AWA and TWA angles are normalized to 0–180°.
- Side context is carried separately as port/starboard/centerline.
- Display format uses the normalized angle plus side indicator, e.g. `45°P`, `45°S`, or centerline form where appropriate.

## Polar Interpolation Method

### `InterpolationMethod`

```ts
export type InterpolationMethod = 'linear' | 'pchip' | 'akima';
```

Exported from `electron/polar-engine.ts` (re-exported from `electron/analysis-engine.ts`).

Controls the 1-D spline algorithm used in the TWA dimension during polar speed lookup. The TWS dimension always uses linear interpolation.

- **`'linear'`** — piecewise linear (legacy; preserved for call-sites that need exact linear behavior).
- **`'pchip'`** — Fritsch–Carlson PCHIP; monotonicity-preserving cubic Hermite. Implemented in `electron/spline.ts`.
- **`'akima'`** — Akima 1970 locally weighted cubic. Implemented in `electron/spline.ts`.

Default is `'pchip'` in both `PolarEngine.interpolateSpeed()` and the standalone `interpolateSpeed()` in `analysis-engine.ts` (selected as the QA Gate 1 winner on 2026-08-03).

Splines are memoised per `(PolarTable, rowIndex, method)` via a `WeakMap` so they are built once per table object and reused on subsequent calls.

## GoFree Ethernet Data Source Contract (Phase 2.7)

### New Settings Keys

| Key | Type | Default | Description |
|---|---|---|---|
| `dataSource` | `'ngt1' \| 'gofree'` | `'ngt1'` | Active data source |
| `gofreeHost` | `string` | `'192.168.0.1'` | GoFree router IP (fallback when multicast discovery fails) |
| `gofreePort` | `number` | `2053` | H5000 GoFree WebSocket port |

Loaded via spread-merge on startup (per decision #29). Missing fields in old settings.json files silently get defaults.

### New IPC Channels

| Channel | Direction | Payload | Purpose |
|---|---|---|---|
| `connection:source` | Renderer → Main | `{ dataSource: 'ngt1' \| 'gofree' }` | Switch active data source; stops current manager, does NOT auto-connect |
| `gofree:status` | Main → Renderer | `{ state, ip?, port?, error? }` | GoFree connection state updates |

`connection:connect` and `connection:disconnect` continue to work for both sources. Routing is determined by `currentDataSource` in `ipc-handlers.ts`.

GoFree status states: `'connecting'` | `'connected'` | `'stale'` | `'reconnecting'` | `'error'` | `'disconnected'`

**`stale` state (added Group A / BE2):** The WebSocket is open and the socket appears connected, but no valid H5000 observations have arrived within `watchdogTimeoutMs` (default 5 000 ms). The renderer must treat `stale` the same as "no data" — tile values should display `--`. When valid data resumes, the manager transitions back to `connected` without a reconnect cycle. This is intentional: silence from the instrument network is a data-layer problem, not a transport-layer problem, and a healthy TCP connection should not be torn down to diagnose it.

**`error` state (Group B / BE6):** Reserved exclusively for a terminal WebSocket constructor failure (e.g. malformed URL). All transport-layer failures (unexpected close, socket `error` event) use indefinite backoff reconnection and do NOT enter `error` state.

**`gofree:freshness` event (added Group A / BE2, updated Group B / BE5):** Emitted by `GoFreeManager` on every fast and normal poll tick.

```ts
interface GoFreeFreshnessEvent {
  /**
   * Channel IDs whose last valid observation is older than 2 × (their group poll interval).
   * Fast channels (BSPD, TWA, TWS, AWA, AWS): stale after 2 × fastPollIntervalMs (~400 ms default).
   * Normal channels (SOG, COG, HDG, VMG, LEE, LAT, LON): stale after 2 × normalPollIntervalMs (~2 000 ms default).
   */
  staleChannels: number[];
}
```

The renderer maps channel IDs to dashboard tiles and renders `--` for any value whose channel ID appears in `staleChannels`. The last known value is retained in memory — only the display is suppressed.

**Wind pairing timestamps (added Group A / BE3):** TWA, TWS, AWA, and AWS are stored internally as `{ value: number; ts: number }` records. When emitting PGN 130306, the companion field (e.g. windSpeed when processing TWA) is only included when the cached companion's timestamp is within `MAX_WIND_PAIRING_AGE_MS` (1 500 ms) of the current observation. This prevents pairing a fresh angle reading with an indefinitely-old speed reading (and vice versa). The `reference` strings `'True (boat referenced)'` and `'Apparent'` are unchanged.

**GoFreeManagerOptions — Group B additions (BE4–BE6):**

| Option | Type | Default | Description |
|---|---|---|---|
| `enableChannelProbe` | `boolean` | `false` | BE4: When `true`, sends one-shot DataReq for every DataList channel not in `REQUIRED_CHANNEL_IDS`. Disabled by default; use only for diagnostics. |
| `fastPollIntervalMs` | `number` | `200` | BE5: Poll interval for the fast group (BSPD, TWA, TWS, AWA, AWS). |
| `normalPollIntervalMs` | `number` | `1000` | BE5: Poll interval for the normal group (SOG, COG, HDG, VMG, LEE, LAT, LON). |
| `backoffLadderMs` | `number[]` | `[1000,2000,5000,10000]` | BE6: Reconnect backoff delays. Last element repeats indefinitely. |
| `sustainedDataResetMs` | `number` | `5000` | BE6: How long (ms) the connection must stay active with valid data before `backoffIndex` resets to 0. |

**Deprecated options (still accepted for backward compatibility):**
- `pollIntervalMs` — sets both `fastPollIntervalMs` and `normalPollIntervalMs` to the same value.
- `reconnectIntervalMs` — derives a proportional backoff ladder from the supplied value.
- `maxReconnectAttempts` — silently ignored; reconnection is now indefinite.

**GoFreeManagerOptions.watchdogTimeoutMs (added Group A / BE2):** New optional option; default 5 000 ms. Set to `0` to disable the watchdog. Tests should pass a short value (e.g. 2 000–3 000 ms) to avoid wall-clock waits.

**BE5 Polling groups:** Channels are split into two groups with independent `setInterval` timers. Both timers are tracked and cleared by `resetForReconnect()`. The `gofree:freshness` event is emitted on every tick of either timer.

**BE6 Reconnect model:** Indefinite reconnection with capped exponential backoff (`backoffLadderMs`, default `[1s, 2s, 5s, 10s]`). The `backoffIndex` is NOT reset when WebSocket `open` fires. It resets only after `sustainedDataResetMs` of continuous valid observations while state remains `'connected'`. The `handleConnectionFailure()` → `resetForReconnect()` path is unchanged.

### NGT-1 BST Init — NEVER Sent on GoFree Connections

The BST initialization command `[0x11, 0x02, 0x00]` is Actisense NGT-1 specific. It is implemented only in `serial-manager.ts` and is **never** sent by `GoFreeManager`. GoFree connections use the H5000 WebSocket Tier 2 JSON protocol — no initialization handshake is required; the manager immediately sends a `DataListReq` (group 40) on WebSocket open to discover available channels.

### Architecture

- `electron/gofree-manager.ts` — GoFree Tier 2 WebSocket manager (mirrors `serial-manager.ts` public API; emits `ParsedPGN` events)
- `electron/ipc-handlers.ts` — `currentDataSource` routes `connection:connect`/`disconnect`; `connection:source` handler
- `electron/preload.ts` — exposes `setDataSource()` and `'gofree:status'` event channel
- Only one manager emits data at a time (enforced by `connect()`/`disconnect()` lifecycle)

## TCP Connection Contract

Default TCP target remains:

- host: `192.168.1.1`
- port: `2000`

Renderer must reject malformed host/port input before save/connect. Main process must validate/sanitize again before opening a socket.

Examples:

- `192.168.1.1:2000` is valid/default.
- Safe trailing dot input may be sanitized.
- Truncated IPv4-like host `192.168.1` must not be used as a socket target.
- Invalid octets and invalid ports are rejected.

Connection errors/diagnostics should include the actual sanitized socket target and timing/retry context.
