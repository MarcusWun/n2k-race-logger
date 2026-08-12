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

  it('channel 141 (TWA) → PGN 130306 windAngle (True), radians', () => {
    feedRaw(manager, JSON.stringify({ Data: [{ id: 141, inst: 0, val: 45, valid: true }] }));
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
        { id: 141, val: 60, valid: true },
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

  it('channel 140 (AWA) → PGN 130306 windAngle (Apparent), radians', () => {
    feedRaw(manager, JSON.stringify({ Data: [{ id: 140, val: 30, valid: true }] }));
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
    feedRaw(manager, JSON.stringify({ Data: [{ id: 141, val: -45, valid: true }] }));
    const wind = emitted.find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'True (boat referenced)',
    );
    expect(wind).toBeDefined();
    // -45° → 315°
    expect(wind!.fields.windAngle).toBeCloseTo(315 * DEG_TO_RAD, 4);
  });

  it('AWA normalization: negative signed degrees → 0–360°', () => {
    feedRaw(manager, JSON.stringify({ Data: [{ id: 140, val: -30, valid: true }] }));
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

  it('3-step handshake: DataListReq → DataList → DataInfoReq → DataInfo → DataReq', async () => {
    const mgr = new GoFreeManager({ WebSocketImpl: MockWebSocket as any });
    await mgr.connect('127.0.0.1', 2053);

    const ws = latest(MockWebSocket.instances);
    expect(ws).toBeDefined();
    ws.simulateOpen();

    // Step 1: DataListReq sent immediately on open
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]).DataListReq).toMatchObject({ group: 40 });

    // H5000 responds with DataList containing all 12 required channels
    const allIds = [9, 37, 41, 42, 46, 47, 140, 141, 226, 235, 421, 422];
    ws.simulateMessage(JSON.stringify({ DataList: { groupId: 40, list: allIds } }));

    // Step 2: DataInfoReq sent immediately for the 12 required channels
    expect(ws.sent).toHaveLength(2);
    const dataInfoReq = JSON.parse(ws.sent[1]);
    expect(Array.isArray(dataInfoReq.DataInfoReq)).toBe(true);
    const infoIds = dataInfoReq.DataInfoReq.slice().sort((a: number, b: number) => a - b);
    expect(infoIds).toEqual(allIds.slice().sort((a, b) => a - b));

    // H5000 responds with DataInfo for all channels (simple, no inst override → inst:0)
    const dataInfoPayload = {
      DataInfo: allIds.map((id) => ({ id, sname: `ch${id}`, numInstances: 1 })),
    };
    ws.simulateMessage(JSON.stringify(dataInfoPayload));

    // Step 3: DataReq sent immediately (all DataInfo received — no timeout needed)
    expect(ws.sent).toHaveLength(3);
    const dataReq = JSON.parse(ws.sent[2]);
    expect(Array.isArray(dataReq.DataReq)).toBe(true);
    const sentIds = dataReq.DataReq.map((e: any) => e.id).sort((a: number, b: number) => a - b);
    expect(sentIds).toEqual(allIds.slice().sort((a, b) => a - b));
    for (const entry of dataReq.DataReq) {
      expect(entry.repeat).toBe(true);
      expect(entry.inst).toBe(0); // default when no instanceInfo provided
    }

    await mgr.disconnect();
  });

  it('uses instance numbers from DataInfo when subscribing', async () => {
    const mgr = new GoFreeManager({ WebSocketImpl: MockWebSocket as any });
    await mgr.connect('127.0.0.1', 2053);

    const ws = latest(MockWebSocket.instances);
    ws.simulateOpen();

    // DataList with just TWA (141) and SOG (41)
    ws.simulateMessage(JSON.stringify({ DataList: { groupId: 40, list: [9, 37, 41, 42, 46, 47, 140, 141, 226, 235, 421, 422] } }));
    expect(ws.sent).toHaveLength(2); // DataListReq + DataInfoReq

    // DataInfo says channel 141 (TWA) is on inst:1, channel 41 (SOG) is on inst:0
    ws.simulateMessage(
      JSON.stringify({
        DataInfo: [
          { id: 141, sname: 'TWA', numInstances: 1, instanceInfo: [{ inst: 1, location: 3, str: 'Starboard' }] },
          { id: 47, sname: 'TWS', numInstances: 1, instanceInfo: [{ inst: 0, location: 0, str: 'Port' }] },
          { id: 42, sname: 'BSP', numInstances: 1 },
          { id: 41, sname: 'SOG', numInstances: 1 },
          { id: 9,  sname: 'COG', numInstances: 1 },
          { id: 37, sname: 'HDG', numInstances: 1 },
          { id: 421, sname: 'LAT', numInstances: 1 },
          { id: 422, sname: 'LON', numInstances: 1 },
          { id: 140, sname: 'AWA', numInstances: 1 },
          { id: 46,  sname: 'AWS', numInstances: 1 },
          { id: 235, sname: 'VMG', numInstances: 1 },
          { id: 226, sname: 'LEE', numInstances: 1 },
        ],
      }),
    );

    // DataReq should use inst:1 for ch 141 and inst:0 for the rest
    expect(ws.sent).toHaveLength(3);
    const dataReq = JSON.parse(ws.sent[2]);
    const twaEntry = dataReq.DataReq.find((e: any) => e.id === 141);
    expect(twaEntry?.inst).toBe(1);
    const sogEntry = dataReq.DataReq.find((e: any) => e.id === 41);
    expect(sogEntry?.inst).toBe(0);

    await mgr.disconnect();
  });

  it('falls back to inst:0 for channels where DataInfo never arrives', async () => {
    vi.useFakeTimers();
    const mgr = new GoFreeManager({ WebSocketImpl: MockWebSocket as any });
    await mgr.connect('127.0.0.1', 2053);

    const ws = latest(MockWebSocket.instances);
    ws.simulateOpen();

    const allIds = [9, 37, 41, 42, 46, 47, 140, 141, 226, 235, 421, 422];
    ws.simulateMessage(JSON.stringify({ DataList: { groupId: 40, list: allIds } }));

    // DataInfoReq sent; no DataInfo response arrives — advance past the 3 s timeout
    expect(ws.sent).toHaveLength(2); // DataListReq + DataInfoReq
    vi.advanceTimersByTime(3_000);

    // DataReq sent with inst:0 fallback for all channels
    expect(ws.sent).toHaveLength(3);
    const dataReq = JSON.parse(ws.sent[2]);
    expect(Array.isArray(dataReq.DataReq)).toBe(true);
    const sentIds = dataReq.DataReq.map((e: any) => e.id).sort((a: number, b: number) => a - b);
    expect(sentIds).toEqual(allIds.slice().sort((a, b) => a - b));
    for (const entry of dataReq.DataReq) {
      expect(entry.inst).toBe(0);
    }

    await mgr.disconnect();
  });

  it('filters DataInfoReq and DataReq to only required channels present in DataList', async () => {
    vi.useFakeTimers();
    const mgr = new GoFreeManager({ WebSocketImpl: MockWebSocket as any });
    await mgr.connect('127.0.0.1', 2053);

    const ws = latest(MockWebSocket.instances);
    ws.simulateOpen();
    expect(ws.sent).toHaveLength(1);

    // DataList missing LAT/LON (421, 422)
    const partialIds = [9, 37, 41, 42, 46, 47, 140, 141, 226, 235];
    ws.simulateMessage(JSON.stringify({ DataList: { groupId: 40, list: partialIds } }));

    // DataInfoReq should only contain the 10 channels from partialIds
    expect(ws.sent).toHaveLength(2);
    const infoReq = JSON.parse(ws.sent[1]);
    expect(infoReq.DataInfoReq.sort((a: number, b: number) => a - b)).toEqual(
      partialIds.slice().sort((a, b) => a - b),
    );
    expect(infoReq.DataInfoReq).not.toContain(421);
    expect(infoReq.DataInfoReq).not.toContain(422);

    // DataInfo timeout → DataReq
    vi.advanceTimersByTime(3_000);
    expect(ws.sent).toHaveLength(3);
    const dataReq = JSON.parse(ws.sent[2]);
    const sentIds = dataReq.DataReq.map((e: any) => e.id).sort((a: number, b: number) => a - b);
    expect(sentIds).toEqual(partialIds.slice().sort((a, b) => a - b));
    expect(sentIds).not.toContain(421);
    expect(sentIds).not.toContain(422);

    await mgr.disconnect();
  });

  it('falls back to DataReq for required channels if DataList never arrives', async () => {
    vi.useFakeTimers();
    const mgr = new GoFreeManager({ WebSocketImpl: MockWebSocket as any });
    await mgr.connect('127.0.0.1', 2053);

    const ws = latest(MockWebSocket.instances);
    ws.simulateOpen();

    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0]).DataListReq).toBeDefined();

    // Advance past discovery timeout (3 s) — fallback sends DataReq directly (no DataInfoReq)
    vi.advanceTimersByTime(3_000);
    expect(ws.sent).toHaveLength(2); // DataListReq + DataReq only (no DataInfoReq)
    const req = JSON.parse(ws.sent[1]);
    expect(req.DataReq).toBeDefined();
    expect(req.DataInfoReq).toBeUndefined();
    const ids = req.DataReq.map((e: any) => e.id).sort((a: number, b: number) => a - b);
    expect(ids).toEqual([9, 37, 41, 42, 46, 47, 140, 141, 226, 235, 421, 422]);

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

    // +3 s → discovery timeout → DataReq (msg 1)
    vi.advanceTimersByTime(3_000);
    expect(ws.sent).toHaveLength(2);
    expect(JSON.parse(ws.sent[1]).DataReq).toBeDefined();

    // +30 s → first keepalive (message 2)
    vi.advanceTimersByTime(30_000);
    expect(ws.sent).toHaveLength(3);
    expect(JSON.parse(ws.sent[2])).toEqual({ SettingListReq: [{ groupId: 2 }] });

    // +30 s → second keepalive (message 3)
    vi.advanceTimersByTime(30_000);
    expect(ws.sent).toHaveLength(4);
    expect(JSON.parse(ws.sent[3])).toEqual({ SettingListReq: [{ groupId: 2 }] });

    await mgr.disconnect();
  });

  it('disconnect() stops keepalive and discovery timers', async () => {
    vi.useFakeTimers();
    const mgr = new GoFreeManager({
      keepaliveIntervalMs: 30_000,
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
            DataList: { groupId: 40, list: [9, 37, 41, 42, 46, 47, 140, 141, 226, 235, 421, 422] },
          }));
          return;
        }
        // Step 2a: respond to DataInfoReq with DataInfo array (one entry per channel ID).
        // DataInfoReq is an integer array per the GoFree spec: [141, 47, 42, ...]
        if (Array.isArray(msg?.DataInfoReq)) {
          const items = msg.DataInfoReq.map((id: number) => ({ id, sname: 'test', unit: '' }));
          socket.send(JSON.stringify({ DataInfo: items }));
          return;
        }
        // Step 2b: respond to DataReq with a data stream
        if (msg?.DataReq && !subscribeReceived) {
          subscribeReceived = msg;
          // Reply with a Data envelope covering the required channel IDs
          socket.send(JSON.stringify({
            Data: [
              { id: 141, inst: 0, val: 55, valid: true },
              { id: 47, inst: 0, val: 12, valid: true },
              { id: 42, inst: 0, val: 6.0, valid: true },
              { id: 41, inst: 0, val: 7.5, valid: true },
              { id: 9, inst: 0, val: 80, valid: true },
              { id: 37, inst: 0, val: 90, valid: true },
              { id: 421, inst: 0, val: 42.0, valid: true },
              { id: 422, inst: 0, val: -71.0, valid: true },
              { id: 140, inst: 0, val: 30, valid: true },
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
