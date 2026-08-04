/**
 * Tests for GoFreeManager — NMEA 0183 sentence parsing and event emission.
 *
 * BE6: Unit tests for sentence parsing, normalization, and true wind fallback.
 * BE7: Integration test with a mock TCP server.
 *
 * All tests use discoveryTimeoutMs: 0 to skip UDP multicast discovery and
 * connect directly to the configured host (localhost for the integration test).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as net from 'net';
import { GoFreeManager } from './gofree-manager';
import type { ParsedPGN } from './serial-manager';

// ---------------------------------------------------------------------------
// NMEA sentence helpers
// ---------------------------------------------------------------------------

/** Compute NMEA-0183 XOR checksum and return the complete sentence with checksum. */
function mkSentence(base: string): string {
  let cs = 0;
  // XOR all characters between '$' (exclusive) and '*' (exclusive)
  for (let i = 1; i < base.length; i++) {
    cs ^= base.charCodeAt(i);
  }
  return base + '*' + cs.toString(16).toUpperCase().padStart(2, '0');
}

// Unit conversion constants (matching gofree-manager.ts)
const KTS_TO_MS = 1 / 1.94384;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** Compute expected true wind from apparent wind + STW (matches analysis-engine formula). */
function computeTrueWind(awsKts: number, awaDeg: number, stwKts: number): { tws: number; twa: number } {
  const awaRad = awaDeg * DEG_TO_RAD;
  const u = awsKts * Math.sin(awaRad);
  const v = awsKts * Math.cos(awaRad) - stwKts;
  const tws = Math.sqrt(u * u + v * v);
  const twaRad = Math.atan2(u, v);
  const twaDeg = (((twaRad * RAD_TO_DEG) % 360) + 360) % 360;
  return { tws, twa: twaDeg };
}

// ---------------------------------------------------------------------------
// Helper: synchronously feed a sentence to a GoFreeManager's internal parser
// without going through the TCP socket. We access the private method via cast.
// ---------------------------------------------------------------------------

function feedSentence(manager: GoFreeManager, sentence: string): void {
  // Access private method for unit testing
  (manager as any).parseSentence(sentence);
}

// ---------------------------------------------------------------------------
// Sentence fixtures with correct checksums
// ---------------------------------------------------------------------------

// $WIMWV — apparent wind, 45° starboard, 12.5 kts
const WIMWV_APPARENT = mkSentence('$WIMWV,045.0,R,12.5,N,A');
// $WIMWV — apparent wind, port side (-45°), 10 kts
const WIMWV_APPARENT_PORT = mkSentence('$WIMWV,315.0,R,10.0,N,A'); // 315° == port 45°
// $WIMWV — true wind, 52° starboard, 8 kts
const WIMWV_TRUE = mkSentence('$WIMWV,052.0,T,08.0,N,A');
// $IIVHW — STW 5.2 kts, heading magnetic 355°
const IIVHW = mkSentence('$IIVHW,0.0,T,355.0,M,5.2,N,9.6,K');
// $GPRMC — lat 48.117N, lon 11.517E, SOG 22.4 kts, COG 084.4°
const GPRMC = mkSentence('$GPRMC,123519,A,4807.038,N,01131.000,E,022.4,084.4,230394,003.1,W');
// $GPVTG — SOG 5.5 kts, COG true 054.7°
const GPVTG = mkSentence('$GPVTG,054.7,T,034.4,M,005.5,N,010.2,K');
// $HCHDG — heading 355°
const HCHDG = mkSentence('$HCHDG,355.0,0.0,E,0.0,E');
// $HCHDT — heading true 355°
const HCHDT = mkSentence('$HCHDT,355.0,T');
// $GPGLL — lat 42.0N, lon 71.0W
const GPGLL = mkSentence('$GPGLL,4200.0000,N,07100.0000,W,123456,A');
// Malformed: bad checksum
const BAD_CHECKSUM = '$WIMWV,045.0,R,12.5,N,A*FF';
// Missing field sentence — truncated (too few commas), nmea-simple returns null fields
const MISSING_FIELD = mkSentence('$WIMWV,R,N,A');
// Unknown sentence type
const UNKNOWN = mkSentence('$XXABC,1,2,3');

// ---------------------------------------------------------------------------
// PGN numbers (must match gofree-manager.ts constants)
// ---------------------------------------------------------------------------
const PGN_WIND = 130306;
const PGN_STW = 128259;
const PGN_SOG_COG = 129026;
const PGN_POSITION = 129025;
const PGN_HEADING = 127250;

