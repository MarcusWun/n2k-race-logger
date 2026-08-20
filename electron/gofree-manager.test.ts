/**
 * Tests for GoFreeManager — GoFree Tier 2 WebSocket JSON parsing.
 *
 * Coverage:
 *   - Channel-ID → PGN mapping (each required channel produces the correct
 *     PGN and store field with correct unit conversion)
 *   - `valid: false` observation is discarded
 *   - Both `Data` and `Many` envelope formats
 *   - TWA/AWA sign normalization (signed → 0–360°)
 *   - Keepalive timer sends `SettingListReq` at 30 s
 *   - Malformed / non-JSON messages are silently skipped
 *   - Integration test against a real `ws` WebSocketServer on 127.0.0.1
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { WebSocketServer } from 'ws';
import { GoFreeManager } from './gofree-manager';
import type { ParsedPGN } from './serial-manager';
import type { GoFreeFreshnessEvent } from './gofree-manager';

// ---------------------------------------------------------------------------
// Constants (kept in sync with gofree-manager.ts)
// ---------------------------------------------------------------------------

const KTS_TO_MS = 1 / 1.94384;
const DEG_TO_RAD = Math.PI / 180;

const PGN_WIND = 130306;
const PGN_STW = 128259;
const PGN_SOG_COG = 129026;
const PGN_POSITION = 129025;
const PGN_HEADING = 127250;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Feed a raw JSON payload directly into the manager's parser (bypasses socket). */
function feedRaw(mgr: GoFreeManager, raw: string): void {
  (mgr as any).handleMessage(raw);
}

/**
 * Minimal EventEmitter-based WebSocket mock used by keepalive / lifecycle
 * tests. Records every `send()` payload so tests can inspect DataReq +
 * keepalive frames without spinning up a real socket.
 */
class MockWebSocket extends EventEmitter {
  static instances: MockWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];

  constructor(public url: string) {
    super();
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', 1000);
  }

  terminate(): void {
    this.readyState = 3;
  }

  simulateOpen(): void {
    this.readyState = 1;
    this.emit('open');
  }

  simulateMessage(data: string): void {
    this.emit('message', data);
  }

  simulateClose(code = 1006): void {
    this.readyState = 3;
    this.emit('close', code);
  }
}

function latest(instances: MockWebSocket[]): MockWebSocket {
  return instances[instances.length - 1];
}

// ---------------------------------------------------------------------------
// Unit tests — channel-ID mapping and message parsing
// ---------------------------------------------------------------------------

describe('GoFreeManager — channel-ID → PGN mapping', () => {
  let manager: GoFreeManager;
  let emitted: ParsedPGN[];

  beforeEach(() => {
    manager = new GoFreeManager();
    emitted = [];
    manager.on('pgn', (pgn: ParsedPGN) => emitted.push(pgn));
  });

  afterEach(() => {
    manager.removeAllListeners();
  });

  it('channel 45 (TWA) → PGN 130306 windAngle (True), radians', () => {
    feedRaw(manager, JSON.stringify({ Data: [{ id: 45, inst: 0, val: 45, valid: true }] }));
    const wind = emitted.find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'True (boat referenced)',
    );
    expect(wind).toBeDefined();
    expect(wind!.fields.windAngle).toBeCloseTo(45 * DEG_TO_RAD, 4);
  });

  it('channel 47 (TWS) → PGN 130306 windSpeed (True), m/s', () => {
    feedRaw(manager, JSON.stringify({ Data: [{ id: 47, val: 12.5, valid: true }] }));
    const wind = emitted.find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'True (boat referenced)',
    );
    expect(wind).toBeDefined();
    expect(wind!.fields.windSpeed).toBeCloseTo(12.5 * KTS_TO_MS, 4);
  });

  it('TWA + TWS pair → combined True wind event with both fields', () => {
    feedRaw(manager, JSON.stringify({
      Data: [
        { id: 47, val: 15, valid: true },
        { id: 45, val: 60, valid: true },
      ],
    }));
    const trueWinds = emitted.filter(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'True (boat referenced)',
    );
    const combined = trueWinds[trueWinds.length - 1];
    expect(combined).toBeDefined();
    expect(combined.fields.windSpeed).toBeCloseTo(15 * KTS_TO_MS, 4);
    expect(combined.fields.windAngle).toBeCloseTo(60 * DEG_TO_RAD, 4);
  });

  it('channel 44 (AWA) → PGN 130306 windAngle (Apparent), radians', () => {
    feedRaw(manager, JSON.stringify({ Data: [{ id: 44, val: 30, valid: true }] }));
    const wind = emitted.find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'Apparent',
    );
    expect(wind).toBeDefined();
    expect(wind!.fields.windAngle).toBeCloseTo(30 * DEG_TO_RAD, 4);
  });

  it('channel 46 (AWS) → PGN 130306 windSpeed (Apparent), m/s', () => {
    feedRaw(manager, JSON.stringify({ Data: [{ id: 46, val: 14, valid: true }] }));
    const wind = emitted.find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'Apparent',
    );
    expect(wind).toBeDefined();
    expect(wind!.fields.windSpeed).toBeCloseTo(14 * KTS_TO_MS, 4);
  });

  it('channel 42 (BSPD) → PGN 128259 speedWaterReferenced, m/s', () => {
    feedRaw(manager, JSON.stringify({ Data: [{ id: 42, val: 6.2, valid: true }] }));
    const stw = emitted.find((p) => p.pgn === PGN_STW);
    expect(stw).toBeDefined();
    expect(stw!.fields.speedWaterReferenced).toBeCloseTo(6.2 * KTS_TO_MS, 4);
  });

  it('channel 41 (SOG) → PGN 129026 sog, m/s', () => {
    feedRaw(manager, JSON.stringify({ Data: [{ id: 41, val: 7.5, valid: true }] }));
    const p = emitted.find((e) => e.pgn === PGN_SOG_COG && e.fields.sog != null);
    expect(p).toBeDefined();
    expect(p!.fields.sog).toBeCloseTo(7.5 * KTS_TO_MS, 4);
  });

  it('channel 9 (COG) → PGN 129026 cog, radians', () => {
    feedRaw(manager, JSON.stringify({ Data: [{ id: 9, val: 84.4, valid: true }] }));
    const p = emitted.find((e) => e.pgn === PGN_SOG_COG && e.fields.cog != null);
    expect(p).toBeDefined();
    expect(p!.fields.cog).toBeCloseTo(84.4 * DEG_TO_RAD, 4);
  });

  it('channel 37 (HDG) → PGN 127250 heading, radians', () => {
    feedRaw(manager, JSON.stringify({ Data: [{ id: 37, val: 355, valid: true }] }));
    const hdg = emitted.find((e) => e.pgn === PGN_HEADING && e.fields.heading != null);
    expect(hdg).toBeDefined();
    expect(hdg!.fields.heading).toBeCloseTo(355 * DEG_TO_RAD, 4);
  });

  it('channel 421 (LAT) → PGN 129025 latitude (decimal degrees passthrough)', () => {
    feedRaw(manager, JSON.stringify({ Data: [{ id: 421, val: 42.5, valid: true }] }));
    const pos = emitted.find((e) => e.pgn === PGN_POSITION && e.fields.latitude != null);
    expect(pos).toBeDefined();
    expect(pos!.fields.latitude).toBeCloseTo(42.5, 6);
  });

  it('channel 422 (LON) → PGN 129025 longitude (decimal degrees passthrough)', () => {
    feedRaw(manager, JSON.stringify({ Data: [{ id: 422, val: -71.0, valid: true }] }));
    const pos = emitted.find((e) => e.pgn === PGN_POSITION && e.fields.longitude != null);
    expect(pos).toBeDefined();
    expect(pos!.fields.longitude).toBeCloseTo(-71, 6);
  });

  it('channel 235 (VMG) → logged as PGN_WIND field, m/s', () => {
    feedRaw(manager, JSON.stringify({ Data: [{ id: 235, val: 5.0, valid: true }] }));
    const p = emitted.find((e) => e.pgn === PGN_WIND && e.fields.vmg != null);
    expect(p).toBeDefined();
    expect(p!.fields.vmg).toBeCloseTo(5 * KTS_TO_MS, 4);
  });

  it('channel 226 (LEE) → logged as PGN_HEADING field, radians', () => {
    feedRaw(manager, JSON.stringify({ Data: [{ id: 226, val: 3, valid: true }] }));
    const p = emitted.find((e) => e.pgn === PGN_HEADING && e.fields.leeway != null);
    expect(p).toBeDefined();
    expect(p!.fields.leeway).toBeCloseTo(3 * DEG_TO_RAD, 4);
  });
});

