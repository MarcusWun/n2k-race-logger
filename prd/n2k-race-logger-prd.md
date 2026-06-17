# PRD — N2K Race Logger

**App name:** `n2k-race-logger`
**Author:** CTO Agent
**Status:** Approved 2026-06-01
**Date:** 2026-06-01

---

## 1. App Overview

A Windows desktop application that logs racing sailboat performance data from NMEA 2000 instrument networks via an Actisense NGT-1 serial gateway, stores it locally in SQLite, displays live instrument readings in a real-time dashboard, and provides post-race analysis tools for sail performance assessment against imported polar diagrams.

- **Phase 1 (shipped):** Live connection, dashboard, recording, polar diagram, debug window.
- **Phase 2:** Post-race analysis — race browser, strip charts, steady-state segment detection, sail tagging, and measured polar overlay for sail performance assessment.

**Target user:** Marcus — competitive harbor/offshore racer with an NMEA 2000 instrument network on board.

**What this is NOT:** This is not Expedition, Adrena, or a weather routing tool. It is a focused race logger with live monitoring and post-race sail performance analysis.

---

## 2. Goals & Success Criteria

**Phase 1 (shipped):**
- The app connects to an Actisense NGT-1 via serial port (default COM3 at 115,200 baud)
- Live PGN data is parsed by canboatjs and displayed in a real-time dashboard
- The user can start/stop recording, and data flows to a per-race SQLite file
- The user can import a polar file and see live % of polar on the dashboard
- The app runs as a standalone Windows .exe (no Node.js install required)

**Phase 2 success criteria:**
- The user can browse and open previously recorded race files
- Strip charts display all recorded metrics on a shared, zoomable time axis
- The app automatically detects steady-state sailing segments where TWS, TWA, and STW are stable
- Each detected segment produces a polar data point (mean TWS, mean TWA, mean STW)
- The user can tag sails used during a recording (with time-range support for sail changes mid-race)
- Extracted data points are plotted on the reference polar, filterable by sail configuration
- A performance summary shows % of polar by TWS/TWA band for each sail

---

## 3. User Roles

| Role | Description | Permissions |
|------|-------------|-------------|
| User (single) | Marcus — the only user | Full access to all features |

No authentication. No multi-user. Everything is local.

---

## 4. Core Features

### 4.1 Connection Manager

Dual-mode connection to NMEA 2000 gateways: serial (Actisense NGT-1) or TCP (network gateway).

**Serial mode (default):**
- Auto-detect available COM ports via `SerialPort.list()`
- Identify Actisense devices by USB vendor/product ID when possible
- Remember last-used port
- Default: COM3 at 115,200 baud, 8N1, no flow control
- **Actisense binary protocol:** The NGT-1 uses a proprietary binary serial protocol (BST), NOT ASCII text. Raw serial bytes are piped through canboatjs `ActisenseStream` transform stream, which decodes BST framing (DLE/STX/ETX with byte stuffing). Decoded N2K binary frames are then fed to the canboatjs `FromPgn` parser via `parseBuffer()`, which emits parsed PGN objects. Note: `FromPgn` is an EventEmitter, NOT a Node.js stream — it cannot be piped to directly. No `ReadlineParser` or text-based parsing is used.
- **NGT-1 initialization (REQUIRED):** After opening the serial port, the app MUST send a BST-framed startup command to the NGT-1 before data will flow. Without this, the device will not stream any N2K data to the PC. Details:
  - **Startup payload:** `[0x11, 0x02, 0x00]` — clears the device's PGN TX filter list, enabling all PGNs
  - **BST frame format:** `DLE(0x10) STX(0x02) <command> <len> <escaped-data> <checksum> DLE(0x10) ETX(0x03)`
  - **Command byte:** `0xA1` (NGT_MSG_SEND)
  - **Checksum:** `(256 - (command + len + sum_of_data_bytes)) & 0xFF`
  - **DLE escaping:** Any `0x10` byte within data or checksum must be doubled (`0x10 0x10`)
  - **Full init frame:** `[0x10, 0x02, 0xA1, 0x03, 0x11, 0x02, 0x00, 0x49, 0x10, 0x03]`
  - **Keepalive:** Re-send the same startup command every 20 seconds while connected to prevent the device from reverting to its default PGN filter
  - **Timing:** Allow ~200ms after sending init before expecting data
  - **Source:** Reverse-engineered by the canboat project (Apache 2.0), confirmed across canboat C, go-nmea-client Go, and SignalK implementations
  - **On disconnect:** Clear the keepalive interval
  - **TCP/WiFi mode:** Do NOT send this command for TCP connections (only serial)
