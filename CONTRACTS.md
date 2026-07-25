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
