# Quality Gates — n2k-race-logger

This app is an Electron + Vite + React + TypeScript desktop application with local SQLite race files.

## Canonical Commands

Install dependencies:

```bash
npm install
```

If native SQLite bindings mismatch the active Node/Electron runtime:

```bash
npm rebuild better-sqlite3
```

Typecheck:

```bash
npm exec tsc -- --noEmit
```

Run all tests:

```bash
npm run test:run
```

Build/package smoke check:

```bash
npm run build
```

## Release Criteria

A change is releasable only when:

- TypeScript passes.
- Full Vitest suite passes.
- `npm run build` completes.
- Any bug fix includes a regression test or documented manual check.
- Generated `release/`, `dist/`, and `dist-electron/` artifacts are not committed unless an explicit release packaging task asks for them.

## Known Non-blocking Build Warnings

Current Linux build may warn about:

- Vite chunks larger than 500 kB.
- Missing package author.
- Default Electron icon / Linux category.

These are not Phase 2.3 blockers, but should be cleaned up before a polished public release.