- **Baud rate auto-detection (optional):** Default 115200 is correct for NGT-1 firmware v2.680+. If no data is received within 5 seconds of init, retry at 230400 (used by some firmware versions between v2.660-v2.670). Persist working baud rate in settings.
- Graceful handling of Windows UAC prompts for first-run COM access

**TCP mode:**
- Connect to a compatible NMEA 2000 gateway (e.g., Yacht Devices, iKommunicate) via TCP socket
- User configures IP address and port in settings (default: 192.168.1.1:2000)
- TCP data piped through the same `FromPgn` transform stream as serial (handles both Actisense binary and text formats)
- Reconnect on disconnect with configurable retry (default: 5 seconds, max 3 attempts)
- Remember last-used IP/port

**Connection UI:**
- Mode selector: Serial / TCP toggle
- Serial mode: dropdown of detected COM ports with refresh button, baud rate selector (default 115,200)
- TCP mode: IP address input, port input
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

All incoming serial data is piped through canboatjs `ActisenseStream` (a Node.js Transform stream) which decodes BST binary framing. Decoded N2K frames are fed to canboatjs `FromPgn` parser via `parseBuffer()`, which emits parsed PGN objects via `pgn` events. The serial manager emits these pre-parsed objects; downstream components (PGN filter, dashboard, recording) consume structured PGN data without any text parsing.

**Unit conversions (REQUIRED):** canboatjs outputs NMEA 2000 native units. The dashboard MUST convert before display:
- Speeds (STW, SOG, AWS, TWS): **m/s → knots** (×1.94384)
- Angles (AWA, COG, heading, TWA, TWD): **radians → degrees** (×180/π)
- GPS lat/lon: already in degrees, no conversion needed

**Default racing PGN set:**

| PGN | Name | Key Fields |
|-----|------|------------|
| 128259 | Speed — Water Referenced | STW (speed through water) |
| 129025 | Position — Rapid Update | Latitude, Longitude |
| 129026 | COG & SOG — Rapid Update | COG, SOG |
| 129029 | GNSS Position Data | Lat, Lon, altitude, satellites |
| 127250 | Vessel Heading | Heading (magnetic/true) |
| 130306 | Wind Data | Wind speed, wind angle, reference (see wind reference filtering below) |
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
| Course Over Ground (COG) | 129026 | XXX°M (magnetic) |
| True Wind Speed (TWS) | 130306 or computed | X.X kts |
| True Wind Angle (TWA) | 130306 or computed | XXX° |
| True Wind Direction (TWD) | 130306 (ground ref) or computed | XXX°M (magnetic) |
| Apparent Wind Speed (AWS) | 130306 (Apparent only) | X.X kts |
| Apparent Wind Angle (AWA) | 130306 (Apparent only) | XXX° |
| Heading | 127250 | XXX°M (magnetic) |
| GPS Position | 129025 | DD°MM.MMM' N/S, DD°MM.MMM' E/W |

**Wind source filtering (PGN 130306):** Multiple devices on the N2K bus may transmit PGN 130306. On Marcus's B&G system, three sources were observed:
- **src=16** — the real wind instrument. Sends Apparent, True (boat referenced), and True (ground referenced to North) with valid, varying readings.
- **src=22** — sends constant bogus Apparent data (windSpeed=0.25 m/s, windAngle=π rad / 180°). Must be filtered out.
- **src=8** — sends incomplete PGN 130306 messages (reference field only, no speed/angle). Must be filtered out.

Wind PGNs from src=22 and src=8 are dropped before reaching the dashboard or recording pipeline. This filter is applied in `ipc-handlers.ts` at the serial event handler level so bogus data never enters any downstream processing.

**Wind reference filtering (PGN 130306):** PGN 130306 carries a `reference` field (WIND_REFERENCE enum) that determines how the data is routed. Multiple devices on the N2K bus may send this PGN with different reference types simultaneously:

| Reference value | Routing |
|-----------------|---------|
| `"Apparent"` | → AWS, AWA. Also triggers true wind computation (below). |
| `"True (boat referenced)"` | → TWS, TWA |
| `"True (water referenced)"` | → TWS, TWA |
| `"True (ground referenced to North)"` | → TWS, TWD (angle is absolute direction, not relative to bow) |
| `"Magnetic (ground referenced to Magnetic North)"` | → TWS, TWD (angle is magnetic direction) |
| Unknown / error values | Ignored |

