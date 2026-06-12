# PRD — N2K Race Logger

**App name:** `n2k-race-logger`
**Author:** CTO Agent
**Status:** Approved 2026-06-01
**Date:** 2026-06-01

---

## 1. App Overview

A lightweight Windows desktop application that logs racing sailboat performance data from NMEA 2000 instrument networks via an Actisense NGT-1 serial gateway, stores it locally in SQLite, displays live instrument readings in a real-time dashboard, and compares actual performance against imported polar diagrams.

This is Phase 1 of a larger project that will add post-race replay, track visualization, and data export in future phases.

**Target user:** Marcus — competitive harbor/offshore racer with an NMEA 2000 instrument network on board.

**What this is NOT:** This is not Expedition, Adrena, or a weather routing tool. It is a focused race logger with live monitoring and (in future phases) post-race debrief.

---

## 2. Goals & Success Criteria

A successful Phase 1 build means:
- The app connects to an Actisense NGT-1 via serial port (default COM3 at 115,200 baud)
- Live PGN data is parsed by canboatjs and displayed in a real-time dashboard
- The user can start/stop recording, and data flows to a per-race SQLite file
- The user can import a polar file and see live % of polar on the dashboard
- The app runs as a standalone Windows .exe (no Node.js install required)

---

## 3. User Roles

| Role | Description | Permissions |
|------|-------------|-------------|
| User (single) | Marcus — the only user | Full access to all features |

No authentication. No multi-user. Everything is local.

---

## 4. Core Features

### 4.1 Connection Manager

Dual-mode connection to NMEA 2000 gateways: serial (Actisense NGT-1) or Wi-Fi (W2K/TCP).

**Serial mode (default):**
- Auto-detect available COM ports via `SerialPort.list()`
- Identify Actisense devices by USB vendor/product ID when possible
- Remember last-used port
- Default: COM3 at 115,200 baud, 8N1, no flow control
- **Actisense binary protocol:** The NGT-1 uses a proprietary binary serial protocol, NOT ASCII text. Raw serial bytes are piped directly through canboatjs `FromPgn` transform stream, which handles binary framing and emits parsed PGN objects. No `ReadlineParser` or text-based parsing is used.
- Graceful handling of Windows UAC prompts for first-run COM access

**Wi-Fi / TCP mode:**
- Connect to a W2K or compatible Wi-Fi NMEA 2000 gateway via TCP socket
- User configures IP address and port in settings (default: 192.168.1.1:2000)
- TCP data piped through the same `FromPgn` transform stream as serial (handles both Actisense binary and text formats)
- Reconnect on disconnect with configurable retry (default: 5 seconds, max 3 attempts)
- Remember last-used IP/port

**Connection UI:**
- Mode selector: Serial / Wi-Fi toggle
- Serial mode: dropdown of detected COM ports with refresh button, baud rate selector (default 115,200)
- Wi-Fi mode: IP address input, port input
- Connect / Disconnect button with status indicator (disconnected / connecting / connected / error)
- Connection status persists visually in the header area at all times

### 4.1.1 Debug Window

A standalone debug window for decoded N2K data inspection, independent of the main dashboard connection:

