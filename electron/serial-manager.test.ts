import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { sanitizeTcpHost, sanitizeTcpPort, SerialManager } from './serial-manager';

// ---------------------------------------------------------------------------
// Existing TCP sanitization tests (unchanged)
// ---------------------------------------------------------------------------

describe('SerialManager TCP target validation/sanitization', () => {
  it('preserves the default TCP target', () => {
    const target = sanitizeTcpHost('192.168.1.1');
    expect(target.host).toBe('192.168.1.1');
    expect(sanitizeTcpPort(2000)).toBe(2000);
  });

  it('corrects reported truncated host 192.168.1 to default gateway', () => {
    const target = sanitizeTcpHost('192.168.1');
    expect(target.host).toBe('192.168.1.1');
    expect(target.corrected).toBe(true);
    expect(target.warning).toContain('corrected');
  });

  it('sanitizes trailing dots without truncating valid host', () => {
    const target = sanitizeTcpHost('192.168.1.1...');
    expect(target.host).toBe('192.168.1.1');
    expect(target.corrected).toBe(true);
  });

  it('rejects other incomplete IPv4-like hosts', () => {
    expect(() => sanitizeTcpHost('10.0.0')).toThrow(/expected a full IPv4 address/);
  });

  it('rejects invalid IPv4 octets and ports', () => {
    expect(() => sanitizeTcpHost('192.168.1.999')).toThrow(/0-255/);
    expect(() => sanitizeTcpPort(0)).toThrow(/1-65535/);
    expect(() => sanitizeTcpPort(70000)).toThrow(/1-65535/);
  });
});

// ---------------------------------------------------------------------------
// BE1 — NGT-1 Disconnect/Error Hardening tests  (PRD §3.1)
//
// All tests inject a MockSerialPort so no real hardware is required.
// The 'pgn' event is emitted directly on the manager to simulate incoming
// NMEA 2000 data without wiring through the full BST→canboatjs chain.
// ---------------------------------------------------------------------------

/** Minimal mock SerialPort that can be controlled from tests. */
class MockSerialPort extends EventEmitter {
  static instances: MockSerialPort[] = [];

  isOpen = false;
  path: string;
  baudRate: number;

  constructor(opts: { path: string; baudRate: number; parity?: string; autoOpen?: boolean }) {
    super();
    this.path = opts.path;
    this.baudRate = opts.baudRate;
    MockSerialPort.instances.push(this);
  }

  open(cb: (err: Error | null) => void): void {
    this.isOpen = true;
    // Simulate async open
    Promise.resolve().then(() => cb(null));
  }

  close(cb: () => void): void {
    this.isOpen = false;
    Promise.resolve().then(() => cb());
  }

  pipe(_dest: any): this { return this; }
  write(_data: any): void { /* no-op */ }

  /** Simulate an unexpected error from the OS/driver. */
  simulateError(msg: string): void {
    this.emit('error', new Error(msg));
  }

  /** Simulate an unexpected port close (USB unplug etc.). */
  simulateClose(): void {
    this.isOpen = false;
    this.emit('close');
  }
}

/** Helper to build a SerialManager wired with a MockSerialPort. */
function makeManager(overrides: ConstructorParameters<typeof SerialManager>[0] = {}): SerialManager {
  return new SerialManager({
    SerialPortImpl: MockSerialPort,
    canboatImpl: null,     // disable canboat so no real native module is needed
    baudRatesToTry: [115200], // single rate → isLastAttempt = true, no baud wait
    initDelayMs: 0,         // skip 200ms startup delay
    watchdogTimeoutMs: 100, // fast watchdog for tests
    backoffLadderMs: [50, 100, 200, 500],
    ...overrides,
  });
}

/** Collect all status events emitted by the manager. */
function collectStatuses(mgr: SerialManager): string[] {
  const statuses: string[] = [];
  mgr.on('status', (evt) => statuses.push(evt.status));
  return statuses;
}