**IMPORTANT:** The canboatjs field name is `reference` (matching the PGN definition ID), NOT `windReference`. Using the wrong field name will cause silent failures since the value will be `undefined`.

**True wind computation:** When true wind PGNs (reference = "True") are not available on the N2K network, TWS, TWA, and TWD are computed from apparent wind and boat speed:
- Vector decomposition: u = AWS·sin(AWA), v = AWS·cos(AWA) − STW
- TWS = √(u² + v²), TWA = atan2(u, v)
- TWD = (Heading + TWA) mod 360
- Recomputed whenever apparent wind or heading updates
- Falls back to SOG if STW is unavailable

**Dampening / smoothing:** All measured and computed wind values (AWS, AWA, STW, SOG, heading, COG, TWS, TWD) are smoothed with a time-based exponential moving average (EMA, τ=1000ms) to reduce display jitter. Circular angle handling prevents artifacts at 0°/360° wrap-around. TWA is not smoothed (it feeds polar performance calculation and should reflect instantaneous angle). GPS lat/lon are not smoothed.

**Dashboard layout:**
- Large numeric tiles for primary metrics (STW, SOG, TWS, TWA, heading)
- Smaller secondary metrics below (AWS, AWA, COG, TWD, position)
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
| TCP IP | `192.168.1.1` | Network gateway IP address |
| TCP port | `2000` | Network gateway TCP port |
| Connection mode | `serial` | Last-used mode: `serial` or `tcp` |

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

### 4.7 Race Browser (Phase 2)

Browse and manage previously recorded race files.

- **File listing:** Scan the configured data directory (`~/n2k-race-logger/races/`) for `.db` files
- Each entry shows: date, label (from `race_meta`), duration, total data points, file size
- Sort by date (newest first), with optional search/filter by label
- Click a race to open it in the Analysis view (§4.8–4.11)
- Delete button with confirmation dialog (removes the `.db` file)
- The race browser is accessible from the main navigation alongside Dashboard, Polar, and Settings

### 4.8 Strip Charts (Phase 2)

Time-series visualization of all recorded metrics from a loaded race file.

**Chart layout:**
- Stacked strip charts sharing a common time axis (x-axis)
- Each metric gets its own vertical strip with independent y-axis scaling
- Default strips (top to bottom): TWS, TWA, STW, AWS, AWA, Heading, SOG, COG
- User can show/hide individual strips via checkboxes
- Detected steady-state segments (§4.9) are highlighted as semi-transparent colored bands overlaid on all strips simultaneously

**Interaction:**
- **Zoom:** Mouse wheel or pinch to zoom the time axis (both in and out)
- **Pan:** Click-drag to scroll horizontally through the recording
- **Overview bar:** A miniature full-duration timeline below the main charts showing the complete recording. A viewport rectangle shows the currently zoomed region; drag it to pan quickly. This provides context for where you are in the recording.
- **Cursor line:** Vertical crosshair follows the mouse, showing the exact value of each metric at that timestamp in a tooltip or readout panel
- **Time axis:** Displays elapsed time from recording start (MM:SS or HH:MM:SS for long recordings)

**Data reconstruction from PGN rows:**
- Raw PGN data in `n2k_points` is stored in canboatjs native units (m/s, radians). The analysis engine must apply the same unit conversions as the live dashboard (m/s → kts, rad → deg) and the same true wind computation (§4.3) to reconstruct TWS, TWA, and TWD from stored apparent wind + heading + STW data.
- Each metric is resampled to a uniform time grid (e.g., 1-second intervals) for chart rendering. Missing values are linearly interpolated within gaps < 5 seconds; gaps ≥ 5 seconds are rendered as breaks in the line.

**Chart rendering:**
- Use HTML5 Canvas for performance (recordings may contain 10,000+ data points per metric)
- Dark theme consistent with the dashboard
- Axis labels, grid lines, and metric colors should be readable at a glance

### 4.9 Steady-State Segment Detection (Phase 2)

The core analysis feature. Automatically identifies periods in the recorded data where sailing conditions were stable enough to produce valid polar performance data points.

**Detection algorithm:**

A sliding window scans the time-series data. A window qualifies as "steady-state" when ALL of the following conditions are met simultaneously for its entire duration:

| Metric | Stability threshold (default) | Description |
|--------|-------------------------------|-------------|
| TWS | ±1.5 kts | True wind speed variation within window |
| TWA | ±10° | True wind angle variation within window |
| STW | ±0.5 kts | Speed through water variation within window |