// ---------------------------------------------------------------------------
// Envelope handling, filtering, normalization
// ---------------------------------------------------------------------------

describe('GoFreeManager — envelope handling and filtering', () => {
  let manager: GoFreeManager;
  let emitted: ParsedPGN[];

  beforeEach(() => {
    manager = new GoFreeManager();
    emitted = [];
    manager.on('pgn', (pgn: ParsedPGN) => emitted.push(pgn));
  });

  afterEach(() => {
    manager.removeAllListeners();
  });

  it('valid:false observation → discarded (no PGN emitted)', () => {
    feedRaw(manager, JSON.stringify({ Data: [{ id: 47, val: 12.5, valid: false }] }));
    expect(emitted).toHaveLength(0);
  });

  it('Data envelope → observations processed in order', () => {
    feedRaw(manager, JSON.stringify({
      Data: [
        { id: 47, val: 10, valid: true },
        { id: 42, val: 5, valid: true },
      ],
    }));
    expect(emitted.find((p) => p.pgn === PGN_WIND && p.fields.windSpeed != null)).toBeDefined();
    expect(emitted.find((p) => p.pgn === PGN_STW)).toBeDefined();
  });

  it('Many envelope → all inner Data blocks processed', () => {
    feedRaw(manager, JSON.stringify({
      Many: [
        { Data: [{ id: 47, val: 10, valid: true }] },
        { Data: [{ id: 42, val: 5, valid: true }] },
        { Data: [{ id: 37, val: 180, valid: true }] },
      ],
    }));
    expect(emitted.find((p) => p.pgn === PGN_WIND && p.fields.windSpeed != null)).toBeDefined();
    expect(emitted.find((p) => p.pgn === PGN_STW)).toBeDefined();
    expect(emitted.find((p) => p.pgn === PGN_HEADING && p.fields.heading != null)).toBeDefined();
  });

  it('TWA normalization: negative signed degrees (port) → 0–360°', () => {
    feedRaw(manager, JSON.stringify({ Data: [{ id: 45, val: -45, valid: true }] }));
    const wind = emitted.find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'True (boat referenced)',
    );
    expect(wind).toBeDefined();
    // -45° → 315°
    expect(wind!.fields.windAngle).toBeCloseTo(315 * DEG_TO_RAD, 4);
  });

  it('AWA normalization: negative signed degrees → 0–360°', () => {
    feedRaw(manager, JSON.stringify({ Data: [{ id: 44, val: -30, valid: true }] }));
    const wind = emitted.find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'Apparent',
    );
    expect(wind).toBeDefined();
    // -30° → 330°
    expect(wind!.fields.windAngle).toBeCloseTo(330 * DEG_TO_RAD, 4);
  });

  it('malformed / non-JSON message → silently skipped, no crash', () => {
    expect(() => feedRaw(manager, 'not-json!')).not.toThrow();
    expect(() => feedRaw(manager, '{bad json')).not.toThrow();
    expect(() => feedRaw(manager, '')).not.toThrow();
    expect(() => feedRaw(manager, 'null')).not.toThrow();
    expect(() => feedRaw(manager, '42')).not.toThrow();
    expect(emitted).toHaveLength(0);
  });

  it('unknown channel id → silently ignored', () => {
    feedRaw(manager, JSON.stringify({ Data: [{ id: 99999, val: 1.0, valid: true }] }));
    expect(emitted).toHaveLength(0);
  });

  it('observation missing val → discarded (no PGN emitted)', () => {
    feedRaw(manager, JSON.stringify({ Data: [{ id: 47, valid: true }] }));
    expect(emitted).toHaveLength(0);
  });

  it('observation with valStr string → parsed as number (H5000 sends strings)', () => {
    feedRaw(manager, JSON.stringify({ Data: [{ id: 47, valStr: '12.5', valid: true }] }));
    const wind = emitted.find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'True (boat referenced)',
    );
    expect(wind).toBeDefined();
    expect(wind!.fields.windSpeed).toBeCloseTo(12.5 * KTS_TO_MS, 4);
  });

  it('observation with scientific-notation valStr → parsed correctly', () => {
    feedRaw(manager, JSON.stringify({ Data: [{ id: 421, valStr: '4.25e+01', valid: true }] }));
    const pos = emitted.find((p) => p.pgn === PGN_POSITION && p.fields.latitude != null);
    expect(pos).toBeDefined();
    expect(pos!.fields.latitude).toBeCloseTo(42.5, 4);
  });

  it('observation with both val and valStr → val takes precedence', () => {
    feedRaw(manager, JSON.stringify({ Data: [{ id: 42, val: 6.0, valStr: '99.0', valid: true }] }));
    const stw = emitted.find((p) => p.pgn === PGN_STW);
    expect(stw).toBeDefined();
    expect(stw!.fields.speedWaterReferenced).toBeCloseTo(6.0 * KTS_TO_MS, 4);
  });

  it('non-Data / non-Many payload (e.g. SettingListRsp) → silently ignored', () => {
    feedRaw(manager, JSON.stringify({ SettingListRsp: [{ groupId: 2, values: [] }] }));
    expect(emitted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Keepalive & subscribe (via injected MockWebSocket)
// ---------------------------------------------------------------------------

describe('GoFreeManager — subscribe + keepalive', () => {
  beforeEach(() => {
    MockWebSocket.instances.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    MockWebSocket.instances.length = 0;
  });

  it('on DataList: sends immediate poll (repeat:false) for required channels present in DataList', async () => {
    const mgr = new GoFreeManager({ WebSocketImpl: MockWebSocket as any });
    await mgr.connect('127.0.0.1', 2053);

    const ws = latest(MockWebSocket.instances);
    expect(ws).toBeDefined();
    ws.simulateOpen();

    // Step 1: DataListReq sent immediately on open
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]).DataListReq).toMatchObject({ group: 40 });

    // H5000 responds with DataList containing all 12 required channels
    const allIds = [9, 37, 41, 42, 44, 45, 46, 47, 226, 235, 421, 422];
    ws.simulateMessage(JSON.stringify({ DataList: { groupId: 40, list: allIds } }));

    // Immediate poll: one DataReq message per channel (12 total), repeat:false
    expect(ws.sent).toHaveLength(13); // 1 DataListReq + 12 individual DataReq messages
    const pollIds = ws.sent.slice(1).map((s: string) => {
      const msg = JSON.parse(s);
      expect(msg.DataReq).toHaveLength(1);
      expect(msg.DataReq[0].repeat).toBe(false);
      expect(msg.DataReq[0].inst).toBe(0);
      return msg.DataReq[0].id;
    }).sort((a: number, b: number) => a - b);
    expect(pollIds).toEqual(allIds.slice().sort((a, b) => a - b));

    await mgr.disconnect();
  });

  it('polls all required channels even when DataList omits some', async () => {
    const mgr = new GoFreeManager({ WebSocketImpl: MockWebSocket as any });
    await mgr.connect('127.0.0.1', 2053);

    const ws = latest(MockWebSocket.instances);
    ws.simulateOpen();
    expect(ws.sent).toHaveLength(1);

    // DataList missing LAT/LON (421, 422) and TWA/AWA (45, 44) — as seen on
    // the H5000 firmware in boat testing. We must poll all 12 regardless.
    const partialIds = [9, 37, 41, 42, 44, 45, 46, 47, 226, 235];
    ws.simulateMessage(JSON.stringify({ DataList: { groupId: 40, list: partialIds } }));

    // All 12 required channels must be polled (not just the 10 in DataList)
    expect(ws.sent).toHaveLength(13); // 1 DataListReq + 12 individual DataReq messages
    const pollIds = ws.sent.slice(1).map((s: string) => {
      const msg = JSON.parse(s);
      expect(msg.DataReq).toHaveLength(1);
      return msg.DataReq[0].id;
    }).sort((a: number, b: number) => a - b);
    expect(pollIds).toEqual([9, 37, 41, 42, 44, 45, 46, 47, 226, 235, 421, 422]);
    // 421 and 422 are included even though absent from DataList
    expect(pollIds).toContain(421);
    expect(pollIds).toContain(422);

    await mgr.disconnect();
  });

  it('polls at pollIntervalMs after the initial DataList poll', async () => {
    vi.useFakeTimers();
    const mgr = new GoFreeManager({
      pollIntervalMs: 1_000,
      WebSocketImpl: MockWebSocket as any,
    });
    await mgr.connect('127.0.0.1', 2053);

    const ws = latest(MockWebSocket.instances);
    ws.simulateOpen();

    const allIds = [9, 37, 41, 42, 44, 45, 46, 47, 226, 235, 421, 422];
    ws.simulateMessage(JSON.stringify({ DataList: { groupId: 40, list: allIds } }));

    // msg 0: DataListReq, msgs 1–12: immediate poll (one DataReq per channel)
    expect(ws.sent).toHaveLength(13);

    // +1 s → second poll (12 more individual DataReq messages)
    vi.advanceTimersByTime(1_000);
    expect(ws.sent).toHaveLength(25);
    expect(JSON.parse(ws.sent[13]).DataReq[0].repeat).toBe(false);

    // +1 s → third poll (12 more individual DataReq messages)
    vi.advanceTimersByTime(1_000);
    expect(ws.sent).toHaveLength(37);

    await mgr.disconnect();
  });

  it('falls back to polling required channels if DataList never arrives', async () => {
    vi.useFakeTimers();
    const mgr = new GoFreeManager({
      pollIntervalMs: 1_000,
      WebSocketImpl: MockWebSocket as any,
    });
    await mgr.connect('127.0.0.1', 2053);

    const ws = latest(MockWebSocket.instances);
    ws.simulateOpen();

    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]).DataListReq).toBeDefined();

    // Advance past discovery timeout (3 s) — fallback polls all 12 required channels individually
    vi.advanceTimersByTime(3_000);
    // 1 DataListReq + 12 individual DataReq messages
    expect(ws.sent).toHaveLength(13);
    const ids = ws.sent.slice(1).map((s: string) => {
      const msg = JSON.parse(s);
      expect(msg.DataReq).toHaveLength(1);
      expect(msg.DataReq[0].repeat).toBe(false);
      return msg.DataReq[0].id;
    }).sort((a: number, b: number) => a - b);
    expect(ids).toEqual([9, 37, 41, 42, 44, 45, 46, 47, 226, 235, 421, 422]);

    // +1 s → second poll tick (12 more individual DataReq messages)
    vi.advanceTimersByTime(1_000);
    expect(ws.sent).toHaveLength(25);

    await mgr.disconnect();
  });

  it('keepalive: sends SettingListReq every 30 s after DataReq is sent', async () => {
    vi.useFakeTimers();
    const mgr = new GoFreeManager({
      keepaliveIntervalMs: 30_000,
      WebSocketImpl: MockWebSocket as any,
    });
    await mgr.connect('127.0.0.1', 2053);

    const ws = latest(MockWebSocket.instances);
    ws.simulateOpen();

    // Message 0: DataListReq (discovery)
    expect(ws.sent).toHaveLength(1);

    // +3 s → discovery timeout → poll fires (12 individual DataReq messages)
    vi.advanceTimersByTime(3_000);
    expect(ws.sent).toHaveLength(13); // DataListReq + 12 individual poll messages
    expect(JSON.parse(ws.sent[1]).DataReq).toBeDefined();

    // +1 s → second poll tick (12 more individual DataReq messages)
    vi.advanceTimersByTime(1_000);
    expect(ws.sent).toHaveLength(25);

    // +30 s → first keepalive (after the 30 s keepalive interval from connection)
    vi.advanceTimersByTime(29_000); // total = 33s from open; keepalive fires at 30s
    const countBeforeKeepalive = ws.sent.length;
    // keepalive fires; poll may also fire — just check the last message is SettingListReq
    expect(ws.sent.some((s: string) => {
      try { return JSON.parse(s).SettingListReq != null; } catch { return false; }
    })).toBe(true);

    await mgr.disconnect();
  });

  it('disconnect() stops keepalive, poll, and discovery timers', async () => {
    vi.useFakeTimers();
    const mgr = new GoFreeManager({
      keepaliveIntervalMs: 30_000,
      pollIntervalMs: 1_000,
      WebSocketImpl: MockWebSocket as any,
    });
    await mgr.connect('127.0.0.1', 2053);
    const ws = latest(MockWebSocket.instances);
    ws.simulateOpen();

    expect(ws.sent).toHaveLength(1);

    await mgr.disconnect();

    // Advance well past all intervals — no additional sends
    vi.advanceTimersByTime(120_000);
    expect(ws.sent).toHaveLength(1);
  });

  it('emits gofree:status events for connecting → connected → disconnected', async () => {
    const mgr = new GoFreeManager({ WebSocketImpl: MockWebSocket as any });
    const states: string[] = [];
    mgr.on('gofree:status', (s: any) => states.push(s.state));

    await mgr.connect('127.0.0.1', 2053);
    const ws = latest(MockWebSocket.instances);
    ws.simulateOpen();
    await mgr.disconnect();

    expect(states).toContain('connecting');
    expect(states).toContain('connected');
    expect(states[states.length - 1]).toBe('disconnected');
  });
});

