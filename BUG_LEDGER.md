# Bug Ledger — n2k-race-logger

---

## Phase A — Correctness Fixes (2026-08-23)

### #1 — Transposed polar parsing (P0 correctness)

- **Root cause:** `parsePolContent` and `parseCsvContent` in `electron/polar-engine.ts` accumulated per-TWA rows and pushed them as `speeds[twaIdx][twsIdx]`, but the `PolarTable` interface documents `speeds[twsIdx][twaIdx]`. Every user-imported `.pol` and `.csv` file produced a transposed matrix. `interpolateSpeed` and `getOrBuildSpline` index `speeds[twsIdx]` expecting a TWS row; they dereferenced a column instead, returning nonsense or throwing. The seed polar escaped because its data is constructed manually in the correct shape.
- **Files:** `electron/polar-engine.ts`
- **Regression test IDs:** `polar-engine.test.ts` — "Fix #1 — Polar parse round-trips" suite (parsePolContent round-trip, parseCsvContent round-trip, parseExpeditionContent round-trip, assertPolarShape transposed throws, assertPolarShape correct no-throw). Also updated existing "Polar file parsing" and "Regression guard" tests to expect the corrected layout.
- **Prevention:** Added `assertPolarShape()` helper called from both `interpolateSpeed` and `getOrBuildSpline`. Shape mismatch now throws a clear error on first lookup, not a silent wrong value. New callers of these functions must ensure their input polar table was produced by a parser or hand-constructed in `speeds[twsIdx][twaIdx]` order.

### #2 — Math.min/max spread crash on long races (P0 correctness)

- **Root cause:** `reconstructTimeSeries` handler in `electron/ipc-handlers.ts` computed time range via `Math.min(...allTimes)` and `Math.max(...allTimes)`. V8 enforces a ~150k argument limit on function calls via spread; offshore races at 4–10 Hz accumulate >150k timestamps. The crash terminated `reconstructTimeSeries` entirely.
- **Files:** `electron/ipc-handlers.ts` (lines 678–679)
- **Fix assumption:** `allTimes` is sorted ascending because `reconstructTimeSeries` in `analysis-engine.ts` processes timestamps via `Array.from(rawPoints.keys()).sort(...)` before building the time series. Direct array access `allTimes[0]` / `allTimes[allTimes.length - 1]` is correct by this invariant. A comment was added citing the sort dependency.
- **Regression test IDs:** `phase-a-correctness.test.ts` — "Fix #2 — Time-range extraction from large allTimes arrays" suite (200k element no-throw, old spread throws, small array regression, sort invariant verified via reconstructTimeSeries).
- **Prevention:** Avoid `Math.min/max(...array)` for arrays of unbounded size. Use reduce or direct access for sorted arrays.

### #3 — CI never regenerates build-info.ts (P1 correctness)

- **Root cause:** `.github/workflows/build-windows.yml` invoked `npx tsc && npx vite build && npx electron-builder` directly, bypassing npm's `pre<script>` hook mechanism. The `prebuild` hook (`node scripts/gen-build-info.js`) was never triggered in CI, so every installer embedded a stale locally-committed SHA. Additionally, `npx tsc` without `--noEmit` emitted `.js` files into the working tree.
- **Files:** `.github/workflows/build-windows.yml`, `.gitignore`, `electron/build-info.ts`, `electron/build-info.default.ts` (new), `scripts/gen-build-info.js`
- **Fix:** CI now runs `npm exec tsc -- --noEmit` (separate typecheck step) then `npm run build` (triggers prebuild hook). `electron/build-info.ts` added to `.gitignore`; committed `build-info.default.ts` serves as the dev fallback with placeholder values. `gen-build-info.js` updated to also export `GIT_BRANCH` and `BUILD_TIME`, and to copy default content when not in a git repo.
- **Regression test IDs:** `build-info.test.ts` — imports `build-info.ts` and `build-info.default.ts`, asserts all exports are strings with correct placeholder values.
- **Prevention:** Always invoke builds via npm scripts (`npm run build`) rather than underlying tools directly, so pre/post hooks are preserved.

### #4-renderer — polar:performance dead listener removed from Dashboard (P1 correctness)