- **Minimum segment duration:** 60 seconds (configurable, range 30–300s)
- **Variation metric:** The range (max − min) of each metric within the window must be ≤ 2× the threshold value (i.e., total spread ≤ 3 kts for TWS at ±1.5 threshold)
- **Merging:** Adjacent qualifying windows separated by < 10 seconds of non-qualifying data are merged into a single segment
- **Exclusions:** Segments where mean STW < 1.0 kts are discarded (boat nearly stopped, not a useful data point)

**Output per segment:**
- Start time, end time, duration
- Mean TWS, mean TWA, mean STW (the polar data point)
- Standard deviation of each metric within the segment (quality indicator)
- % of polar: mean STW divided by the polar-predicted speed for mean TWS/TWA (using the same interpolation as §4.6)
- Sail tag (if one has been assigned to this time range — see §4.10)

**Threshold controls:**
- User can adjust TWS, TWA, STW thresholds and minimum duration via sliders or numeric inputs in the Analysis view
- Changing thresholds re-runs detection immediately and updates the strip chart overlays and polar overlay
- A "reset to defaults" button restores the default thresholds
- Show a count of detected segments and total steady-state time as feedback while adjusting

### 4.10 Sail Tagging (Phase 2)

Annotate recordings with which sails were in use during different time periods.

**Sail inventory:**
- User maintains a list of sails in settings (e.g., "J1", "J2", "J3", "A2", "A3", "Main", "Main + 1 reef", "Main + 2 reefs")
- Pre-seeded with a typical racing inventory for a Sun Fast 3300
- Sails are combined into "sail configurations" — a headsail + mainsail combination (e.g., "J2 + Main", "A3 + Main + 1 reef")
- User can add/edit/delete sails and configurations in settings

**Tagging workflow:**
- In the Analysis view, a "Sail Tags" panel shows the current sail assignments for the loaded recording
- To tag a time range: click a "Tag Sail" button, select a sail configuration from a dropdown, then click-drag on the strip chart time axis to define the time range
- Visual indicator: a colored bar below the time axis shows which sail configuration was active at each point in time (like a Gantt chart lane)
- Multiple sail configurations can be assigned to different time ranges within a single recording (to handle sail changes during a race)
- Gaps are allowed — not every moment needs a sail tag (e.g., during maneuvers)
- Sail tags are persisted in the race `.db` file (see §6.5)
- When a sail tag overlaps with a detected segment, that segment inherits the sail configuration for filtering in the performance analysis (§4.11)

### 4.11 Performance Analysis (Phase 2)

The payoff — aggregate detected segments into a clear picture of how each sail performs against the reference polar.

**Polar overlay view:**
- The existing polar diagram (§4.6) is extended with a new mode: "Measured Data" overlay
- Each detected steady-state segment is plotted as a dot at its mean TWA (angle) and mean STW (radius)
- Dot color: green (≥100% polar), orange (90–99%), red (<90%)
- Dot size: proportional to segment duration (longer = more reliable)
- Dots are plotted on top of the reference polar curves so you can see exactly where actual performance sits relative to target
- **Filter by sail:** A sail configuration dropdown filters which dots are shown. "All sails" shows everything; selecting a specific sail (e.g., "J2 + Main") shows only segments tagged with that configuration. This is the primary way to compare sails: switch between "J2 + Main" and "J3 + Main" to see which performs better at various TWA/TWS combinations.
- **Filter by TWS band:** Optionally filter dots to a TWS range (e.g., 10–14 kts) to reduce clutter and focus analysis

**Performance summary table:**
- A tabular view below the polar overlay
- Rows: one per sail configuration (that has at least one tagged segment)
- Columns: TWS bands (e.g., 6–8, 8–10, 10–12, 12–16, 16–20 kts) × TWA bands (e.g., 40–60°, 60–90°, 90–120°, 120–150°, 150–180°)
- Cell value: average % of polar across all segments in that TWS/TWA band for that sail
- Cell color: same green/orange/red coding
- Empty cells (no data): shown as "—" — these are the gaps where more sailing data is needed
- Row summary: overall average % of polar and total number of segments for each sail
- **Coverage indicator:** For each sail, show how many TWS/TWA band cells have data vs total cells, as a percentage (e.g., "Coverage: 12/25 = 48%"). This tells Marcus where he needs more data.