// ---------------------------------------------------------------------------
// Integration test — real WebSocket server via `ws`
// ---------------------------------------------------------------------------

describe('GoFreeManager — integration (real WebSocket server)', () => {
  it('connects, subscribes, and emits PGN events for a streamed Data message', async () => {
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as any).port;

    let subscribeReceived: any = null;

    server.on('connection', (socket) => {
      socket.on('message', (data: any) => {
        let msg: any;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return;
        }
        // Step 1: respond to DataListReq with available channel IDs
        if (msg?.DataListReq != null) {
          socket.send(JSON.stringify({
            DataList: { groupId: 40, list: [9, 37, 41, 42, 44, 45, 46, 47, 226, 235, 421, 422] },
          }));
          return;
        }
        // Step 2: respond to DataReq (repeat:false poll) with current data
        if (msg?.DataReq && !subscribeReceived) {
          subscribeReceived = msg;
          // Reply with a Data envelope covering the required channel IDs
          socket.send(JSON.stringify({
            Data: [
              { id: 45, inst: 0, val: 55, valid: true },
              { id: 47, inst: 0, val: 12, valid: true },
              { id: 42, inst: 0, val: 6.0, valid: true },
              { id: 41, inst: 0, val: 7.5, valid: true },
              { id: 9, inst: 0, val: 80, valid: true },
              { id: 37, inst: 0, val: 90, valid: true },
              { id: 421, inst: 0, val: 42.0, valid: true },
              { id: 422, inst: 0, val: -71.0, valid: true },
              { id: 44, inst: 0, val: 30, valid: true },
              { id: 46, inst: 0, val: 14, valid: true },
            ],
          }));
          // Then a Many envelope with an additional STW update
          socket.send(JSON.stringify({
            Many: [{ Data: [{ id: 42, val: 6.4, valid: true }] }],
          }));
        }
      });
    });

    const mgr = new GoFreeManager();
    const received: ParsedPGN[] = [];
    mgr.on('pgn', (p: ParsedPGN) => received.push(p));

    await mgr.connect('127.0.0.1', port);

    // Wait for the server-side reply to be processed
    await new Promise<void>((resolve) => setTimeout(resolve, 250));

    expect(subscribeReceived).not.toBeNull();
    expect(Array.isArray(subscribeReceived.DataReq)).toBe(true);

    expect(received.find((p) => p.pgn === PGN_STW && p.fields.speedWaterReferenced != null)).toBeDefined();
    expect(received.find((p) => p.pgn === PGN_SOG_COG && p.fields.sog != null)).toBeDefined();
    expect(received.find((p) => p.pgn === PGN_SOG_COG && p.fields.cog != null)).toBeDefined();
    expect(received.find((p) => p.pgn === PGN_HEADING && p.fields.heading != null)).toBeDefined();
    expect(received.find((p) => p.pgn === PGN_POSITION && p.fields.latitude != null)).toBeDefined();
    expect(received.find((p) => p.pgn === PGN_POSITION && p.fields.longitude != null)).toBeDefined();
    expect(received.find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'True (boat referenced)',
    )).toBeDefined();
    expect(received.find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'Apparent',
    )).toBeDefined();

    // Verify a specific value's unit conversion end-to-end
    const stw = received.find((p) => p.pgn === PGN_STW);
    expect(stw!.fields.speedWaterReferenced).toBeCloseTo(6.0 * KTS_TO_MS, 3);

    await mgr.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