// ---------------------------------------------------------------------------
// BE6 Unit tests
// ---------------------------------------------------------------------------

describe('GoFreeManager — unit tests (sentence parsing)', () => {
  let manager: GoFreeManager;
  let emitted: ParsedPGN[];

  beforeEach(() => {
    manager = new GoFreeManager({ discoveryTimeoutMs: 0 });
    emitted = [];
    manager.on('pgn', (pgn: ParsedPGN) => emitted.push(pgn));
  });

  afterEach(() => {
    manager.removeAllListeners();
  });

  // -----------------------------------------------------------------------
  // $WIMWV ref=R (apparent wind)
  // -----------------------------------------------------------------------

  it('$WIMWV ref=R → emits apparent wind (PGN 130306, ref=Apparent)', () => {
    feedSentence(manager, WIMWV_APPARENT);
    const apparent = emitted.find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'Apparent',
    );
    expect(apparent).toBeDefined();
    // AWS: 12.5 kts → m/s
    expect(apparent!.fields.windSpeed).toBeCloseTo(12.5 * KTS_TO_MS, 4);
    // AWA: 45° → radians
    expect(apparent!.fields.windAngle).toBeCloseTo(45 * DEG_TO_RAD, 4);
  });

  // -----------------------------------------------------------------------
  // $WIMWV ref=T (true wind)
  // -----------------------------------------------------------------------

  it('$WIMWV ref=T → emits true wind (PGN 130306, ref=True (boat referenced))', () => {
    feedSentence(manager, WIMWV_TRUE);
    const trueWind = emitted.find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'True (boat referenced)',
    );
    expect(trueWind).toBeDefined();
    // TWS: 8 kts → m/s
    expect(trueWind!.fields.windSpeed).toBeCloseTo(8 * KTS_TO_MS, 4);
    // TWA: 52° → radians
    expect(trueWind!.fields.windAngle).toBeCloseTo(52 * DEG_TO_RAD, 4);
  });

  // -----------------------------------------------------------------------
  // $IIVHW
  // -----------------------------------------------------------------------

  it('$IIVHW → emits STW (PGN 128259) and heading (PGN 127250)', () => {
    feedSentence(manager, IIVHW);
    const stwPgn = emitted.find((p) => p.pgn === PGN_STW);
    expect(stwPgn).toBeDefined();
    // STW: 5.2 kts → m/s
    expect(stwPgn!.fields.speedWaterReferenced).toBeCloseTo(5.2 * KTS_TO_MS, 4);

    const hdgPgn = emitted.find((p) => p.pgn === PGN_HEADING);
    expect(hdgPgn).toBeDefined();
    // Heading: 355° → radians
    expect(hdgPgn!.fields.heading).toBeCloseTo(355 * DEG_TO_RAD, 4);
  });

  // -----------------------------------------------------------------------
  // $GPRMC
  // -----------------------------------------------------------------------

  it('$GPRMC → emits position (PGN 129025) and SOG/COG (PGN 129026)', () => {
    feedSentence(manager, GPRMC);
    const posPgn = emitted.find((p) => p.pgn === PGN_POSITION);
    expect(posPgn).toBeDefined();
    expect(posPgn!.fields.latitude).toBeCloseTo(48.117, 2);
    expect(posPgn!.fields.longitude).toBeCloseTo(11.517, 2);

    const sogCogPgn = emitted.find((p) => p.pgn === PGN_SOG_COG);
    expect(sogCogPgn).toBeDefined();
    // SOG: 22.4 kts → m/s
    expect(sogCogPgn!.fields.sog).toBeCloseTo(22.4 * KTS_TO_MS, 3);
    // COG: 084.4° → radians
    expect(sogCogPgn!.fields.cog).toBeCloseTo(84.4 * DEG_TO_RAD, 3);
  });

  // -----------------------------------------------------------------------
  // $GPVTG
  // -----------------------------------------------------------------------

  it('$GPVTG → emits SOG/COG (PGN 129026)', () => {
    feedSentence(manager, GPVTG);
    const sogCogPgn = emitted.find((p) => p.pgn === PGN_SOG_COG);
    expect(sogCogPgn).toBeDefined();
    expect(sogCogPgn!.fields.sog).toBeCloseTo(5.5 * KTS_TO_MS, 4);
    expect(sogCogPgn!.fields.cog).toBeCloseTo(54.7 * DEG_TO_RAD, 4);
  });

  // -----------------------------------------------------------------------
  // $HCHDG
  // -----------------------------------------------------------------------

  it('$HCHDG → emits heading (PGN 127250, field: heading)', () => {
    feedSentence(manager, HCHDG);
    const hdgPgn = emitted.find((p) => p.pgn === PGN_HEADING && p.fields.heading != null);
    expect(hdgPgn).toBeDefined();
    expect(hdgPgn!.fields.heading).toBeCloseTo(355 * DEG_TO_RAD, 4);
  });

  // -----------------------------------------------------------------------
  // $HCHDT (fallback heading)
  // -----------------------------------------------------------------------

  it('$HCHDT → emits heading fallback (PGN 127250, field: headingTrue)', () => {
    feedSentence(manager, HCHDT);
    const hdgPgn = emitted.find((p) => p.pgn === PGN_HEADING && p.fields.headingTrue != null);
    expect(hdgPgn).toBeDefined();
    expect(hdgPgn!.fields.headingTrue).toBeCloseTo(355 * DEG_TO_RAD, 4);
  });

  // -----------------------------------------------------------------------
  // Malformed / unknown sentences
  // -----------------------------------------------------------------------

  it('malformed sentence (bad checksum) → silently skipped, no crash', () => {
    expect(() => feedSentence(manager, BAD_CHECKSUM)).not.toThrow();
    expect(emitted).toHaveLength(0);
  });

  it('missing-field sentence → silently skipped, no crash', () => {
    expect(() => feedSentence(manager, MISSING_FIELD)).not.toThrow();
    // Missing speed/angle in MWV → should not emit any PGN
    const windPgns = emitted.filter((p) => p.pgn === PGN_WIND);
    expect(windPgns).toHaveLength(0);
  });

  it('unknown sentence type → silently ignored, no crash', () => {
    expect(() => feedSentence(manager, UNKNOWN)).not.toThrow();
    expect(emitted).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // AWA normalization (port tack)
  // -----------------------------------------------------------------------

  it('AWA port tack: NMEA 315° → emits windAngle in radians matching 315°', () => {
    feedSentence(manager, WIMWV_APPARENT_PORT);
    const apparent = emitted.find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'Apparent',
    );
    expect(apparent).toBeDefined();
    // 315° = port 45°. Downstream normalizeWindAngle(315°) → {angle: 45, side: 'port'}
    expect(apparent!.fields.windAngle).toBeCloseTo(315 * DEG_TO_RAD, 4);
  });

  it('AWA negative (signed port) → normalized to 0–360° before radians', () => {
    // NMEA can also deliver negative angles (some devices); exercise the normalization
    // by directly testing the internal dispatchSentence path via a manual call.
    const negativeAwaSentence = '$WIMWV,-045.0,R,10.0,N,A';
    let checksum = 0;
    for (let i = 1; i < negativeAwaSentence.length; i++) {
      checksum ^= negativeAwaSentence.charCodeAt(i);
    }
    const full = negativeAwaSentence + '*' + checksum.toString(16).toUpperCase().padStart(2, '0');
    feedSentence(manager, full);
    const apparent = emitted.find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'Apparent',
    );
    expect(apparent).toBeDefined();
    // -45° normalized to 315° → 315 * DEG_TO_RAD
    expect(apparent!.fields.windAngle).toBeCloseTo(315 * DEG_TO_RAD, 4);
  });

  // -----------------------------------------------------------------------
  // True wind fallback
  // -----------------------------------------------------------------------

  it('true wind fallback: only ref=R + STW → computed TWS/TWA emitted as True (boat referenced)', () => {
    // Feed STW first (IIVHW gives STW = 5.2 kts)
    feedSentence(manager, IIVHW);
    emitted.length = 0; // reset to isolate wind events

    // Feed apparent wind (no ref=T has been received)
    feedSentence(manager, WIMWV_APPARENT); // AWS=12.5, AWA=45°

    const trueWind = emitted.find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'True (boat referenced)',
    );
    expect(trueWind).toBeDefined();

    // Verify computed values match the reference formula
    const expected = computeTrueWind(12.5, 45, 5.2);
    expect(trueWind!.fields.windSpeed).toBeCloseTo(expected.tws * KTS_TO_MS, 3);
    expect(trueWind!.fields.windAngle).toBeCloseTo(expected.twa * DEG_TO_RAD, 3);
  });

  it('no true wind fallback when ref=T has been received', () => {
    // Receive ref=T first
    feedSentence(manager, WIMWV_TRUE);
    feedSentence(manager, IIVHW);
    emitted.length = 0;

    // Now receive ref=R — should NOT emit computed true wind since hasTrueWindSentence=true
    feedSentence(manager, WIMWV_APPARENT);

    const trueWindCount = emitted.filter(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'True (boat referenced)',
    ).length;
    // Only apparent wind emitted, no fallback computation
    expect(trueWindCount).toBe(0);
  });

  it('true wind fallback absent when STW not yet known', () => {
    // Feed only apparent wind, no STW
    feedSentence(manager, WIMWV_APPARENT);
    const trueWind = emitted.find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'True (boat referenced)',
    );
    // No fallback without STW
    expect(trueWind).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// BE7 Integration test — mock TCP server
// ---------------------------------------------------------------------------

describe('GoFreeManager — integration test (mock TCP server)', () => {
  let server: net.Server;
  let serverPort: number;

  beforeEach(async () => {
    server = net.createServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    serverPort = (server.address() as net.AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('connects to mock TCP server and emits correct PGN events for a full sentence set', async () => {
    const FIXTURE_SENTENCES = [
      // Heading first so it is available for subsequent wind computations
      mkSentence('$HCHDG,180.0,0.0,E,0.0,E'),
      // STW
      mkSentence('$IIVHW,0.0,T,355.0,M,6.0,N,11.1,K'),
      // True wind
      mkSentence('$WIMWV,040.0,T,10.0,N,A'),
      // Apparent wind
      mkSentence('$WIMWV,050.0,R,14.0,N,A'),
      // Position
      mkSentence('$GPRMC,120000,A,4200.000,N,07100.000,W,008.0,045.0,010826,000.0,W'),
      // SOG/COG via VTG
      mkSentence('$GPVTG,045.0,T,040.0,M,008.0,N,014.8,K'),
    ];

    // Stream fixture sentences when a client connects
    server.on('connection', (socket) => {
      for (const sentence of FIXTURE_SENTENCES) {
        socket.write(sentence + '\r\n');
      }
      // Leave socket open (GoFreeManager reads until close/error)
    });

    const manager = new GoFreeManager({ discoveryTimeoutMs: 0 });
    const received: ParsedPGN[] = [];
    manager.on('pgn', (pgn: ParsedPGN) => received.push(pgn));

    // Connect directly to mock server (no multicast discovery)
    await manager.connect('127.0.0.1', serverPort);

    // Wait for data to arrive (short delay for async I/O)
    await new Promise<void>((resolve) => setTimeout(resolve, 150));

    // Verify heading (PGN 127250)
    const hdgPgn = received.find((p) => p.pgn === PGN_HEADING && p.fields.heading != null);
    expect(hdgPgn).toBeDefined();
    expect(hdgPgn!.fields.heading).toBeCloseTo(180 * DEG_TO_RAD, 3);

    // Verify STW (PGN 128259)
    const stwPgn = received.find((p) => p.pgn === PGN_STW);
    expect(stwPgn).toBeDefined();
    expect(stwPgn!.fields.speedWaterReferenced).toBeCloseTo(6.0 * KTS_TO_MS, 3);

    // Verify TWS/TWA from direct ref=T sentence (PGN 130306)
    const twPgn = received.find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'True (boat referenced)',
    );
    expect(twPgn).toBeDefined();
    expect(twPgn!.fields.windSpeed).toBeCloseTo(10 * KTS_TO_MS, 3);
    expect(twPgn!.fields.windAngle).toBeCloseTo(40 * DEG_TO_RAD, 3);

    // Verify apparent wind (PGN 130306, ref=Apparent)
    const awPgn = received.find(
      (p) => p.pgn === PGN_WIND && p.fields.reference === 'Apparent',
    );
    expect(awPgn).toBeDefined();
    expect(awPgn!.fields.windSpeed).toBeCloseTo(14 * KTS_TO_MS, 3);
    expect(awPgn!.fields.windAngle).toBeCloseTo(50 * DEG_TO_RAD, 3);

    // Verify position from RMC (PGN 129025)
    const posPgn = received.find((p) => p.pgn === PGN_POSITION);
    expect(posPgn).toBeDefined();
    expect(posPgn!.fields.latitude).toBeCloseTo(42.0, 2);
    expect(posPgn!.fields.longitude).toBeCloseTo(-71.0, 2);

    // Verify SOG/COG from VTG (PGN 129026)
    const sogPgn = received.find((p) => p.pgn === PGN_SOG_COG && p.fields.sog != null);
    expect(sogPgn).toBeDefined();
    expect(sogPgn!.fields.sog).toBeCloseTo(8 * KTS_TO_MS, 3);
    expect(sogPgn!.fields.cog).toBeCloseTo(45 * DEG_TO_RAD, 3);

    await manager.disconnect();
  });
});