**Segment list:**
- A scrollable list of all detected segments for the loaded recording
- Columns: start time, duration, sail, TWS, TWA, STW, % polar, quality (σ)
- Click a segment to jump to that time range in the strip charts
- Segments can be manually excluded (e.g., if the user knows conditions were unusual) — excluded segments are dimmed and omitted from the polar overlay and summary table
- Sort by any column

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
- **Purpose:** Configure connection, PGN filter, data directory, polar profile, sail inventory
- **Key elements:**
  - Connection settings (serial port dropdown, baud rate)
  - PGN filter list (checkboxes or tag-style list)
  - Data directory picker
  - Polar directory / active profile
  - Sail inventory manager (Phase 2) — add/edit/delete sails and sail configurations
  - Segment detection defaults (Phase 2) — TWS/TWA/STW thresholds, minimum duration
  - Save / Cancel buttons
- **Navigation to:** Dashboard (back)

### Screen 4: Races (Phase 2)
- **Purpose:** Browse and open recorded race files for analysis
- **Key elements:**
  - List of recorded `.db` files with date, label, duration, data point count, file size
  - Search/filter by label
  - Click to open in Analysis view
  - Delete button with confirmation
- **Navigation to:** Dashboard, Analysis (on race select)

### Screen 5: Analysis (Phase 2)
- **Purpose:** Post-race strip chart review, segment detection, sail tagging, and performance analysis
- **Key elements:**
  - **Header:** Race label, date, duration, total segments detected
  - **Strip charts (upper):** Stacked time-series for all metrics with shared zoomable time axis, overview bar, steady-state segment overlays, and sail tag bar
  - **Segment detection controls (sidebar or panel):** Threshold sliders for TWS/TWA/STW and minimum duration, segment count feedback, reset button
  - **Sail tagging panel (sidebar):** Current sail assignments, "Tag Sail" button + config selector, click-drag to define time range
  - **Tabs below strip charts:** Toggle between three sub-views:
    - **Polar Overlay:** Reference polar with measured data points, sail filter dropdown, TWS band filter
    - **Performance Summary:** Table of avg % polar by sail × TWS/TWA band, coverage indicator
    - **Segment List:** Scrollable table of all segments with sort/click-to-jump/exclude controls
- **Navigation to:** Races (back), Dashboard

### Navigation pattern:
- Five-screen app for Phase 2
- Tab or sidebar nav: Dashboard, Races, Polar, Settings
- Analysis is opened from the Races screen (not directly in the nav bar — it requires a loaded race)
- Dashboard remains the default/home screen

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

### 6.4 `sail_tags` table (Phase 2, per-race .db file)

```sql
CREATE TABLE sail_tags (
    id INTEGER PRIMARY KEY,
    race_id INTEGER NOT NULL REFERENCES race_meta(id),
    sail_config TEXT NOT NULL,
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL
);

CREATE INDEX idx_sail_tags_race_time ON sail_tags(race_id, start_time);
```

- `sail_config` is a free-text label (e.g., "J2 + Main", "A3 + Main + 1 reef")
- Time ranges may have gaps (during maneuvers) but should not overlap
- Sail configuration labels are drawn from the user's sail inventory in settings but stored as plain text (no FK) so that renaming a sail in settings doesn't corrupt historical data

### 6.5 `detected_segments` table (Phase 2, per-race .db file)

```sql
CREATE TABLE detected_segments (
    id INTEGER PRIMARY KEY,
    race_id INTEGER NOT NULL REFERENCES race_meta(id),
    start_time TEXT NOT NULL,
    end_time TEXT NOT NULL,
    duration_s REAL NOT NULL,
    mean_tws REAL NOT NULL,
    mean_twa REAL NOT NULL,
    mean_stw REAL NOT NULL,
    std_tws REAL NOT NULL,
    std_twa REAL NOT NULL,
    std_stw REAL NOT NULL,
    percent_polar REAL,
    sail_config TEXT,
    excluded INTEGER NOT NULL DEFAULT 0,
    thresholds TEXT NOT NULL
);

CREATE INDEX idx_segments_race ON detected_segments(race_id);
```

- `thresholds` stores the detection parameters used as JSON (e.g., `{ "tws": 1.5, "twa": 10, "stw": 0.5, "minDuration": 60 }`) so results are reproducible
- `excluded` is a boolean flag (0/1) — user can manually exclude segments from analysis without deleting them
- `sail_config` is populated by matching the segment's time range against `sail_tags`; null if no sail tag covers this segment
- `percent_polar` is computed using the active polar profile at analysis time

