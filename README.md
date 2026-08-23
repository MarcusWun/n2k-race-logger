# N2K Race Logger

A Windows desktop application for competitive sailors. Logs NMEA 2000 instrument data from an Actisense NGT-1 serial gateway or a B&G H5000 instrument network, stores it locally in SQLite, and provides post-race analysis tools for sail performance assessment against polar diagrams.

> Personal project. Built for one boat, one sailor. Not a general-purpose tool.

---

## Features

### Live Dashboard
- Real-time instrument tiles: STW, SOG, COG, TWS, TWA, TWD, AWS, AWA, Heading, GPS position, VMG, % of polar
- Connection indicator with staleness detection (dims tiles when sensor data is older than 5 s)
- Dark theme designed for cockpit use (low glare)

### Dual Acquisition Sources
- **NGT-1 serial (default):** Actisense NGT-1 via COM port; Actisense binary protocol (BST framing) decoded via canboatjs `ActisenseStream`; BST init command sent on connect and kept alive every 20 s; baud rate auto-detection (115 200 / 230 400)
- **GoFree Ethernet (Phase 2.7):** B&G H5000 instrument CPU via GoFree Tier 2 WebSocket (port 2053); multicast auto-discovery; fast polling for core channels (200 ms), normal polling for secondaries (1 s); stale-data watchdog; per-tile `--` display when channel is stale; capped exponential reconnect backoff

Only one source is active at a time. Switch in Settings.

### Race Recording
- Start/stop recording with an optional race label
- One SQLite `.db` file per race in a configurable data directory
- All PGNs logged at their native update rate
- SQLite WAL mode ensures no data loss on crash; interrupted recordings are detected and recovered on next open

### Polar Diagram & Live % of Polar
- Import polar files in `.pol`/`.csv` format or Expedition format
- Polar diagram viewer with multi-TWS curves
- Live % of polar tile on the dashboard (STW vs polar-predicted speed); color-coded green/yellow/red
- PCHIP spline interpolation in the TWA dimension for smooth polar curves

### Post-Race Analysis
- **Strip charts:** Stacked time-series for all recorded metrics on a shared zoomable time axis; steady-state segment overlays; overview bar
- **Segment detection:** Automatic identification of steady-state sailing periods (configurable TWS/TWA/STW thresholds and minimum duration); circular statistics for TWA (correct near ±180°); segment merging guard (no unsteady-gap contamination); segment splitting at sail-change boundaries
- **Sail tagging:** Annotate time ranges with sail configurations; multiple sails per race supported
- **Performance summary:** Average % of polar by sail × TWS band × TWA band with coverage indicator
- **Polar overlay:** Measured data points plotted on the reference polar, filterable by sail and TWS band

### Exports
- CSV export for raw segment and performance data
- Formatted Excel (`.xlsx`) export with frozen headers, filters, column widths, number formats, and `% Polar` color thresholds

### Data Quality & Provenance (Phase 2.8)
- **Data Quality panel:** Per-race sensor availability percentages (BSP, wind, GPS), largest gaps, disconnect count, stale events
- **Provenance block:** Records acquisition source, connection parameters, app version, and git commit SHA alongside every race
- **NGT-1 stale chip:** Amber "NGT-1 — Stale (no data)" indicator when the serial port is open but no valid PGN has arrived within 5 s
- **Interrupted recording banner:** Shown when a race was not cleanly stopped; displays the recovered end time

---

## Tech Stack

| Layer | Choice |
|---|---|
| Desktop framework | Electron 33 |
| Language | TypeScript 5 |
| UI | React 18 + Vite 6 + Tailwind CSS |
| State management | Zustand 5 |
| Database | SQLite via better-sqlite3 |
| PGN parsing | @canboat/canboatjs (ActisenseStream + FromPgn) |
| Serial I/O | serialport 12 |
| WebSocket | ws 8 (GoFree) |
| Testing | Vitest 3 |
| Packaging | electron-builder (Windows x64 .exe) |

---

## Building from Source

**Requirements:** Node.js 22+, npm, Git, Windows 10/11 x64 (for installer build)

```bash
git clone https://github.com/MarcusWun/n2k-race-logger.git
cd n2k-race-logger
npm install

# Rebuild native SQLite bindings if needed
npm rebuild better-sqlite3

# Run tests
npm run test:run

# Typecheck
npm exec tsc -- --noEmit

# Build Windows installer
npm run build
```

The installer is written to `release/`. The `npm run build` step runs `scripts/gen-build-info.js` as a prebuild hook to bake the git short SHA and package version into `electron/build-info.ts`.

---

## Development

```bash
npm run dev     # Vite dev server + Electron
npm test        # Vitest watch mode
```

---

## Connection Setup

### NGT-1 (default)
1. Plug in the Actisense NGT-1 USB gateway
2. Open Settings → select the COM port (usually COM3 or COM4)
3. Click Connect

The app sends the BST initialization command automatically and keeps the device alive every 20 s.

### GoFree / B&G H5000
1. Connect the PC to the boat's Ethernet network
2. Open Settings → switch Data Source to GoFree
3. Set the H5000 IP and port (default: `192.168.1.233:2053`)
4. Click Connect

The app connects to the H5000 CPU directly via GoFree Tier 2 WebSocket — not NMEA 0183. If your H5000 is on a different IP, update the setting accordingly.

---

## Project Files

```
n2k-race-logger/
├── electron/              # Main process (Node.js / Electron)
│   ├── main.ts
│   ├── serial-manager.ts  # NGT-1: BST decode, reconnect hardening, stale watchdog
│   ├── gofree-manager.ts  # GoFree Tier 2 WebSocket manager
│   ├── n2k-parser.ts      # PGN normalization (normalizeParsedPgn)
│   ├── polar-engine.ts    # Polar parsing (including Expedition format), interpolation
│   ├── analysis-engine.ts # Data reconstruction, segment detection, performance aggregation
│   ├── database.ts        # SQLite schema, write logic, batch buffer
│   ├── ipc-handlers.ts    # IPC bridge; routes connection events by data source
│   ├── timed-value.ts     # TimedValue type for freshness-limited sensor caching
│   ├── wind-utils.ts      # Circular statistics: circularMean, circularDispersion
│   └── build-info.ts      # Git SHA + version baked at build time
├── src/                   # Renderer (React)
│   ├── components/
│   │   ├── Dashboard/
│   │   ├── Analysis/      # Strip charts, segments, sail tagging, performance
│   │   ├── Races/
│   │   ├── PolarView/
│   │   └── Settings/
│   └── store/
├── scripts/
│   └── gen-build-info.js  # Prebuild: writes build-info.ts with git SHA
├── polars/                # Imported polar files (gitignored)
├── races/                 # Race .db files (gitignored)
├── CONTRACTS.md           # IPC contracts and data conventions
├── BUG_LEDGER.md          # Known bugs, root causes, regression coverage
└── QUALITY.md             # Release criteria and canonical build/test commands
```

---

## Out of Scope

This is a focused personal tool. Not planned:

- Track visualization on map (GPS track rendering)
- Weather routing, GRIB, chartplotter integration
- Competitor tracking
- Multi-user, cloud sync, accounts
- macOS or Linux support
- Race comparison / overlay across multiple recordings
- Auto-update mechanism