// ---------------------------------------------------------------------------
// BE1: Unexpected disconnect timer cleanup
// ---------------------------------------------------------------------------

describe('GoFreeManager — BE1: unexpected disconnect timer cleanup', () => {
  beforeEach(() => {
    MockWebSocket.instances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    MockWebSocket.instances.length = 0;
  });

  it('unexpected close during discovery: discovery timer cleared, no sends on closed socket', async () => {
    const mgr = new GoFreeManager({
      pollIntervalMs: 1_000,
      reconnectIntervalMs: 10_000, // long reconnect so ws2 never opens in this test
      keepaliveIntervalMs: 30_000,
      maxReconnectAttempts: 10,
      watchdogTimeoutMs: 5_000,
      WebSocketImpl: MockWebSocket as any,
    });
    await mgr.connect('127.0.0.1', 2053);
    const ws1 = latest(MockWebSocket.instances);
    ws1.simulateOpen();

    // Discovery is pending — discoveryTimer is active, no DataList received
    expect(ws1.sent).toHaveLength(1); // just DataListReq
    const sentAtOpen = ws1.sent.length;

    // Unexpected close before discovery completes
    ws1.simulateClose(1006);

    // Advance past the discovery timeout (3 s) and well past the keepalive interval
    // but BEFORE the 10 s reconnect timer fires (so state stays 'reconnecting').
    // If the discoveryTimer were not cleared, subscribeAll/sendPoll would fire at 3 s.
    vi.advanceTimersByTime(8_000);

    // ws1 must receive NO additional sends after the unexpected close
    expect(ws1.sent.length).toBe(sentAtOpen);
    expect(mgr.getStatus().state).toBe('reconnecting');

    await mgr.disconnect();
  });

  it('unexpected close during active polling: poll timer cleared, no sends on closed socket', async () => {
    const mgr = new GoFreeManager({
      pollIntervalMs: 500,
      reconnectIntervalMs: 10_000,
      keepaliveIntervalMs: 30_000,
      maxReconnectAttempts: 10,
      watchdogTimeoutMs: 5_000,
      WebSocketImpl: MockWebSocket as any,
    });
    await mgr.connect('127.0.0.1', 2053);
    const ws1 = latest(MockWebSocket.instances);
    ws1.simulateOpen();

    // Complete discovery and start polling
    const allIds = [9, 37, 41, 42, 44, 45, 46, 47, 226, 235, 421, 422];
    ws1.simulateMessage(JSON.stringify({ DataList: { groupId: 40, list: allIds } }));
    // 1 DataListReq + 12 immediate DataReq = 13
    expect(ws1.sent).toHaveLength(13);
    const sentAtDiscovery = ws1.sent.length;

    // Unexpected close while polling is active
    ws1.simulateClose(1006);

    // Advance past poll interval (500 ms) multiple times — poll timer must not fire
    vi.advanceTimersByTime(3_000);

    // ws1 gets zero additional sends after the close
    expect(ws1.sent.length).toBe(sentAtDiscovery);
    expect(mgr.getStatus().state).toBe('reconnecting');

    await mgr.disconnect();
  });

  it('reconnect after active polling: new socket gets fresh discovery, old socket gets nothing', async () => {
    const mgr = new GoFreeManager({
      pollIntervalMs: 1_000,
      reconnectIntervalMs: 200,
      keepaliveIntervalMs: 30_000,
      maxReconnectAttempts: 10,
      watchdogTimeoutMs: 5_000,
      WebSocketImpl: MockWebSocket as any,
    });
    await mgr.connect('127.0.0.1', 2053);
    const ws1 = latest(MockWebSocket.instances);
    ws1.simulateOpen();

    // Complete discovery on ws1
    const allIds = [9, 37, 41, 42, 44, 45, 46, 47, 226, 235, 421, 422];
    ws1.simulateMessage(JSON.stringify({ DataList: { groupId: 40, list: allIds } }));
    expect(ws1.sent).toHaveLength(13);
    const sentAtClose = ws1.sent.length;

    // Unexpected close
    ws1.simulateClose(1006);

    // Trigger reconnect (200 ms) + open new socket
    vi.advanceTimersByTime(300);
    const ws2 = latest(MockWebSocket.instances);
    expect(ws2).not.toBe(ws1);
    ws2.simulateOpen();

    // ws2 must start fresh discovery (DataListReq)
    expect(ws2.sent.length).toBeGreaterThan(0);
    expect(JSON.parse(ws2.sent[0]).DataListReq).toBeDefined();

    // ws1 gets nothing new after its close
    expect(ws1.sent.length).toBe(sentAtClose);

    await mgr.disconnect();
  });

  it('old timers cannot fire against a reconnected socket (fake-clock regression)', async () => {
    // Concrete regression: advance clock across close → reconnect and verify
    // that no callback fires against the new socket from old timer registrations.
    const mgr = new GoFreeManager({
      pollIntervalMs: 500,
      reconnectIntervalMs: 100,
      keepaliveIntervalMs: 30_000,
      maxReconnectAttempts: 10,
      watchdogTimeoutMs: 5_000,
      WebSocketImpl: MockWebSocket as any,
    });
    await mgr.connect('127.0.0.1', 2053);
    const ws1 = latest(MockWebSocket.instances);
    ws1.simulateOpen();

    // Complete discovery so pollTimer and keepaliveTimer are both active
    const allIds = [9, 37, 41, 42, 44, 45, 46, 47, 226, 235, 421, 422];
    ws1.simulateMessage(JSON.stringify({ DataList: { groupId: 40, list: allIds } }));
    const sentAtClose = ws1.sent.length;

    // Unexpected close — all old timers must be cleared before reconnect
    ws1.simulateClose(1006);

    // Jump clock: 100 ms triggers reconnect → ws2 opens
    vi.advanceTimersByTime(100);
    const ws2 = latest(MockWebSocket.instances);
    expect(ws2).not.toBe(ws1);
    ws2.simulateOpen();

    // Advance clock far beyond old poll interval and keepalive interval
    vi.advanceTimersByTime(60_000);

    // ws1 must have received zero sends after its close; all sends are ws2's own
    expect(ws1.sent.length).toBe(sentAtClose);

    await mgr.disconnect();
  });
});