### 6.6 `sail_inventory` (settings.json, Phase 2)

Stored in the app-level `settings.json` (not per-race), as an array of sail configurations:

```json
{
  "sailInventory": [
    { "id": "j1-main", "label": "J1 + Main" },
    { "id": "j2-main", "label": "J2 + Main" },
    { "id": "j3-main", "label": "J3 + Main" },
    { "id": "a2-main", "label": "A2 + Main" },
    { "id": "a3-main", "label": "A3 + Main" },
    { "id": "j2-reef1", "label": "J2 + Main + 1 reef" },
    { "id": "j3-reef1", "label": "J3 + Main + 1 reef" }
  ]
}
```

Pre-seeded with a typical Sun Fast 3300 racing sail inventory.

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
| `races:list` | Renderer → Main | — | List recorded race .db files (Phase 2) |
| `races:files` | Main → Renderer | `[{ path, label, date, duration, points, size }]` | Available race files (Phase 2) |
| `races:open` | Renderer → Main | `{ filePath }` | Open a race file for analysis (Phase 2) |
| `races:delete` | Renderer → Main | `{ filePath }` | Delete a race file (Phase 2) |
| `analysis:data` | Main → Renderer | `{ metrics, timeRange }` | Reconstructed time-series data for strip charts (Phase 2) |
| `analysis:detect-segments` | Renderer → Main | `{ thresholds }` | Run segment detection with given thresholds (Phase 2) |
| `analysis:segments` | Main → Renderer | `[{ id, start, end, duration, tws, twa, stw, ... }]` | Detected segments (Phase 2) |
| `analysis:exclude-segment` | Renderer → Main | `{ segmentId, excluded }` | Toggle segment exclusion (Phase 2) |
| `analysis:sail-tags` | Renderer → Main | `{ raceId, tags: [{ config, start, end }] }` | Save sail tags for a race (Phase 2) |
| `analysis:get-sail-tags` | Renderer → Main | `{ raceId }` | Load sail tags for a race (Phase 2) |

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
| PGN parser | @canboat/canboatjs | MIT, 450+ stars; ActisenseStream for BST decoding, FromPgn.parseBuffer() for PGN parsing |
| Serial I/O | @serialport | Mature Electron support; raw bytes piped through ActisenseStream Transform (no ReadlineParser) |
| Database | SQLite via better-sqlite3 | Sync, zero-config, fast |
| Strip charts (Phase 2) | HTML5 Canvas (custom) | Performance for 10k+ data points; no heavy charting library needed — simple line plots with zoom/pan |
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

### 13.3 Phase 2 — Analysis engine tests
- **Data reconstruction:** Given stored PGN rows (canboatjs native units), correctly reconstructs TWS/TWA/TWD/STW/AWS/AWA time series with proper unit conversions
- **Resampling:** Correctly interpolates metrics to 1-second grid; gaps ≥ 5s produce breaks
- **Segment detection — basic:** Given a synthetic time series with one 120s steady-state period (TWS=12±0.5, TWA=90±3, STW=6.5±0.2), detects exactly one segment with correct mean values
- **Segment detection — merge:** Two qualifying windows separated by 8s of non-qualifying data are merged into one segment
- **Segment detection — no merge:** Two qualifying windows separated by 15s of non-qualifying data remain as two separate segments
- **Segment detection — below minimum duration:** A 25-second stable period (with 60s minimum) is not detected
- **Segment detection — exclusion:** Segment with mean STW < 1.0 kts is discarded
- **Segment detection — thresholds:** Tightening TWS threshold from ±1.5 to ±0.5 reduces the number of detected segments in a test dataset
- **% of polar per segment:** Mean TWS=12, TWA=90 → correct interpolated target speed, correct percentage
- **Sail tag assignment:** Segment from 10:00–12:00 with sail tag "J2 + Main" from 09:50–12:30 → segment gets sail_config = "J2 + Main"
- **Sail tag gap:** Segment from 10:00–12:00 with no overlapping sail tag → sail_config = null
- **Performance summary aggregation:** Three segments for "J2 + Main" at TWS 10–12 → correct average % polar for that cell

### 13.4 Phase 2 — Renderer tests
- Race browser: lists race files with correct metadata
- Race browser: clicking a race opens the Analysis view
- Strip charts: renders all metric strips for a loaded race
- Strip charts: zoom/pan controls work correctly
- Strip charts: segment overlays appear at correct time ranges
- Sail tag bar: displays current sail assignments
- Polar overlay: plots measured data points at correct TWA/STW coordinates
- Polar overlay: sail filter dropdown shows only sails with tagged segments
- Performance summary: table renders correct values per TWS/TWA band
- Segment list: clicking a segment scrolls strip charts to that time range
- Segment list: excluding a segment removes it from polar overlay and summary