describe('SerialManager — BE1: NGT-1 Disconnect/Error Hardening (PRD §3.1)', () => {
  beforeEach(() => {
    MockSerialPort.instances = [];
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Test 1: Unexpected serial close → reconnect attempted, old timers cleaned up
  // -------------------------------------------------------------------------
  it('unexpected serial close → reconnect scheduled, old session state cleared', async () => {
    const mgr = makeManager();
    const statuses = collectStatuses(mgr);

    // Connect; connect() returns after port opens (isLastAttempt = true)
    await mgr.connect({ mode: 'serial', port: 'COM3' });
    expect(statuses).toContain('connected');

    const firstPort = MockSerialPort.instances[MockSerialPort.instances.length - 1];
    expect(firstPort.isOpen).toBe(true);

    // Simulate unexpected close (USB unplug)
    firstPort.simulateClose();

    // Manager should schedule reconnect — status transitions to 'reconnecting'
    expect(statuses).toContain('reconnecting');

    // Keepalive and watchdog are part of the cleared session — they should be null
    // (internal; we verify by confirming the manager is NOT in 'connected' state)
    expect(mgr.isConnected()).toBe(false);

    // Advance past the first backoff delay (50ms)
    await vi.advanceTimersByTimeAsync(60);

    // A new port should have been created for the reconnect attempt
    expect(MockSerialPort.instances.length).toBe(2);

    await mgr.disconnect();
  });

  // -------------------------------------------------------------------------
  // Test 2: Serial error event → same cleanup + reconnect
  // -------------------------------------------------------------------------
  it('serial error event → cleanup and reconnect scheduled', async () => {
    const mgr = makeManager();
    const statuses = collectStatuses(mgr);

    await mgr.connect({ mode: 'serial', port: 'COM3' });
    expect(statuses).toContain('connected');

    const firstPort = MockSerialPort.instances[MockSerialPort.instances.length - 1];

    // Simulate OS-level serial error
    firstPort.simulateError('USB device disconnected');

    expect(statuses).toContain('reconnecting');
    expect(mgr.isConnected()).toBe(false);

    // Old port reference should be nulled before reconnect fires
    // (the manager releases the port in _clearAllSerialSession)
    expect((mgr as any).port).toBeNull();

    await mgr.disconnect();
  });

  // -------------------------------------------------------------------------
  // Test 3: Open-but-silent NGT-1 → 'stale' state after watchdog timeout
  // -------------------------------------------------------------------------
  it('open-but-silent port → stale state after watchdog timeout', async () => {
    // watchdogTimeoutMs = 100ms
    const mgr = makeManager({ watchdogTimeoutMs: 100 });
    const statuses = collectStatuses(mgr);

    await mgr.connect({ mode: 'serial', port: 'COM3' });
    expect(statuses).toContain('connected');
    // No PGN emitted — port is open but silent

    // Advance past the watchdog window
    await vi.advanceTimersByTimeAsync(110);

    expect(statuses).toContain('stale');
    // isConnected() must return false while stale
    expect(mgr.isConnected()).toBe(false);

    await mgr.disconnect();
  });

  // -------------------------------------------------------------------------
  // Test 4: Reconnect to same COM port succeeds → 'connected' state restored
  // -------------------------------------------------------------------------
  it('reconnect to same COM port succeeds → connected state restored', async () => {
    const mgr = makeManager({ backoffLadderMs: [50] });
    const statuses = collectStatuses(mgr);

    await mgr.connect({ mode: 'serial', port: 'COM4' });
    expect(statuses).toContain('connected');

    const firstPort = MockSerialPort.instances[MockSerialPort.instances.length - 1];
    firstPort.simulateClose();
    expect(statuses).toContain('reconnecting');

    // Wait for reconnect to fire and a new port to open
    await vi.advanceTimersByTimeAsync(60);

    const secondPort = MockSerialPort.instances[MockSerialPort.instances.length - 1];
    expect(secondPort).not.toBe(firstPort);
    expect(secondPort.path).toBe('COM4'); // same port

    // The new port opened → 'connected' emitted again
    // (The 'connected' status appears twice: initial + post-reconnect)
    const connectedCount = statuses.filter(s => s === 'connected').length;
    expect(connectedCount).toBeGreaterThanOrEqual(2);

    await mgr.disconnect();
  });

  // -------------------------------------------------------------------------
  // Test 5: Old decoder/timer state does not survive reconnect
  //         (stale timer cannot fire against new session)
  // -------------------------------------------------------------------------
  it('old decoder/timer references are null before new session starts', async () => {
    const mgr = makeManager({ backoffLadderMs: [50] });

    await mgr.connect({ mode: 'serial', port: 'COM3' });

    const firstPort = MockSerialPort.instances[MockSerialPort.instances.length - 1];

    // Capture session state references before disconnect
    const mgrAny = mgr as any;

    // After unexpected close the internal port reference must be null
    firstPort.simulateClose();

    expect(mgrAny.port).toBeNull();
    expect(mgrAny.keepaliveInterval).toBeNull();
    expect(mgrAny.watchdogTimer).toBeNull();
    expect(mgrAny.pgnParser).toBeNull();
    expect(mgrAny.bstDecoder).toBeNull();

    await mgr.disconnect();
  });

  // -------------------------------------------------------------------------
  // Test 6: Valid PGN received after silence → 'connected' state restored
  // -------------------------------------------------------------------------
  it('valid PGN after watchdog silence → state restored to connected', async () => {
    const mgr = makeManager({ watchdogTimeoutMs: 100 });
    const statuses = collectStatuses(mgr);

    await mgr.connect({ mode: 'serial', port: 'COM3' });
    expect(statuses).toContain('connected');

    // Let watchdog fire → 'stale'
    await vi.advanceTimersByTimeAsync(110);
    expect(statuses).toContain('stale');
    expect(mgr.isConnected()).toBe(false);

    // Simulate valid PGN arriving (emitted directly on manager)
    mgr.emit('pgn', { pgn: 130306, fields: { windSpeed: 5.0 } });

    // Manager should transition back to 'connected'
    expect(statuses[statuses.length - 1]).toBe('connected');
    expect(mgr.isConnected()).toBe(true);

    // Watchdog should be reset — waiting another 90ms should NOT fire stale
    await vi.advanceTimersByTimeAsync(90);
    expect(statuses[statuses.length - 1]).toBe('connected');

    await mgr.disconnect();
  });

  // -------------------------------------------------------------------------
  // Test 7: User-initiated disconnect does NOT trigger reconnect
  // -------------------------------------------------------------------------
  it('user-initiated disconnect does not schedule reconnect', async () => {
    const mgr = makeManager({ backoffLadderMs: [50] });
    const statuses = collectStatuses(mgr);

    await mgr.connect({ mode: 'serial', port: 'COM3' });
    await mgr.disconnect();

    const portCountBefore = MockSerialPort.instances.length;

    // Advance past first backoff — should NOT see a reconnect
    await vi.advanceTimersByTimeAsync(200);

    expect(MockSerialPort.instances.length).toBe(portCountBefore);
    expect(statuses[statuses.length - 1]).toBe('disconnected');
  });
});

// ---------------------------------------------------------------------------
// Fix #7 — Backoff reset after successful reconnect (BE6)
// ---------------------------------------------------------------------------

describe('SerialManager — Fix #7: backoff resets to 0 after first valid PGN post-reconnect', () => {
  beforeEach(() => {
    MockSerialPort.instances = [];
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  it('backoffIndex resets to 0 when first valid PGN arrives after a reconnect', async () => {
    // Backoff ladder: [50, 100, 200] → after two failures, backoffIndex = 2 → delay 200ms
    const mgr = makeManager({ backoffLadderMs: [50, 100, 200], watchdogTimeoutMs: 0 });
    const mgrAny = mgr as any;

    // Connect and receive a PGN (establishes session)
    await mgr.connect({ mode: 'serial', port: 'COM3' });
    mgr.emit('pgn', { pgn: 130306, fields: {} });
    expect(mgrAny.backoffIndex).toBe(0);

    // First unexpected close → backoffIndex = 1 (delay = 50ms used)
    const port1 = MockSerialPort.instances[MockSerialPort.instances.length - 1];
    port1.simulateClose();
    expect(mgrAny.backoffIndex).toBe(1);

    // Wait for reconnect attempt
    await vi.advanceTimersByTimeAsync(60);

    // Simulate the reconnect port closing immediately (second failure) → backoffIndex = 2
    const port2 = MockSerialPort.instances[MockSerialPort.instances.length - 1];
    port2.simulateClose();
    expect(mgrAny.backoffIndex).toBe(2);

    // Wait for third reconnect attempt (200ms delay)
    await vi.advanceTimersByTimeAsync(210);

    // Third port is now open — valid PGN arrives → backoffIndex should reset to 0
    mgr.emit('pgn', { pgn: 130306, fields: {} });
    expect(mgrAny.backoffIndex).toBe(0);

    await mgr.disconnect();
  });

  it('second dropout after recovery uses the first (shortest) backoff step', async () => {
    const mgr = makeManager({ backoffLadderMs: [50, 100, 200], watchdogTimeoutMs: 0 });
    const mgrAny = mgr as any;

    // First session
    await mgr.connect({ mode: 'serial', port: 'COM3' });
    mgr.emit('pgn', { pgn: 130306, fields: {} });

    // First dropout → backoffIndex = 1
    MockSerialPort.instances[0].simulateClose();
    expect(mgrAny.backoffIndex).toBe(1);

    // Reconnect + first PGN resets backoffIndex to 0
    await vi.advanceTimersByTimeAsync(60);
    mgr.emit('pgn', { pgn: 130306, fields: {} });
    expect(mgrAny.backoffIndex).toBe(0);

    // Second dropout — should start from backoffIndex = 0 → delay = 50ms (shortest)
    const port2 = MockSerialPort.instances[MockSerialPort.instances.length - 1];
    port2.simulateClose();
    expect(mgrAny.backoffIndex).toBe(1); // incremented after using slot 0

    // Only 60ms needed for reconnect (not 100ms or 200ms)
    await vi.advanceTimersByTimeAsync(60);
    expect(MockSerialPort.instances.length).toBe(3); // third port created at first backoff step

    await mgr.disconnect();
  });

  it('backoff NOT reset on port open (silent port does not reset backoff)', async () => {
    // watchdogTimeoutMs = 0 means no watchdog, but we track backoffIndex manually
    const mgr = makeManager({ backoffLadderMs: [50, 100, 200], watchdogTimeoutMs: 0 });
    const mgrAny = mgr as any;

    await mgr.connect({ mode: 'serial', port: 'COM3' });

    // First dropout → backoffIndex = 1
    MockSerialPort.instances[0].simulateClose();
    expect(mgrAny.backoffIndex).toBe(1);

    // Wait for reconnect attempt — port opens but NO PGN emitted
    await vi.advanceTimersByTimeAsync(60);

    // Port opened but no PGN → backoffIndex must remain 1 (not reset)
    expect(mgrAny.backoffIndex).toBe(1);

    await mgr.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Fix #8 — Open-failure retry (BE6)
// ---------------------------------------------------------------------------

describe('SerialManager — Fix #8: open-failure triggers backoff retry', () => {
  beforeEach(() => {
    MockSerialPort.instances = [];
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  /** MockSerialPort that fails to open with a given error message. */
  class FailingSerialPort extends EventEmitter {
    static instances: FailingSerialPort[] = [];
    isOpen = false;
    path: string;
    baudRate: number;
    private readonly errorMsg: string;

    constructor(opts: { path: string; baudRate: number; parity?: string; autoOpen?: boolean }, errorMsg = 'Access denied') {
      super();
      this.path = opts.path;
      this.baudRate = opts.baudRate;
      this.errorMsg = errorMsg;
      FailingSerialPort.instances.push(this);
    }

    open(cb: (err: Error | null) => void): void {
      Promise.resolve().then(() => cb(new Error(this.errorMsg)));
    }

    close(cb: () => void): void { Promise.resolve().then(() => cb()); }
    pipe(_dest: any): this { return this; }
    write(_data: any): void {}
  }

  it('port open failure schedules retry with first backoff delay', async () => {
    FailingSerialPort.instances = [];
    const mgr = makeManager({
      SerialPortImpl: FailingSerialPort,
      backoffLadderMs: [50, 100],
      watchdogTimeoutMs: 0,
    });
    const statuses = collectStatuses(mgr);

    // connect() should fail — error + reconnecting emitted
    await mgr.connect({ mode: 'serial', port: 'COM3' });
    expect(statuses).toContain('error');
    expect(statuses).toContain('reconnecting');

    // After first backoff delay, a second port should be created
    const countBefore = FailingSerialPort.instances.length;
    await vi.advanceTimersByTimeAsync(60);
    expect(FailingSerialPort.instances.length).toBeGreaterThan(countBefore);

    await mgr.disconnect();
  });

  it('open failure with userInitiatedStop=true schedules NO retry', async () => {
    FailingSerialPort.instances = [];
    const mgr = makeManager({
      SerialPortImpl: FailingSerialPort,
      backoffLadderMs: [50, 100],
      watchdogTimeoutMs: 0,
    });

    // Simulate user stopping while connect is in flight: call connectSerial directly
    // (bypassing connect() which calls disconnect() and resets userInitiatedStop).
    // This reflects the scenario where disconnect() is called mid-connect.
    (mgr as any).activeMode = 'serial';
    (mgr as any).userInitiatedStop = true;
    await (mgr as any).connectSerial({ port: 'COM3' });

    const countAfterConnect = FailingSerialPort.instances.length;
    expect(countAfterConnect).toBeGreaterThanOrEqual(1);

    // No retry should be scheduled because userInitiatedStop = true
    await vi.advanceTimersByTimeAsync(200);
    expect(FailingSerialPort.instances.length).toBe(countAfterConnect);

    (mgr as any).userInitiatedStop = false;
    await mgr.disconnect();
  });

  it('open failure then retry succeeds → connected state reached', async () => {
    let callCount = 0;
    /** Fails on first call, succeeds on subsequent calls. */
    class FlipSerialPort extends EventEmitter {
      static instances: FlipSerialPort[] = [];
      isOpen = false;
      path: string;
      baudRate: number;

      constructor(opts: { path: string; baudRate: number; parity?: string; autoOpen?: boolean }) {
        super();
        this.path = opts.path;
        this.baudRate = opts.baudRate;
        FlipSerialPort.instances.push(this);
        callCount++;
      }

      open(cb: (err: Error | null) => void): void {
        if (callCount === 1) {
          // First instance fails
          Promise.resolve().then(() => cb(new Error('Port busy')));
        } else {
          this.isOpen = true;
          Promise.resolve().then(() => cb(null));
        }
      }

      close(cb: () => void): void {
        this.isOpen = false;
        Promise.resolve().then(() => cb());
      }
      pipe(_dest: any): this { return this; }
      write(_data: any): void {}
    }

    FlipSerialPort.instances = [];
    callCount = 0;

    const mgr = makeManager({
      SerialPortImpl: FlipSerialPort,
      backoffLadderMs: [50],
      watchdogTimeoutMs: 0,
    });
    const statuses = collectStatuses(mgr);

    // First connect fails
    await mgr.connect({ mode: 'serial', port: 'COM3' });
    expect(statuses).toContain('error');

    // After backoff, second port opens successfully
    await vi.advanceTimersByTimeAsync(60);
    expect(statuses).toContain('connected');

    await mgr.disconnect();
  });
});
