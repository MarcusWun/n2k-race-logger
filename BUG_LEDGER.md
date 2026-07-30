# Bug Ledger — n2k-race-logger

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