### 13.5 Build
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
│   ├── analysis-engine.ts     # (Phase 2) Data reconstruction, segment detection, performance aggregation
│   ├── database.ts            # SQLite schema + write logic + batch buffer
│   └── ipc-handlers.ts        # IPC bridge to renderer
├── src/
│   ├── components/
│   │   ├── Dashboard/         # Live connection + real-time values + % of polar
│   │   ├── PolarView/         # Polar diagram renderer + import UI + measured data overlay (Phase 2)
│   │   ├── Races/             # (Phase 2) Race browser — list, search, open, delete
│   │   ├── Analysis/          # (Phase 2) Strip charts, segment controls, sail tagging, perf summary
│   │   ├── Controls/          # Start/stop logging, connection config
│   │   └── Settings/          # Connection, PGN filter, data directory, polar profile, sail inventory
│   ├── store/
│   │   ├── useN2KStore.ts     # Real-time PGN state
│   │   ├── useRaceStore.ts    # Race list + active race state
│   │   ├── useAnalysisStore.ts # (Phase 2) Loaded race data, segments, sail tags, thresholds
│   │   ├── usePolarStore.ts   # Polar profiles + live % of polar
│   │   └── useSettings.ts     # Connection settings + sail inventory
│   ├── types/
│   │   ├── n2k-pgns.ts        # PGN type definitions
│   │   ├── polar.ts           # Polar data type definitions
│   │   ├── analysis.ts        # (Phase 2) Segment, sail tag, performance types
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

## 15. Out of Scope

### Delivered in Phase 1
- ~~Race replay / playback~~ → partially addressed by strip charts in Phase 2
- ~~Time-series charts~~ → delivered as strip charts in Phase 2
- ~~Race browser / history list~~ → delivered in Phase 2

### Out of scope for Phase 2
- **Track visualization on map** (Phase 3 — requires GPS track rendering on OpenStreetMap tiles)
- **Color-coded track segments by % of polar** (Phase 3 — requires track visualization)
- **CSV/data export** (Phase 3)
- **VMG computation** (Phase 3)
- **Auto-derived polar from logged data** (Phase 3 — generate a complete measured polar table from accumulated segments across multiple recordings)
- **Race comparison / overlay** (Phase 4 — compare strip charts or polars from two different recordings side by side)
- **Multiple boat profiles** (Phase 4 — Phase 2 supports one active polar at a time)
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