// ---------------------------------------------------------------------------
// BE2: Data freshness watchdog
// ---------------------------------------------------------------------------

describe('GoFreeManager — BE2: data freshness watchdog', () => {
  beforeEach(() => {
    MockWebSocket.instances.length = 0;
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    MockWebSocket.instances.length = 0;
  });

  it('open-but-nonresponsive H5000: watchdog transitions state to stale after timeout', async () => {
    const mgr = new GoFreeManager({
      watchdogTimeoutMs: 3_000,
      pollIntervalMs: 1_000,
      maxReconnectAttempts: 10,
      WebSocketImpl: MockWebSocket as any,
    });
    const states: string[] = [];
    mgr.on('gofree:status', (s: any) => states.push(s.state));

    await mgr.connect('127.0.0.1', 2053);
    const ws = latest(MockWebSocket.instances);
    ws.simulateOpen(); // state → connected

    expect(mgr.getStatus().state).toBe('connected');

    // 3 s with no valid data → watchdog fires
    vi.advanceTimersByTime(3_000);

    expect(mgr.getStatus().state).toBe('stale');
    expect(states).toContain('stale');

    await mgr.disconnect();
  });

  it('valid data within watchdog window prevents stale transition', async () => {
    const mgr = new GoFreeManager({
      watchdogTimeoutMs: 3_000,
      pollIntervalMs: 1_000,
      maxReconnectAttempts: 10,
      WebSocketImpl: MockWebSocket as any,
    });
    const states: string[] = [];
    mgr.on('gofree:status', (s: any) => states.push(s.state));

    await mgr.connect('127.0.0.1', 2053);
    const ws = latest(MockWebSocket.instances);
    ws.simulateOpen();

    // Feed valid data at 2 s (within 3 s window) — watchdog should reset
    vi.advanceTimersByTime(2_000);
    ws.simulateMessage(JSON.stringify({ Data: [{ id: 42, val: 6, valid: true }] }));

    // Advance another 2 s (total 4 s, but watchdog restarted at t=2 s)
    vi.advanceTimersByTime(2_000);

    // Not yet 3 s since last data (only 2 s), so still connected
    expect(mgr.getStatus().state).toBe('connected');
    expect(states).not.toContain('stale');

    await mgr.disconnect();
  });

  it('valid data after stale restores connected state', async () => {
    const mgr = new GoFreeManager({
      watchdogTimeoutMs: 2_000,
      pollIntervalMs: 1_000,
      maxReconnectAttempts: 10,
      WebSocketImpl: MockWebSocket as any,
    });
    const states: string[] = [];
    mgr.on('gofree:status', (s: any) => states.push(s.state));

    await mgr.connect('127.0.0.1', 2053);
    const ws = latest(MockWebSocket.instances);
    ws.simulateOpen();

    // Trigger stale
    vi.advanceTimersByTime(2_000);
    expect(mgr.getStatus().state).toBe('stale');

    // Feed valid data → should flip back to connected
    ws.simulateMessage(JSON.stringify({ Data: [{ id: 42, val: 6, valid: true }] }));
    expect(mgr.getStatus().state).toBe('connected');
    expect(states.filter((s) => s === 'connected').length).toBeGreaterThanOrEqual(2);

    await mgr.disconnect();
  });

  it('watchdog timer is cleared by resetForReconnect on unexpected disconnect', async () => {
    const mgr = new GoFreeManager({
      watchdogTimeoutMs: 3_000,
      pollIntervalMs: 1_000,
      reconnectIntervalMs: 10_000,
      maxReconnectAttempts: 10,
      WebSocketImpl: MockWebSocket as any,
    });
    const states: string[] = [];
    mgr.on('gofree:status', (s: any) => states.push(s.state));

    await mgr.connect('127.0.0.1', 2053);
    const ws = latest(MockWebSocket.instances);
    ws.simulateOpen();

    // Close unexpectedly — watchdog timer must be cleared
    ws.simulateClose(1006);
    const statesAfterClose = [...states];

    // Advance past watchdog timeout — must NOT see 'stale' since timer was cleared
    vi.advanceTimersByTime(5_000);

    const statesAfterAdvance = states.filter((s) => s === 'stale');
    expect(statesAfterAdvance.length).toBe(0);

    await mgr.disconnect();
  });

  it('gofree:freshness: emits stale channels when values not seen within 2x pollInterval', async () => {
    const mgr = new GoFreeManager({
      pollIntervalMs: 500,
      watchdogTimeoutMs: 10_000,
      maxReconnectAttempts: 10,
      WebSocketImpl: MockWebSocket as any,
    });
    const freshnessEvents: GoFreeFreshnessEvent[] = [];
    mgr.on('gofree:freshness', (e: GoFreeFreshnessEvent) => freshnessEvents.push(e));

    await mgr.connect('127.0.0.1', 2053);
    const ws = latest(MockWebSocket.instances);
    ws.simulateOpen();

    // Complete discovery
    const allIds = [9, 37, 41, 42, 44, 45, 46, 47, 226, 235, 421, 422];
    ws.simulateMessage(JSON.stringify({ DataList: { groupId: 40, list: allIds } }));

    // Send data for BSPD (ch42) only
    ws.simulateMessage(JSON.stringify({ Data: [{ id: 42, val: 6, valid: true }] }));

    // Advance past 2x pollInterval (1000 ms) — poll tick fires, emits freshness
    vi.advanceTimersByTime(1_100);

    expect(freshnessEvents.length).toBeGreaterThan(0);
    const last = freshnessEvents[freshnessEvents.length - 1];
    // TWA and TWS not seen → stale
    expect(last.staleChannels).toContain(45); // CH_TWA
    expect(last.staleChannels).toContain(47); // CH_TWS
    // BSPD was seen recently (within 2x 500ms = 1000ms) — NOT stale
    expect(last.staleChannels).not.toContain(42); // CH_BSPD

    await mgr.disconnect();
  });

  it('gofree:freshness: channel becomes fresh once observed, stale after 2x pollInterval', async () => {
    const mgr = new GoFreeManager({
      pollIntervalMs: 500,
      watchdogTimeoutMs: 10_000,
      maxReconnectAttempts: 10,
      WebSocketImpl: MockWebSocket as any,
    });
    const freshnessEvents: GoFreeFreshnessEvent[] = [];
    mgr.on('gofree:freshness', (e: GoFreeFreshnessEvent) => freshnessEvents.push(e));

    await mgr.connect('127.0.0.1', 2053);
    const ws = latest(MockWebSocket.instances);
    ws.simulateOpen();

    const allIds = [9, 37, 41, 42, 44, 45, 46, 47, 226, 235, 421, 422];
    ws.simulateMessage(JSON.stringify({ DataList: { groupId: 40, list: allIds } }));

    // Feed TWS — fresh
    ws.simulateMessage(JSON.stringify({ Data: [{ id: 47, val: 12, valid: true }] }));

    // First poll tick — TWS should be fresh, others stale
    vi.advanceTimersByTime(600);
    const afterFirst = freshnessEvents[freshnessEvents.length - 1];
    expect(afterFirst.staleChannels).not.toContain(47); // CH_TWS — just seen

    // Advance another 1000ms (total 1600ms since TWS was seen, > 2x 500ms = 1000ms)
    vi.advanceTimersByTime(1_000);
    const afterSecond = freshnessEvents[freshnessEvents.length - 1];
    expect(afterSecond.staleChannels).toContain(47); // CH_TWS — now stale

    await mgr.disconnect();
  });
});

