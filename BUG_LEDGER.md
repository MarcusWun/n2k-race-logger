# Bug Ledger — n2k-race-logger

Track recurring defects, root causes, regression coverage, and verification evidence.

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