- **Root cause:** `Dashboard.tsx` registered `ipc.on('polar:performance', setPerformance)` (lines 221–223 pre-fix) to receive an unsolicited push from the backend. The backend Phase A fix (#4-backend, commit `870c898`) removed the `getWebContents()?.send('polar:performance', result)` push. With the push gone, the listener became dead code, but its registration and teardown remained. More critically, the listener had no requestId ordering guard — a slow response from a prior request could arrive after a later one and overwrite a fresher result. Even before the backend fix, the listener caused two `setPerformance` calls per request (one via invoke `.then()`, one via the push listener), producing a redundant re-render.
- **Files:** `src/components/Dashboard/Dashboard.tsx`
- **Fix:** Removed the `ipc.on('polar:performance', ...)` registration (3 lines) and its `unsubPerf()` teardown call. Removed `setPerformance` from the dependency array of the affected `useEffect` since it was only used there via the removed listener. The `requestId`-guarded `ipcRenderer.invoke` path in the second `useEffect` remains the sole delivery mechanism.
- **Regression test IDs:** `electron/phase-a-correctness.test.ts` — "Fix #4 renderer — polar:performance dead listener removed from Dashboard (FE4a regression guard)" suite:
  - Static analysis: `Dashboard.tsx` has no non-comment line with `.on(` and `'polar:performance'`.
  - Functional: `requestLivePolarPerformance` (the invoke-path utility) calls `setPerformance` exactly once per call.
  - Rapid-invoke ordering: two concurrent calls each produce exactly one `setPerformance` invocation (2 total), confirming single-delivery per request.
- **Cross-reference:** Backend half documented above as `#4-backend`.
- **Prevention:** For request-response IPC patterns, use `ipcMain.handle` return value (resolved via `ipcRenderer.invoke`) as the sole delivery mechanism. Any renderer listener on a push channel (`ipc.on`) must be paired with a requestId ordering guard. Audit new renderer listeners added in code review.

### #4-backend — polar:performance double delivery (P1 correctness)

- **Root cause:** The `polar:performance` `ipcMain.handle` handler in `electron/ipc-handlers.ts` both returned its result (resolving the `ipcRenderer.invoke` promise) AND sent an unsolicited push via `getWebContents()?.send('polar:performance', result)`. The renderer's event listener for this push had no ordering guard, allowing stale results from slow prior requests to overwrite fresher results.
- **Files:** `electron/ipc-handlers.ts` (~line 533)
- **Regression test IDs:** `phase-a-correctness.test.ts` — "Fix #4 backend — polar:performance single delivery" (static analysis: no non-comment `getWebContents()?.send('polar:performance'` in source).
- **Prevention:** For request-response IPC, use `ipcMain.handle` return value only. Unsolicited pushes must be avoided unless paired with ordering guards (requestId, version counter) in the renderer.

### #6 — splitSegmentsAtSailChanges never called (P1 correctness)

- **Root cause:** `splitSegmentsAtSailChanges` was fully implemented in `analysis-engine.ts` and covered by five unit tests, but was never imported or called in the `analysis:detect-segments` IPC handler in `electron/ipc-handlers.ts`. The handler called `detectSegments → assignSailTags` directly. A segment straddling a sail-change boundary matched neither tag interval (assignSailTags requires full containment), receiving `sailConfig: null` and being silently dropped from the summary.
- **Files:** `electron/ipc-handlers.ts` (~line 745)
- **Regression test IDs:** `phase-a-correctness.test.ts` — "Fix #6 — splitSegmentsAtSailChanges chain wiring" suite (sail-change boundary produces two non-null sailConfig sub-segments; no-boundary segment passes through unchanged). Existing `analysis-engine.test.ts` splitSegmentsAtSailChanges unit tests also reconfirmed.
- **Prevention:** When implementing a new analysis step, add an integration-level test that runs the full handler chain (detect → split → tag → compute) to catch wiring gaps that unit tests for individual functions cannot catch.

### #7 — Backoff never resets after successful reconnect (P1 correctness)

- **Root cause:** `backoffIndex` in `SerialManager` incremented on each reconnect attempt and was only reset to 0 on user-initiated disconnect. A single mid-race dropout requiring 3 retries permanently ratcheted the ladder to the 10s cap, making all subsequent dropouts wait 10s before the first retry.
- **Files:** `electron/serial-manager.ts` (constructor `pgn` listener)
- **Fix:** On each `pgn` event, detect if `lastValidPgnAt` was null (i.e., this is the first PGN of the session) and reset `backoffIndex = 0`. `_clearAllSerialSession` nulls `lastValidPgnAt`, so `wasNull` is true exactly once per reconnect — on the first valid PGN of the new session. This matches the GoFreeManager's `sustainedDataResetMs` intent.
- **Regression test IDs:** `serial-manager.test.ts` — "Fix #7" suite (backoffIndex resets to 0 on first PGN post-reconnect; second dropout uses shortest backoff step; silent port does NOT reset backoff).
- **Prevention:** Reset connection quality counters at the same point that defines "connected" — first data received, not port open. Document this invariant near `lastValidPgnAt`.

### #8 — Initial connection failures never retry (P1 correctness)

- **Root cause:** In `connectSerial` in `electron/serial-manager.ts`, the `tryConnectAtBaud` call's catch block emitted an error status and returned without scheduling retry. Only mid-race disconnects were routed through the backoff retry handler. A user who connected before the NGT-1 USB was ready had to manually click Connect again.
- **Files:** `electron/serial-manager.ts` (~line 478)
- **Fix:** In the catch block, after emitting the error status, call `this._handleSerialDisconnect(...)` if `!this.userInitiatedStop`. This routes open-failure through the same backoff handler as mid-race disconnects, sharing parameters and cleanup logic.
- **Regression test IDs:** `serial-manager.test.ts` — "Fix #8" suite (open failure schedules retry; userInitiatedStop=true suppresses retry; open failure → retry → success reaches connected).
- **Prevention:** All paths that result in "not connected" should lead to the same retry entry point unless the user deliberately stopped.

### S1 — TCP socket timeout fires with no handler

- **Root cause:** `this.tcpSocket.setTimeout(10000)` armed a 10-second timeout before connecting. The `'timeout'` event listener was removed on successful connect via `removeListener`, but `setTimeout(0)` was never called to disarm the underlying OS timer. The idle socket could emit a `'timeout'` event with no handler.
- **Files:** `electron/serial-manager.ts` (`connectTcp` method)
- **Fix:** Added `this.tcpSocket!.setTimeout(0)` in the connect callback, immediately after `removeListener('timeout', onTimeout)`.
- **Prevention:** Always call `setTimeout(0)` after `removeListener` to disarm Node.js socket timers, not just remove the listener.

### S2 — disconnect() doesn't remove port listeners

- **Root cause:** `disconnect()` called `port.close()` and then nulled `this.port`, but never removed the `'error'`, `'close'`, and `'data'` listeners registered during `tryConnectAtBaud`. Between `close()` and GC, a late event could fire the handler against a partially-torn-down manager.
- **Files:** `electron/serial-manager.ts` (`disconnect()` method)
- **Fix:** Added `this.port.removeAllListeners('error', 'close', 'data')` (via three `removeAllListeners` calls) before `close()` in `disconnect()`.
- **Prevention:** Symmetric with the existing `_clearAllSerialSession` pattern — always remove all listeners before releasing object references.

### S3 — Race ID comment wrong (database.ts line 214)

- **Root cause:** Comment read "Unix ms, truncated" but the code is `Math.floor(Date.now() / 1000)` — Unix seconds.
- **Files:** `electron/database.ts` (~line 214)
- **Fix:** Corrected comment to "Unix seconds (10-digit)". Added follow-up note that AUTOINCREMENT would eliminate same-second collision risk but requires a schema migration — deferred as non-blocking.
- **Prevention:** Code review checklist: verify comment accuracy when touching ID generation.

### S4 — loadProfiles() swallows corrupt profile errors

- **Root cause:** `loadProfiles()` catch block contained only `// ignore`. A corrupt `boat-profiles.json` silently fell back to the seed polar with no user-visible warning.
- **Files:** `electron/polar-engine.ts`, `electron/ipc-handlers.ts`
- **Fix:** Added `_profileLoadError: string | null` field to `PolarEngine`. In the catch block, set `this._profileLoadError = err?.message ?? String(err)`. Added `getProfileLoadError()` method. Added `polar:get-load-error` IPC handler.
- **Regression test IDs:** `polar-engine.test.ts` — "Fix S4 — loadProfiles error surfacing" suite (corrupt JSON → non-null error; valid JSON → null error).
- **Prevention:** Never silently discard errors in catch blocks that affect user-visible state. Mirror the `settings-store.ts` `_loadError` pattern for any data-load path.

---

## QF1 — Linear TWA band filter over circular-mean value (2026-08-22)

- **Reproduction:** Port-tack downwind segments (e.g., TWA ≈ −170°) never appeared in the `[150, 180]` performance band. `aggregatePerformance` returned null for the downwind cell despite valid port-tack data being present. The mirror starboard cell (positive TWA ≈ +170) correctly matched, producing an asymmetric and misleading performance table.
- **Root cause:** `aggregatePerformance` filtered segments with `s.meanTwa >= twaBand[0] && s.meanTwa < twaBand[1]` — a linear inequality. Since P0 (Phase 2.8) introduced circular mean for TWA, port-tack `meanTwa` is now stored as a *signed* value (negative = port). The TWA bands are defined as `[0, 180]` (absolute angles). A linear filter cannot match negative values against a positive band: −170 is never ≥ 150.
- **Fix:** Changed filter to `Math.abs(s.meanTwa) >= twaBand[0] && Math.abs(s.meanTwa) < twaBand[1]`. Per-segment `meanTwa` retains its sign (port = negative) in storage and in `DetectedSegmentData`; only the band-matching step uses the absolute value. This is the minimal correct fix: it preserves stored sign for display while making band aggregation sign-agnostic as the band definitions intend.
- **Regression coverage:** `analysis-engine.test.ts` — two new QF1 tests:
  - Port-tack segment with `meanTwa ≈ −170` maps into `[150, 180]` band.
  - Starboard-tack and port-tack segments with equal absolute TWA aggregate into the same band and average is computed over both.
- **Check for same class elsewhere:** `interpolateSpeed` in `analysis-engine.ts` guards `twa < 0` → returns null (line ~748). This guard exists for polar-table domain safety. The `computeSegmentPerformance` path at line 704 originally called `interpolateSpeed(…, seg.meanTwa)` — if `seg.meanTwa` is negative (port tack), this returned null and `percentPolar` remained null. **Fixed in QF3** (same session).
- **Prevention:** When circular-mean values are stored as signed but consumed by range checks, always canonicalize to absolute/[0,180] at the filter boundary. Add a linter note or comment near `TWA_BANDS` to document the expected convention.

## QF3 — Port-tack polar lookup silently null in computeSegmentPerformance (2026-08-22)

- **Reproduction:** Any segment with a port-tack `meanTwa` (e.g. −90°) passed through `computeSegmentPerformance` returned `percentPolar: null`. Starboard segments (positive TWA) computed correctly. This produced an asymmetric performance table where port-tack segments had no polar score.
- **Root cause:** Same class as QF1. `computeSegmentPerformance` at `analysis-engine.ts:704` called `interpolateSpeed(polarTable, seg.meanTws, seg.meanTwa)` with the signed circular mean. `interpolateSpeed` guards `twa < 0 → null` at line 748 because the polar table is defined on `[0°, 180°]`. QF1 fixed the band-filter but did not fix this call site.
- **Fix:** One-line change at `analysis-engine.ts:704`: `Math.abs(seg.meanTwa)` passed to `interpolateSpeed`. Signed `meanTwa` is retained in storage and in `DetectedSegmentData`; only the polar-table lookup boundary converts to absolute value.
- **Regression coverage:** `analysis-engine.test.ts` — two new QF3 tests:
  - Port-tack segment with `meanTwa = −90` produces non-null `percentPolar`.
  - Port-tack segment (`meanTwa = −90`) and starboard (`meanTwa = +90`) with equal TWS/STW produce identical `percentPolar`.
- **Audit — other signed-TWA → [0,180] call sites (main-process):**
  - `polar-engine.ts:594` (`computePerformance`) is called from `ipc-handlers.ts` live polar IPC path. This path receives `twa` from the renderer, which normalizes TWA to `[0,180]` before dispatch (fixed in the "Dashboard polar performance stuck at 0%" bug 2026-07-29). No additional fix required.
  - No heatmap or export call sites pass signed `meanTwa` directly to `interpolateSpeed`. The `saveSegments` path in `database.ts` stores signed `meanTwa` as-is (correct — display layer handles sign). No further fixes required.
- **Prevention rule:** Any function taking TWA for a polar-table lookup operating on `[0°, 180°]` **must** call `Math.abs(twa)` at the consumption boundary. The `interpolateSpeed` guard (`twa < 0 → null`) is a safety net, not a normalization step — callers must not rely on it for sign-handling. Audit any new callers of `interpolateSpeed` in code review.

Track recurring defects, root causes, regression coverage, and verification evidence.

## Phase 2.4 Excel export production audit failure (2026-07-30)

- Reproduction: `npm audit --omit=dev` failed during QA Gate 2 after adding formatted Excel export support, initially attributed to the Excel writer dependency and vulnerable production transitive packages.
- Root cause: The first Excel implementation used a large workbook writer dependency surface. The corrected implementation replaces that with a local offline XLSX package writer backed only by `fflate`; after removing `exceljs`, the remaining production audit finding was an unused legacy MQTT helper chain pulled in by `@canboat/canboatjs`.
- Fix: Keep the approved Excel export UI and workbook behavior, remove the Excel writer dependency surface, use the focused local workbook serializer in `src/utils/excelExport.ts`, and add an npm `mqtt` override so `@canboat/canboatjs` stays current while `npm audit --omit=dev` reports no production vulnerabilities.
- Regression coverage: `electron/phase-2-4-excel-export.test.ts` covers workbook sheet names, grouped headers, key column order, numeric preservation, number formats, `% Polar` threshold styling, XLSX package serialization, visually distinct excluded rows, and CSV regression safety.
- Prevention: New production dependencies used for renderer exports must pass `npm audit --omit=dev`; prefer narrow, auditable utilities over broad file-format libraries when the required workbook behavior is small and covered by tests.

## Dashboard polar performance stuck at 0% (2026-07-29)

- Reproduction: while connected to the B&G N2K system, STW/TWS/TWA dashboard values updated correctly but `% Polar` stayed at `0%`.
- Root cause: Dashboard only listened for `polar:performance` events; it did not load the active profile or invoke `polar:performance` when live STW/TWS/TWA changed. Live port-side TWA could also remain in raw 0-360 degree form, outside the polar table's 0-180 degree lookup range.
- Fix: Dashboard now loads the saved active polar profile, recomputes live performance when STW/TWS/TWA/profile changes, normalizes TWA before lookup and live polar dot rendering, and clears the tile to `--` when inputs/profile are missing.
- Regression coverage: frontend utility tests cover missing-input suppression, live IPC payload generation, and port-side TWA normalization before dashboard polar lookup.
- Verification: `npm exec vitest run electron/phase-2-3-frontend.test.ts`, `npm run test:run`, `npm exec tsc -- --noEmit`, and `npm run build` passed.

## Phase 2.3 — Reliability fixes (2026-07-25)

### AWA displayed/analyzed as raw 0–360°

- Reproduction: port-side apparent wind such as 315° appeared outside expected 0–180° sailing bands.
- Root cause: AWA did not share the TWA normalization path and some analysis/display surfaces consumed raw relative angle values.
- Fix: Added shared wind-angle normalization with side context; analysis/dashboard/strip charts/export-derived views consume normalized AWA/TWA values.
- Regression coverage: analysis and renderer tests cover port-side AWA (e.g. 315° → 45°P) plus shared formatting behavior.
- Verification: `npm run test:run`, `npm exec tsc -- --noEmit`, and `npm run build` passed in QA.

### Settings could revert critical user fields

- Reproduction: save/load/migration failures could risk replacing saved data directory, active polar profile, or sail inventory with defaults/empty values.
- Root cause: defaults and migration fallback paths were not sufficiently separated from last-known user settings, and save success was not tied to durable disk write completion.
- Fix: Added settings store with last-known-good fallback, critical-field preservation, durable temp-write/fsync/rename save, and visible IPC/UI error surfacing.
- Regression coverage: settings tests cover parse/write failure preservation and failed-save behavior.
- Verification: `npm run test:run`, `npm exec tsc -- --noEmit`, and `npm run build` passed in QA.

### TCP host could be malformed/truncated

- Reproduction: reported failure attempted `192.168.1:2000` instead of the intended default gateway target.
- Root cause: host validation/sanitization allowed malformed IPv4-like input through parts of the UI/socket path.
- Fix: Renderer and main-process validation/sanitization now reject malformed hosts, preserve `192.168.1.1:2000`, strip safe trailing dots, validate ports, and include socket target diagnostics.
- Regression coverage: serial-manager/TCP utility tests cover default target, trailing-dot sanitization, malformed `192.168.1`, invalid octets, and bad ports.
- Verification: `npm run test:run`, `npm exec tsc -- --noEmit`, and `npm run build` passed in QA.
