## RALPH Loop — Orchestrator Agent

### Current Build
- PRD: n2k-race-logger-prd.md
- PRD approved by CTO: 2026-06-01 (updated 2026-06-12, 2026-06-13)
- Phase 1 shipped: 2026-06-06 (manually built, not via orchestrator pipeline)
- App type: Electron desktop app (Windows x64) — NOT a web app
- Stack: Electron + React 18 + Vite + TypeScript + Tailwind + Zustand + better-sqlite3 + @serialport + @canboat/canboatjs + electron-builder + Vitest
- Repo: https://github.com/MarcusWun/n2k-race-logger.git
- Working directory: /home/marcus/.openclaw/workspace-cto/n2k-race-logger

### Stack Deviations from Default
- No Next.js → React 18 + Vite renderer
- No Supabase → better-sqlite3 (local SQLite)
- No Vercel → electron-builder (Windows .exe installer)
- No Supabase Auth → no auth needed (single-user desktop app)
- No Redis → IPC between Electron main and renderer
- "Backend" = Electron main process (serial-manager, n2k-parser, polar-engine, database, ipc-handlers)
- "Frontend" = React renderer (Dashboard, PolarView, Controls, Settings components + Zustand stores)

### Phase 1 — COMPLETE (shipped 2026-06-06)
All backend (X1-X8) and frontend (F1-F8) tasks completed.
Iterative fixes shipped through 2026-06-12:
- `d0fe212` — Black screen fix (Vite base path), native module rebuild, frameless window controls, DB INSERT bug
- `254b6b7` — Debug window, WiFi/TCP connectivity, polar chart fix
- `020d622` — Parsed N2K data in debug window
- `da4be16` — Actisense binary protocol via FromPgn transform stream
- `38aa665` — BST startup command to NGT-1, keepalive every 20s

### Incremental Update — 2026-06-13
PRD updated with these requirements. Implementation status:

| Feature | PRD Section | Status |
|---------|------------|--------|
| BST binary protocol (not ASCII) | §4.1 | ✅ Done (da4be16) |
| NGT-1 init command after serial open | §4.1 | ✅ Done (38aa665) |
| Keepalive every 20s | §4.1 | ✅ Done (38aa665) |
| Baud rate auto-detection (115200→230400 fallback) | §4.1 | ❌ Not implemented |

