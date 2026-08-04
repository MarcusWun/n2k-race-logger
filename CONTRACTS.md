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
| `gofreePort` | `number` | `10110` | GoFree TCP port |

Loaded via spread-merge on startup (per decision #29). Missing fields in old settings.json files silently get defaults.

### New IPC Channels

| Channel | Direction | Payload | Purpose |
|---|---|---|---|
| `connection:source` | Renderer → Main | `{ dataSource: 'ngt1' \| 'gofree' }` | Switch active data source; stops current manager, does NOT auto-connect |
| `gofree:status` | Main → Renderer | `{ state, ip?, port?, error? }` | GoFree connection state updates |

`connection:connect` and `connection:disconnect` continue to work for both sources. Routing is determined by `currentDataSource` in `ipc-handlers.ts`.

GoFree status states: `'searching'` | `'connecting'` | `'connected'` | `'reconnecting'` | `'error'` | `'disconnected'`

### NMEA 0183 Sentence → Store Field Mapping

All values converted to N2K-compatible units (m/s, radians) so the downstream pipeline is source-agnostic.

| Sentence | Fields | PGN emitted | Store target |
|---|---|---|---|
| `$WIMWV` (ref=R) | AWS (kts→m/s), AWA (°→rad, 0–2π) | 130306, ref=`'Apparent'` | AWS, AWA |
| `$WIMWV` (ref=T) | TWS (kts→m/s), TWA (°→rad, 0–2π) | 130306, ref=`'True (boat referenced)'` | TWS, TWA |
| `$IIVHW` | STW (kts→m/s), HDG magnetic (°→rad) | 128259 + 127250 | STW, Heading |
| `$GPGLL` | LAT, LON (decimal °, no conversion) | 129025 | LAT, LON |
| `$GPRMC` | LAT, LON, SOG (kts→m/s), COG (°→rad) | 129025 + 129026 | LAT, LON, SOG, COG |
| `$GPVTG` | SOG (kts→m/s), COG true (°→rad) | 129026 | SOG, COG |
| `$HCHDG` | HDG magnetic (°→rad) → `heading` field | 127250 | Heading |
| `$HCHDT` | HDG true (°→rad) → `headingTrue` field | 127250 | Heading fallback |

NMEA port-side AWA values (NMEA signed negative or 0–360° reflex angles) map to 0–2π radians matching N2K convention. The renderer's `normalizeWindAngle()` and analysis-engine handle side labeling identically for both sources.

True wind fallback: when only `$WIMWV` ref=R (apparent) is present in a session, `GoFreeManager` computes TWS/TWA from AWA + STW using the same vector formula as the renderer Dashboard and `analysis-engine.ts`, and emits an additional PGN 130306 with `reference='True (boat referenced)'`.

### NGT-1 BST Init — NEVER Sent on GoFree Connections

The BST initialization command `[0x11, 0x02, 0x00]` is Actisense NGT-1 specific. It is implemented only in `serial-manager.ts` and is **never** sent by `GoFreeManager`. GoFree connections require no handshake — NMEA sentences stream immediately on TCP connect.

### Architecture

- `electron/gofree-manager.ts` — new file mirroring `serial-manager.ts` structure
- `electron/ipc-handlers.ts` — `currentDataSource` routes `connection:connect`/`disconnect`; new `connection:source` handler
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