- **Debug button** in the connection bar opens a new window
- Displays **parsed, human-readable N2K messages** from the active connection (serial or Wi-Fi), one per line
- Each line shows: PGN name, PGN number, and all decoded field key=value pairs (e.g., `Wind Data (PGN 130306): windSpeed=12.30, windAngle=0.82, windReference=True (boat referenced)`)
- Data that canboatjs cannot decode displays as `Unknown N2K data field`
- **All PGNs** are shown (not filtered by the user's PGN filter list) for full diagnostic visibility
- Each line prefixed with a timestamp (HH:MM:SS.mmm)
- Scrolls automatically to show newest data at the bottom
- Window has its own close button (X) in the top-right corner
- Opening/closing the debug window does NOT affect the connection state
- Connect/disconnect can be performed while the debug window is open
- Debug window receives data from the same serial/TCP stream as the dashboard parser
- Maximum 1000 lines retained (oldest lines discarded to prevent memory growth)

### 4.2 PGN Parsing Pipeline

All incoming data (serial or network) is piped as a raw byte stream through canboatjs `FromPgn` used as a Node.js transform stream. `FromPgn` handles Actisense binary protocol framing internally and emits parsed PGN objects via `pgn` events. The serial manager emits these pre-parsed objects; downstream components (PGN filter, dashboard, recording) consume structured PGN data without any text parsing.

**Default racing PGN set:**

| PGN | Name | Key Fields |
|-----|------|------------|
| 128259 | Speed — Water Referenced | STW (speed through water) |
| 129025 | Position — Rapid Update | Latitude, Longitude |
| 129026 | COG & SOG — Rapid Update | COG, SOG |
| 129029 | GNSS Position Data | Lat, Lon, altitude, satellites |
| 127250 | Vessel Heading | Heading (magnetic/true) |
| 130306 | Wind Data | Wind speed, wind angle, reference (true/apparent) |
| 130310 | Environmental Parameters | Water temp, outside temp, atmospheric pressure |
| 127257 | Attitude | Roll, pitch, yaw |
| 129284 | Navigation Data | Distance/bearing to waypoint, VMG |

**PGN filtering:**
- Only PGNs in the user's configured set are processed and logged
- User can add/remove PGNs in settings
- Unknown/proprietary PGNs that canboatjs cannot decode: log raw bytes + PGN number as fallback

**Write buffering:**
- PGN update rates are 0.25-2 Hz across multiple PGN types
- Buffer parsed data and batch-write to SQLite every 250ms (not one row at a time)
- This prevents main thread blocking from synchronous `better-sqlite3` writes

### 4.3 Live Dashboard

Real-time display of current instrument readings, updated as PGNs arrive:

| Metric | Source PGN | Display Format |
|--------|-----------|----------------|
| Speed Through Water (STW) | 128259 | X.X kts |
| Speed Over Ground (SOG) | 129026 | X.X kts |
| Course Over Ground (COG) | 129026 | XXX° |
| True Wind Speed (TWS) | 130306 | X.X kts |
| True Wind Angle (TWA) | 130306 | XXX° (port/starboard indicator) |
| Apparent Wind Speed (AWS) | 130306 | X.X kts |
| Apparent Wind Angle (AWA) | 130306 | XXX° |
| Heading | 127250 | XXX° |
| GPS Position | 129025 | DD°MM.MMM' N/S, DD°MM.MMM' E/W |

**Dashboard layout:**
- Large numeric tiles for primary metrics (STW, SOG, TWS, TWA, heading)
- Smaller secondary metrics below (AWS, AWA, COG, position)
- All values update in real-time as PGNs arrive
- Stale data indicator: if a metric hasn't updated in >5 seconds, dim or flag it
- Dark theme appropriate for boat cockpit use (low glare)

### 4.4 Race Logging

**Start/Stop controls:**
- Prominent "Start Recording" / "Stop Recording" button
- On start: prompt for optional race label (e.g., "Wednesday Night Race #12")
- Creates a new SQLite database file: `YYYY-MM-DD_HH-MM-SS_<label>.db`
- Stored in user-configurable data directory (default: `~/n2k-race-logger/races/`)
- While recording: elapsed time counter, record count, file size indicator
- On stop: finalize `race_meta` record with end time and total point count

**Recording behavior:**
- All PGNs in the configured set are logged at their native update rate
- Each row in `n2k_points`: race_id, timestamp, PGN number, parsed JSON data
- Timestamp source: PGN's own timestamp field when available, system clock at parse time as fallback
- Recording continues even if the dashboard view is not focused
- No data loss on app crash: SQLite WAL mode ensures writes are durable

### 4.5 Settings

Persistent settings stored in a local `settings.json` file:

| Setting | Default | Description |
|---------|---------|-------------|
| Serial port | `COM3` | Last-used COM port |
| Serial baud | `115200` | Baud rate |
| PGN filter list | See §4.2 defaults | Which PGNs to parse and log |
| Data directory | `~/n2k-race-logger/races/` | Where race .db files are stored |
| Polar directory | `~/n2k-race-logger/polars/` | Where imported polar files are stored |
| Active polar profile | (none) | Currently selected boat polar for % of polar calculation |
| Wi-Fi IP | `192.168.1.1` | W2K gateway IP address |
| Wi-Fi port | `2000` | W2K gateway TCP port |
| Connection mode | `serial` | Last-used mode: `serial` or `wifi` |

Settings UI: a simple settings page/modal accessible from the main navigation.

### 4.6 Polar Diagram & Performance Comparison

**Polar file import:**
- Import polar data from CSV or standard `.pol` file format
- Supported format: TWS columns × TWA rows → target boat speed lookup table
- Imported files are copied into `~/n2k-race-logger/polars/` directory
- One active polar profile at a time (selected in settings)
- Pre-loaded with Marcus's Sun Fast 3300 polar data

**Polar diagram view:**
- Renders the imported polar curve as a standard sailing polar plot (TWA on angular axis, boat speed on radial axis)
- **Chart orientation:** TWA radiates from the origin — 0° (dead upwind) at the **top** of the chart, 90° (beam reach) at the **right**, 180° (dead downwind) at the **bottom**. Wind comes from the top. Only the starboard half (0–180°) is rendered. Angle grid lines at 30° intervals with degree labels.
- Multiple TWS curves overlaid (e.g., 6, 8, 10, 12, 16, 20 kts)
- When connected and receiving live data: plot current TWA/STW as a dot on the polar diagram, colored by performance (green = at or above polar, yellow = 90-99%, red = below 90%)
- Static view when not connected: shows the polar curves only

**Live % of polar on dashboard:**
- New dashboard metric: "% Polar" — current STW divided by the polar-predicted speed for the current TWS and TWA
- Displayed as a large percentage (e.g., "94%") with color coding: green ≥100%, yellow 90-99%, red <90%
- Requires both STW (PGN 128259) and wind data (PGN 130306) to compute; shows "—" if either is missing
- TWS interpolation: if current TWS falls between polar table entries, linearly interpolate between the two nearest TWS columns
- TWA interpolation: same linear interpolation between nearest TWA rows

**Polar data stored in `boat_profiles` table** (see §6.3) — `polar_data` column holds the TWS/TWA lookup table as JSON.

---

## 5. Screens & Navigation

### Screen 1: Dashboard (Home)
- **Purpose:** Live instrument readings + connection management + recording controls
- **Key elements:**
  - Connection status bar (top) — port, baud, status indicator, connect/disconnect
  - Instrument tiles (center) — large numeric displays for all metrics in §4.3, including live % of polar
  - Recording controls (bottom or sidebar) — start/stop, race label, elapsed time, record count
- **Navigation to:** Polar, Settings

### Screen 2: Polar
- **Purpose:** Polar diagram visualization + import
- **Key elements:**
  - Polar plot (center) — rendered polar curves for all TWS values in the imported data
  - Live performance dot — current TWA/STW plotted on the diagram when connected (color-coded by % of polar)
  - Import button — file picker for .pol or .csv files
  - Active profile selector — dropdown of imported polars
- **Navigation to:** Dashboard, Settings

### Screen 3: Settings
- **Purpose:** Configure connection, PGN filter, data directory, polar profile
- **Key elements:**
  - Connection settings (serial port dropdown, baud rate)
  - PGN filter list (checkboxes or tag-style list)
  - Data directory picker
  - Polar directory / active profile
  - Save / Cancel buttons
- **Navigation to:** Dashboard (back)

### Navigation pattern:
- Three-screen app for Phase 1
- Tab or sidebar nav: Dashboard, Polar, Settings
- Dashboard is the default/home screen

---

## 6. Data Model

One SQLite `.db` file per race, stored in the user's configured data directory.

### 6.1 `race_meta` table

```sql
CREATE TABLE race_meta (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    label TEXT,
    start_time TEXT,
    end_time TEXT,
    boat_profile TEXT,
    total_points INTEGER DEFAULT 0
);
```

### 6.2 `n2k_points` table

```sql
CREATE TABLE n2k_points (
    id INTEGER PRIMARY KEY,
    race_id INTEGER NOT NULL REFERENCES race_meta(id),
    timestamp TEXT NOT NULL,
    pgn INTEGER NOT NULL,
    data TEXT NOT NULL
);

CREATE INDEX idx_n2k_race_timestamp ON n2k_points(race_id, timestamp);
CREATE INDEX idx_n2k_pgn ON n2k_points(pgn);
```

### 6.3 `boat_profiles` table

```sql
CREATE TABLE boat_profiles (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    hull_type TEXT,
    polar_data TEXT NOT NULL,
    created_at TEXT NOT NULL
);
```

- `polar_data` stores the full TWS/TWA → speed lookup table as JSON (e.g., `{ "tws": [6,8,10,12,16,20], "twa": [40,45,52,...,180], "speeds": [[...], ...] }`)
- Populated when user imports a .pol or .csv file
- Pre-seeded with Sun Fast 3300 polar data (Marcus's boat)

---

## 7. API Requirements

No HTTP API. All communication is via Electron IPC between main and renderer processes:

| IPC Channel | Direction | Payload | Purpose |
|-------------|-----------|---------|---------|
| `connection:status` | Main → Renderer | `{ mode, port?, baud?, host?, tcpPort?, status, error? }` | Connection state updates |
| `connection:connect` | Renderer → Main | `{ mode, port?, baud?, host?, tcpPort? }` | Request serial or Wi-Fi connection |
| `connection:disconnect` | Renderer → Main | — | Request disconnect |
| `debug:open` | Renderer → Main | — | Open the debug window |
| `debug:close` | Renderer → Main | — | Close the debug window |
| `debug:data` | Main → Debug Renderer | `{ timestamp, line }` | Raw data line for debug display |
| `pgn:data` | Main → Renderer | `{ pgn, fields, timestamp }` | Live PGN data for dashboard |
| `recording:start` | Renderer → Main | `{ label? }` | Start recording |
| `recording:stop` | Renderer → Main | — | Stop recording |
| `recording:status` | Main → Renderer | `{ active, elapsed, count, fileSize }` | Recording state updates |
| `serial:list-ports` | Renderer → Main | — | Request available COM ports |
| `serial:ports` | Main → Renderer | `[{ path, manufacturer, ... }]` | Available COM ports |
| `polar:import` | Renderer → Main | `{ filePath }` | Import a .pol/.csv polar file |
| `polar:list` | Renderer → Main | — | List imported polar profiles |
| `polar:profiles` | Main → Renderer | `[{ id, name, hull_type }]` | Available polar profiles |
| `polar:get` | Renderer → Main | `{ id }` | Get full polar data for rendering |
| `polar:data` | Main → Renderer | `{ tws, twa, speeds }` | Polar lookup table |
| `polar:performance` | Main → Renderer | `{ percentPolar, targetSpeed, actualSpeed }` | Live % of polar (computed in main process) |
| `settings:get` | Renderer → Main | — | Request current settings |
| `settings:set` | Renderer → Main | `{ ...settings }` | Update settings |

---

## 8. Authentication

None. Single-user desktop application. No accounts, no sessions, no credentials.

---

## 9. Third-Party Integrations

| Service | Purpose | Notes |
|---------|---------|-------|
| None | — | All data is local from the boat's NMEA 2000 network |

OpenStreetMap tiles are fetched at runtime for future phases (track visualization). No API key required. Not needed for Phase 1.

---

## 10. Non-Functional Requirements

- **Performance:** Dashboard must update in real-time (< 100ms latency from PGN receipt to display). SQLite batch writes must not block the UI thread.
- **Reliability:** No data loss during recording. SQLite WAL mode. Graceful handling of serial port disconnection mid-recording (buffer data, attempt reconnect, resume).
- **Platform:** Windows 10/11 (x64). Single-platform for v1.
- **Bundle size:** ~100MB acceptable for Electron app with native modules.
- **Offline:** Fully functional without internet. No cloud dependencies.
- **Theme:** Dark theme by default — designed for boat cockpit use (low ambient light, minimal glare).

---

## 11. Tech Stack

| Layer | Choice | Notes |
|-------|--------|-------|
| Desktop framework | Electron | Mature serialport ecosystem, canboatjs is Node.js native |
| Language | TypeScript | Type safety throughout |
| UI framework | React 18 + Vite | Fast HMR for development |
| Styling | Tailwind CSS | Dark theme utilities |
| State management | Zustand | Lightweight, minimal boilerplate |
| PGN parser | @canboat/canboatjs | MIT, 450+ stars, used as FromPgn transform stream for Actisense binary protocol |
| Serial I/O | @serialport | Mature Electron support; raw bytes piped through canboatjs FromPgn (no ReadlineParser) |
| Database | SQLite via better-sqlite3 | Sync, zero-config, fast |
| Build/packaging | electron-builder | Windows .exe installer |
| Testing | Vitest | Unit + integration tests |

---

## 12. Deployment Requirements

This is a desktop application, not a web app. "Deployment" means building a distributable Windows installer.

- **Build target:** Windows x64 `.exe` installer via electron-builder
- **Output directory:** `dist/` in the project root
- **No Vercel, no Supabase, no cloud deployment**
- **No environment variables required** — all config is in local `settings.json`
- **Installer should:**
  - Create Start Menu shortcut
  - Create default directories on first run: `~/n2k-race-logger/races/` and `~/n2k-race-logger/polars/`
  - Bundle all native modules (better-sqlite3, serialport) pre-built for Windows x64

### Build verification:
- `npm run build` produces a working `.exe`
- App launches, settings page renders, connection UI is functional
- All Vitest tests pass

---

## 13. Testing Requirements

All tests via Vitest.

### 13.1 Main process tests
- canboatjs parser: given known Actisense input, produces expected PGN JSON output via FromPgn
- PGN filtering: only configured PGNs pass through the filter (applied to pre-parsed PGN objects)
- SQLite schema: creates tables and indexes correctly in a fresh database
- SQLite batch write: correctly inserts buffered PGN rows
- Race lifecycle: start creates race_meta + db file, stop finalizes end_time and total_points
- Settings: load/save round-trip to settings.json
- Derived fields: timestamp source selection (PGN timestamp vs system clock)
- Polar file parser: correctly parses .pol and .csv formats into TWS/TWA/speed lookup table
- Polar interpolation: given TWS=9 (between 8 and 10 columns), interpolates correct target speed
- Polar interpolation: given TWA=47 (between 45 and 52 rows), interpolates correct target speed
- % of polar computation: STW / interpolated target speed × 100
- % of polar edge cases: missing wind data returns null, TWA outside polar range returns null

### 13.2 Renderer tests
- Dashboard renders all metric tiles with placeholder values when disconnected
- Dashboard updates metric values when PGN data arrives (mocked IPC)
- Dashboard shows % of polar tile with color coding (green/yellow/red)
- % of polar shows "—" when wind data unavailable
- Stale data indicator appears after 5 seconds of no updates
- Connection UI: serial port dropdown and baud rate selector render correctly
- Recording controls: start/stop button state changes correctly
- Polar view: renders polar curves from imported data
- Polar view: import button triggers file picker
- Polar view: live performance dot appears when connected with valid data
- Settings form: validates inputs, saves correctly
- Settings: active polar profile selector lists imported profiles

### 13.3 Build
- `npm run build` completes without errors
- ESLint passes

---

## 14. Project Structure

```
n2k-race-logger/
├── electron/
│   ├── main.ts                # Electron main process entry
│   ├── serial-manager.ts      # Serial/TCP connect, pipes raw bytes through FromPgn, emits parsed PGN events
│   ├── n2k-parser.ts          # PGN filtering and batch buffering (receives pre-parsed PGN objects)
│   ├── polar-engine.ts        # Polar file parsing, interpolation, % of polar computation
│   ├── database.ts            # SQLite schema + write logic + batch buffer
│   └── ipc-handlers.ts        # IPC bridge to renderer
├── src/
│   ├── components/
│   │   ├── Dashboard/         # Live connection + real-time values + % of polar
│   │   ├── PolarView/         # Polar diagram renderer + import UI
│   │   ├── Controls/          # Start/stop logging, connection config
│   │   └── Settings/          # Connection, PGN filter, data directory, polar profile
│   ├── store/
│   │   ├── useN2KStore.ts     # Real-time PGN state
│   │   ├── useRaceStore.ts    # Race list + active race state
│   │   ├── usePolarStore.ts   # Polar profiles + live % of polar
│   │   └── useSettings.ts     # Connection settings
│   ├── types/
│   │   ├── n2k-pgns.ts        # PGN type definitions
│   │   ├── polar.ts           # Polar data type definitions
│   │   └── ipc.ts             # IPC channel type definitions
│   └── App.tsx
├── races/                     # SQLite race files (gitignored)
├── polars/                    # Imported polar files (gitignored)
├── electron-builder.config.js
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

---

## 15. Out of Scope for Phase 1 (v1)

Explicitly excluded from this build:

- **Race replay / playback** (Phase 2)
- **Track visualization on map** (Phase 2)
- **Time-series charts** (Phase 2)
- **VMG computation** (Phase 2)
- **Race browser / history list** (Phase 2)
- **CSV/data export** (Phase 3)
- **Race summary statistics** (Phase 3)
- **Color-coded track segments by % of polar** (Phase 3 — requires track visualization)
- **Multiple boat profiles** (Phase 4 — Phase 1 supports one active polar at a time)
- **Race comparison / overlay** (Phase 4)
- **Auto-derived polar from logged data** (Phase 4)
- **Offline tile bundling** (Phase 4)
- **Portable mode / USB stick** (Phase 4)
- **macOS or Linux support**
- **Weather routing, GRIB, chartplotter, competitor tracking** (never — use Expedition)
- **Cloud sync, accounts, subscriptions**
- **Auto-update mechanism** (can be added later via electron-builder)

---

## 16. Open Questions for User

All resolved — see §17.

---

## 17. CTO Design Decisions (User-Approved)

1. **Phase 1 scope: connect + monitor + record + polars + Wi-Fi + debug** — polars, Wi-Fi, and debug pulled into Phase 1 per user request.
2. **Serial defaults: COM3 at 115,200 baud** — per user specification.
3. **Dark theme by default** — cockpit-appropriate, low glare. No light mode toggle in v1.
4. **One SQLite file per race** — self-contained, portable.
5. **250ms batch write buffer** — balances write performance vs data freshness.
6. **No auto-update in v1** — manual reinstall for updates.
7. **No Windows code signing** — SmartScreen warning is acceptable for personal use.
8. **electron-builder for packaging** — Windows .exe installer with bundled native modules.
9. **Sun Fast 3300 polar pre-loaded** — user has polar file available; stored in `~/n2k-race-logger/polars/`.