// ---------------------------------------------------------------------------
// BE3: Stale wind pairing prevention
// ---------------------------------------------------------------------------

describe('GoFreeManager — BE3: stale wind pairing prevention', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fresh TWA + fresh TWS: both fields present in PGN 130306', () => {
    // No fake timers needed — both arrive in the same synchronous call, ts gap ≈ 0
    const mgr = new GoFreeManager();
    const emitted: ParsedPGN[] = [];
    mgr.on('pgn', (p: ParsedPGN) => emitted.push(p));

    feedRaw(mgr, JSON.stringify({
      Data: [
        { id: 47, val: 15, valid: true }, // TWS first
        { id: 45, val: 60, valid: true }, // TWA second — sees fresh TWS
      ],
    }));

    const combined = [...emitted].reverse().find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'True (boat referenced)',
    );
    expect(combined).toBeDefined();
    expect(combined!.fields.windSpeed).toBeCloseTo(15 * KTS_TO_MS, 4);
    expect(combined!.fields.windAngle).toBeCloseTo(60 * DEG_TO_RAD, 4);
  });

  it('stale TWS (>1500 ms old): fresh TWA emits PGN 130306 with windAngle only (no windSpeed)', async () => {
    vi.useFakeTimers();
    const mgr = new GoFreeManager();
    const emitted: ParsedPGN[] = [];
    mgr.on('pgn', (p: ParsedPGN) => emitted.push(p));

    // Feed TWS at t=0
    feedRaw(mgr, JSON.stringify({ Data: [{ id: 47, val: 12, valid: true }] }));

    // Advance past MAX_WIND_PAIRING_AGE_MS (1500 ms)
    vi.advanceTimersByTime(2_000);

    // Feed fresh TWA — TWS is now 2000 ms old, beyond the 1500 ms window
    feedRaw(mgr, JSON.stringify({ Data: [{ id: 45, val: 45, valid: true }] }));

    const lastTrue = [...emitted].reverse().find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'True (boat referenced)',
    );
    expect(lastTrue).toBeDefined();
    expect(lastTrue!.fields.windAngle).toBeDefined();
    expect(lastTrue!.fields.windSpeed).toBeUndefined(); // stale companion excluded
  });

  it('stale TWA (>1500 ms old): fresh TWS emits PGN 130306 with windSpeed only (no windAngle)', async () => {
    vi.useFakeTimers();
    const mgr = new GoFreeManager();
    const emitted: ParsedPGN[] = [];
    mgr.on('pgn', (p: ParsedPGN) => emitted.push(p));

    // Feed TWA at t=0
    feedRaw(mgr, JSON.stringify({ Data: [{ id: 45, val: 45, valid: true }] }));

    // Advance past pairing age
    vi.advanceTimersByTime(2_000);

    // Feed fresh TWS — TWA is stale
    feedRaw(mgr, JSON.stringify({ Data: [{ id: 47, val: 12, valid: true }] }));

    const lastTrue = [...emitted].reverse().find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'True (boat referenced)',
    );
    expect(lastTrue).toBeDefined();
    expect(lastTrue!.fields.windSpeed).toBeDefined();
    expect(lastTrue!.fields.windAngle).toBeUndefined(); // stale companion excluded
  });

  it('stale AWS (>1500 ms old): fresh AWA emits PGN 130306 with windAngle only (Apparent)', async () => {
    vi.useFakeTimers();
    const mgr = new GoFreeManager();
    const emitted: ParsedPGN[] = [];
    mgr.on('pgn', (p: ParsedPGN) => emitted.push(p));

    // Feed AWS at t=0
    feedRaw(mgr, JSON.stringify({ Data: [{ id: 46, val: 14, valid: true }] }));

    // Advance past pairing age
    vi.advanceTimersByTime(2_000);

    // Feed fresh AWA
    feedRaw(mgr, JSON.stringify({ Data: [{ id: 44, val: 30, valid: true }] }));

    const lastApparent = [...emitted].reverse().find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'Apparent',
    );
    expect(lastApparent).toBeDefined();
    expect(lastApparent!.fields.windAngle).toBeDefined();
    expect(lastApparent!.fields.windSpeed).toBeUndefined(); // stale companion excluded
  });

  it('stale AWA (>1500 ms old): fresh AWS emits PGN 130306 with windSpeed only (Apparent)', async () => {
    vi.useFakeTimers();
    const mgr = new GoFreeManager();
    const emitted: ParsedPGN[] = [];
    mgr.on('pgn', (p: ParsedPGN) => emitted.push(p));

    // Feed AWA at t=0
    feedRaw(mgr, JSON.stringify({ Data: [{ id: 44, val: 30, valid: true }] }));

    // Advance past pairing age
    vi.advanceTimersByTime(2_000);

    // Feed fresh AWS
    feedRaw(mgr, JSON.stringify({ Data: [{ id: 46, val: 14, valid: true }] }));

    const lastApparent = [...emitted].reverse().find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'Apparent',
    );
    expect(lastApparent).toBeDefined();
    expect(lastApparent!.fields.windSpeed).toBeDefined();
    expect(lastApparent!.fields.windAngle).toBeUndefined(); // stale companion excluded
  });

  it('companion exactly at MAX_WIND_PAIRING_AGE_MS boundary is included (<=, not <)', async () => {
    vi.useFakeTimers();
    const mgr = new GoFreeManager();
    const emitted: ParsedPGN[] = [];
    mgr.on('pgn', (p: ParsedPGN) => emitted.push(p));

    // Feed TWS at t=0
    feedRaw(mgr, JSON.stringify({ Data: [{ id: 47, val: 10, valid: true }] }));

    // Advance exactly to the boundary (1500 ms)
    vi.advanceTimersByTime(1_500);

    // Feed TWA — companion is exactly 1500 ms old → should be included
    feedRaw(mgr, JSON.stringify({ Data: [{ id: 45, val: 30, valid: true }] }));

    const lastTrue = [...emitted].reverse().find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'True (boat referenced)',
    );
    expect(lastTrue).toBeDefined();
    expect(lastTrue!.fields.windSpeed).toBeDefined(); // at boundary, still included
    expect(lastTrue!.fields.windAngle).toBeDefined();
  });

  it('wind pairing state is reset on unexpected disconnect (no stale pairs across reconnects)', async () => {
    vi.useFakeTimers();
    const mgr = new GoFreeManager({
      reconnectIntervalMs: 100,
      maxReconnectAttempts: 10,
      watchdogTimeoutMs: 5_000,
      WebSocketImpl: MockWebSocket as any,
    });
    MockWebSocket.instances.length = 0;
    const emitted: ParsedPGN[] = [];
    mgr.on('pgn', (p: ParsedPGN) => emitted.push(p));

    await mgr.connect('127.0.0.1', 2053);
    const ws1 = latest(MockWebSocket.instances);
    ws1.simulateOpen();

    // Feed TWS on first connection
    ws1.simulateMessage(JSON.stringify({ Data: [{ id: 47, val: 20, valid: true }] }));

    // Disconnect unexpectedly — pairing state must be cleared
    ws1.simulateClose(1006);

    // Reconnect
    vi.advanceTimersByTime(200);
    const ws2 = latest(MockWebSocket.instances);
    expect(ws2).not.toBe(ws1);
    ws2.simulateOpen();

    // Feed TWA on the new connection — TWS from the previous connection must NOT pair
    ws2.simulateMessage(JSON.stringify({ Data: [{ id: 45, val: 45, valid: true }] }));

    const lastTrue = [...emitted].reverse().find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'True (boat referenced)',
    );
    expect(lastTrue).toBeDefined();
    expect(lastTrue!.fields.windAngle).toBeDefined();
    expect(lastTrue!.fields.windSpeed).toBeUndefined(); // pre-disconnect TWS must NOT appear

    await mgr.disconnect();
    MockWebSocket.instances.length = 0;
  });
});