1. **Phase 1 scope: connect + monitor + record + polars + TCP + debug** — polars, TCP (network gateway), and debug pulled into Phase 1 per user request.
2. **Serial defaults: COM3 at 115,200 baud** — per user specification.
3. **Dark theme by default** — cockpit-appropriate, low glare. No light mode toggle in v1.
4. **One SQLite file per race** — self-contained, portable.
5. **250ms batch write buffer** — balances write performance vs data freshness.
6. **No auto-update in v1** — manual reinstall for updates.
7. **No Windows code signing** — SmartScreen warning is acceptable for personal use.
8. **electron-builder for packaging** — Windows .exe installer with bundled native modules.
9. **Sun Fast 3300 polar pre-loaded** — user has polar file available; stored in `~/n2k-race-logger/polars/`.
10. **NGT-1 initialization command required** — the NGT-1 will not stream data without receiving a BST-framed startup command after serial port open. The Actisense Comms SDK DLL was evaluated and rejected (Windows-only native C DLL from 2010, NDA licensing, unnecessary complexity). Instead, the well-established canboat reverse-engineered init sequence is used (Apache 2.0, proven across multiple implementations). Added 2026-06-12.
11. **Keepalive every 20 seconds** — prevents the NGT-1 from reverting to its default PGN filter. Same startup command re-sent on interval. Added 2026-06-12.
12. **ActisenseStream for BST decoding** — `FromPgn` is an EventEmitter (not a Node.js stream), so serial data cannot be piped to it directly. `ActisenseStream` (from canboatjs) is a proper Transform stream that decodes BST framing; decoded frames are then fed to `FromPgn.parseBuffer()`. The stream is created with `{ fromFile: true, reconnect: false, app: new EventEmitter() }` to use it as a standalone decoder without its own serial port management. `outAvailable` is set to `true` to prevent it from attempting transmit PGN configuration on the null serial port. Added 2026-06-14.
13. **Unit conversions at PGN ingestion** — canboatjs outputs NMEA 2000 native units (m/s for speeds, radians for angles). Conversions to knots (×1.94384) and degrees (×180/π) are applied in the Dashboard PGN handler before storing in Zustand. GPS coordinates are already in degrees. Added 2026-06-14.
14. **EMA dampening (τ=1000ms)** — time-based exponential moving average applied to measured and computed wind values (AWS, AWA, STW, SOG, heading, COG, TWS, TWD) in the Zustand store. Uses `alpha = 1 - e^(-dt/τ)` for rate-independent smoothing. Circular angle handling prevents artifacts at 0°/360° wrap. TWA is not smoothed (feeds polar performance). GPS lat/lon not smoothed. Updated 2026-06-16.
15. **True wind computed client-side** — TWS, TWA, and TWD are computed from apparent wind + STW (or SOG) + heading using standard vector decomposition, since Marcus's B&G system does not send true wind PGNs on the N2K bus. TWD is recomputed whenever heading updates. Added 2026-06-14.
16. **Wind reference filtering** — PGN 130306 `reference` field must be explicitly matched: only `"Apparent"` routes to AWS/AWA; `"True (boat/water referenced)"` routes to TWS/TWA; `"Magnetic"` and `"True (ground referenced)"` route to TWS/TWD. Marcus's B&G system sends both Apparent and Magnetic references simultaneously — treating all non-true as apparent caused AWA/AWS to jump between correct values and the magnetic wind direction. The canboatjs field name is `reference` (not `windReference`). Added 2026-06-14.
17. **Magnetic degree indicator (°M)** — COG, TWD, and Heading display with °M suffix to distinguish magnetic from true bearings. Added 2026-06-14.
18. **Wind source filtering (src=22, src=8 dropped)** — Marcus's N2K bus has three devices sending PGN 130306. src=22 transmits constant bogus Apparent wind (0.25 m/s at exactly 180°), causing AWS/AWA to jump between correct and incorrect values. src=8 sends incomplete messages with no speed or angle data. Both are dropped at the serial event handler level in `ipc-handlers.ts` before any downstream processing. Only src=16 (the real B&G wind instrument) is accepted. Added 2026-06-15.
19. **WiFi → TCP rename** — The "Wi-Fi" label in the connection UI was renamed to "TCP" because WiFi implies wireless router connectivity, which is misleading. The feature is a raw TCP socket connection to a network N2K gateway (e.g., Yacht Devices, iKommunicate). Internal mode type changed from `'wifi'` to `'tcp'`. Added 2026-06-16.
20. **TWS and TWD dampening** — TWS and TWD added to EMA dampening alongside measured values. Raw computed values were too jittery for useful display. TWA excluded from dampening because it feeds polar performance calculation and should reflect instantaneous angle. Added 2026-06-16.
21. **Phase 2 in same app, not standalone** — Post-race analysis is built into the N2K Race Logger rather than a separate application. Rationale: data format is tightly coupled (same SQLite schema, same PGN parsing, same polar engine), single user with single install, and natural record→review workflow. Added 2026-06-16.
22. **Steady-state segment detection** — The core analysis insight: instead of trying to analyze every second of a recording, identify periods where TWS/TWA/STW are all stable within configurable thresholds for a minimum duration. Each qualifying period produces one reliable polar data point (mean values). This filters out tacks, gybes, maneuvers, gusts, and other transient conditions that would pollute the analysis. Added 2026-06-16.
23. **Sail tags as free-text labels** — Sail configuration labels are stored as plain text in the per-race database, not as foreign keys to the sail inventory. This means renaming or deleting a sail in settings doesn't corrupt historical data. The inventory is a convenience for selection, not a constraint on storage. Added 2026-06-16.
24. **Custom Canvas strip charts** — HTML5 Canvas is used for strip charts rather than a charting library (Chart.js, D3, etc.). Recordings may contain 10,000+ data points per metric; Canvas handles this without DOM bloat. The charts are simple line plots with zoom/pan — no need for a heavy library. Added 2026-06-16.
25. **Analysis runs in main process** — Segment detection, data reconstruction, and performance aggregation run in the Electron main process (not renderer). SQLite reads are synchronous via better-sqlite3, and the computation is CPU-bound. Results are sent to the renderer via IPC. For very large recordings, consider a worker thread in the future. Added 2026-06-16.