### Incremental Update — 2026-07-20
Shipped time ruler, TWA normalization, CSV/PDF exports, settings error handling (build #37).

### Incremental Update — 2026-07-17
Shipped day/night toggle (CSS vars + Zustand), TWA normalized to 0-180° P/S, CI branch fix master→main.

### Current Task — 2026-07-29: Dashboard Polar Performance Bugfix
Marcus reported that while connected to the B&G system under sail, all dashboard values look correct except `% Polar`, which always shows `0%`.

Approved scope:
1. Load/confirm the active polar profile for dashboard live calculations.
2. Recompute live polar performance when STW/TWS/TWA updates by invoking `polar:performance` with current values and active profile ID.
3. Normalize live dashboard TWA to the polar table's 0-180 degree range before lookup and live polar dot rendering.
4. Render `--` when required inputs/profile are missing instead of misleading `0%`.
5. Add/adjust regression tests for dashboard polar calculation wiring and TWA normalization.

Initial CTO investigation:
- `Dashboard.tsx` subscribes to `polar:performance` events and renders `usePolarStore().performance`, but there is no visible live dashboard request to `ipc.getPerformance(...)`.
- `ipc-handlers.ts` computes performance only when `polar:performance` is invoked, then emits the result back to the renderer.
- Dashboard `computeTrueWind()` can store TWA as 0-360 degrees, while the polar table and renderer expect normalized 0-180 degrees.
- Relevant files: `src/components/Dashboard/Dashboard.tsx`, `src/components/PolarView/PolarDiagram.tsx`, `src/store/usePolarStore.ts`, `electron/ipc-handlers.ts`, `electron/polar-engine.ts`, `src/utils/angles.ts`.

### Current Task — 2026-07-23: Three Bug Fixes
Three issues reported by Marcus from boat use. Implement all three, QA, then commit and push to trigger build.

#### Fix 1 (CRITICAL): Settings not persisting across new builds
**Symptoms:** Data directory shows empty, active polar profile shows None, sail inventory resets — after installing a new build.

**Root cause investigation needed:**
- `AppSettings` type (`src/types/ipc.ts`) is missing `sailInventory`, `connectionMode`, `tcpHost`, `tcpPort`
- `useSettings.ts` `defaultSettings` also missing these fields
- `Settings.tsx` reads/writes `sailInventory` via `(draft as any).sailInventory` cast — fragile
- `loadAppSettings()` in `ipc-handlers.ts` returns saved file as-is (no default merge for missing fields, except `sourcePreferences`)
- Settings file lives at `%APPDATA%\n2k-race-logger\settings.json` — survives reinstalls normally

**Fixes to make:**
1. Add `sailInventory`, `connectionMode`, `tcpHost`, `tcpPort` to `AppSettings` interface in `src/types/ipc.ts`
2. Add `sailInventory` (with DEFAULT_SAIL_INVENTORY values), `connectionMode: 'serial'`, `tcpHost: '192.168.1.1'`, `tcpPort: 2000` to `DEFAULT_SETTINGS` in `electron/ipc-handlers.ts`
3. Update `loadAppSettings()` to merge loaded settings with `DEFAULT_SETTINGS` so new fields added in a new build get their defaults when the user's settings.json is from an older build: `return { ...DEFAULT_SETTINGS, ...saved, sourcePreferences: saved.sourcePreferences ?? ... }`
4. Remove `(draft as any)` casts in `Settings.tsx` now that `sailInventory` is properly typed
5. Update `useSettings.ts` `defaultSettings` to include all fields (or just have it match the type)

#### Fix 2 (minor): Dashboard connection state resets on tab switch
**Symptoms:** When switching away from the Dashboard tab and back, connection status indicator resets to "disconnected" even though N2K is still connected.

**Root cause:** `ConnectionBar.tsx` keeps `status`, `mode`, `tcpHost`, `tcpPort`, `selectedPort`, `baudRate` in local component state. Dashboard unmounts on tab switch → ConnectionBar unmounts → state is lost.

**Fix:** Create `src/store/useConnectionStore.ts` using the existing Zustand pattern (see `useThemeStore.ts`, `useSettings.ts`). Move all persisted state there: `mode`, `tcpHost`, `tcpPort`, `selectedPort`, `baudRate`, `status`. `ConnectionBar.tsx` reads/writes from the store instead of useState. The `connection:status` IPC event still updates the store.

Note: The store only needs to persist the UI-side fields across tab navigation — NOT across app restarts (no localStorage persistence needed for status).

#### Fix 3 (minor): TCP error shows `192.168.1.1.:2000` with extra dot
**Symptoms:** Error message reads `ECONNREFUSED 192.168.1.1.:2000` — a dot appears between the host and the `:port`.

**Root cause:** Either the saved `tcpHost` value in settings.json has a trailing dot, OR the error message in `serial-manager.ts` formats `${host}:${port}` when `host` already ends in `.`. Node.js itself does not add a dot.

**Fix:**
1. In `ConnectionBar.tsx` `handleConnect`, trim and strip trailing dots from `tcpHost` before passing to `ipc.connect()`: `host: tcpHost.trim().replace(/\.+$/, '')`
2. Also strip on load in the `ipc.getSettings()` callback: apply the same trim when setting `setTcpHost()`
3. In `electron/ipc-handlers.ts` / `serial-manager.ts`, defensively strip trailing dot from host before calling `socket.connect()`

### Last Completed Step
2026-07-29 12:48 EDT — Dashboard `% Polar` bugfix implemented. Dashboard now loads the active polar profile, requests live `polar:performance` when STW/TWS/TWA/profile changes, normalizes live TWA before lookup/dot rendering, shows `--` for missing inputs/profile, and has regression coverage. Verification passed: `npm exec vitest run electron/phase-2-3-frontend.test.ts`, `npm run test:run`, `npm exec tsc -- --noEmit`, `npm run build`.

### Agent Status Log
| Timestamp (UTC) | Agent | Action | Result | Notes |
|-----------------|-------|--------|--------|-------|
| 2026-06-01 21:03 | — | PRD parsed, tasks broken down | — | Electron desktop app, not web app |
| 2026-06-13 15:25 | CTO | Reset orchestrator state | — | Phase 1 complete, incremental update mode |
| 2026-07-29 16:48 | Orchestrator | Dashboard polar performance bugfix | ✅ Complete | Active profile loaded, live calculation wired, TWA normalized, missing inputs render `--`, tests/build passed |

### QA Failure Log
| Timestamp (UTC) | Gate | Failure Summary | Returned To | Resolved |
|-----------------|------|-----------------|-------------|----------|

### Deployment Log
| Timestamp (UTC) | Environment | Commit SHA | Status | Notes |
|-----------------|-------------|------------|--------|-------|
| 2026-06-06 | Windows x64 | ecee113 | ✅ Shipped | Phase 1 initial build |
| 2026-06-08 | Windows x64 | 5d8798b | ✅ Shipped | Black screen fix + features |
| 2026-06-12 | Windows x64 | 38aa665 | ✅ Shipped | NGT-1 init + keepalive |
| 2026-07-23 | Windows x64 | 88f7dbc | ✅ Pushed | Fix: settings persistence (sailInventory/connectionMode/tcpHost/tcpPort added to AppSettings + DEFAULT_SETTINGS with merge-on-load); ConnectionBar state moved to useConnectionStore so status survives tab switch; tcpHost trailing dot stripped before connect |
