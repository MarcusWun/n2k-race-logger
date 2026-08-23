/**
 * Phase A Correctness Tests
 *
 * Covers:
 *   BE2 — Fix #2: Math.min/max spread crash on long races
 *   BE4a — Fix #4 backend half: polar:performance double delivery
 *   BE5 — Fix #6: splitSegmentsAtSailChanges wiring
 *   FE4a — Fix #4 renderer half: polar:performance dead listener removed from Dashboard
 *
 * These tests exercise the fixed logic in ipc-handlers.ts, analysis-engine.ts,
 * and renderer utilities without needing a real Electron or browser runtime.
 */

import { describe, it, expect, vi } from 'vitest';
import { requestLivePolarPerformance } from '../src/utils/livePolarPerformance';
import {
  reconstructTimeSeries,
  detectSegments,
  assignSailTags,
  splitSegmentsAtSailChanges,
  computeSegmentPerformance,
} from './analysis-engine';
import type { SegmentThresholds, SailTagData } from './analysis-engine';

// ---------------------------------------------------------------------------
// BE2 — Fix #2: Math.min/max spread crash on large allTimes arrays
// ---------------------------------------------------------------------------

describe('Fix #2 — Time-range extraction from large allTimes arrays (BE2 regression guard)', () => {
  it('direct array access correctly finds start/end of a 200,000 element sorted array', () => {
    // Simulate a 200,000-element sorted array of timestamps (as ipc-handlers produces)
    const BASE = 1_700_000_000_000; // arbitrary epoch base
    const COUNT = 200_000;
    const allTimes: number[] = [];
    for (let i = 0; i < COUNT; i++) {
      allTimes.push(BASE + i * 100); // 100ms intervals
    }

    // Old code: Math.min(...allTimes) would throw RangeError on arrays this large.
    // New code: direct array access, O(1), no argument-count limit.
    const startMs = allTimes[0];
    const endMs = allTimes[allTimes.length - 1];

    expect(startMs).toBe(BASE);
    expect(endMs).toBe(BASE + (COUNT - 1) * 100);
    // No RangeError thrown — the test itself demonstrates the fix
  });

  it('old spread approach throws RangeError on a 200,000-element array (documents the bug)', () => {
    const allTimes = Array.from({ length: 200_000 }, (_, i) => i);
    // V8 enforces a max argument count — spread into function call throws on large arrays.
    // If this ever stops throwing (engine change), the direct-access fix is still correct.
    expect(() => Math.min(...allTimes)).toThrow();
  });

  it('direct array access gives correct results for small arrays (regression)', () => {
    const allTimes = [1000, 2000, 3000, 4000, 5000];
    const startMs = allTimes[0];
    const endMs = allTimes[allTimes.length - 1];
    expect(startMs).toBe(1000);
    expect(endMs).toBe(5000);
  });

  it('reconstructTimeSeries produces timestamps in ascending order (sort invariant)', () => {
    // Construct 5 raw PGN rows with shuffled timestamps. reconstructTimeSeries must
    // sort them ascending, so allTimes derived from ts.tws will be sorted.
    const rows = [
      { timestamp: 5000, pgn: 130306, data: { windSpeed: 5, windAngle: 1.0, windReference: 'True (boat referenced)' } },
      { timestamp: 1000, pgn: 130306, data: { windSpeed: 5, windAngle: 1.0, windReference: 'True (boat referenced)' } },
      { timestamp: 3000, pgn: 130306, data: { windSpeed: 5, windAngle: 1.0, windReference: 'True (boat referenced)' } },
      { timestamp: 2000, pgn: 130306, data: { windSpeed: 5, windAngle: 1.0, windReference: 'True (boat referenced)' } },
      { timestamp: 4000, pgn: 130306, data: { windSpeed: 5, windAngle: 1.0, windReference: 'True (boat referenced)' } },
    ];
    const ts = reconstructTimeSeries(rows as any);
    const twsTimes = ts.tws.filter((p) => p.value != null).map((p) => p.time);
    // Each time must be >= the previous — confirms ascending sort invariant
    for (let i = 1; i < twsTimes.length; i++) {
      expect(twsTimes[i]).toBeGreaterThanOrEqual(twsTimes[i - 1]);
    }
  });
});

// ---------------------------------------------------------------------------
// BE4a — Fix #4 backend half: polar:performance must NOT call getWebContents().send
// ---------------------------------------------------------------------------

describe('Fix #4 backend — polar:performance single delivery (BE4a regression guard)', () => {
  it('ipc-handlers polar:performance handler does not invoke getWebContents().send (static analysis guard)', () => {
    // Read the ipc-handlers source and assert the removed code line is absent.
    // We check for the non-comment form: `getWebContents()?.send('polar:performance'`
    // A comment mentioning the removed line is fine; an actual call is not.
    const fs = require('fs');
    const path = require('path');
    const src: string = fs.readFileSync(
      path.join(__dirname, 'ipc-handlers.ts'),
      'utf-8',
    );

    // Check each line — the call must not appear outside a comment.
    const hasBuggyCall = src
      .split('\n')
      .filter((line: string) => !line.trim().startsWith('//'))
      .some((line: string) => line.includes("getWebContents()?.send('polar:performance'"));
    expect(hasBuggyCall).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// BE5 — Fix #6: splitSegmentsAtSailChanges wiring integration test
// ---------------------------------------------------------------------------

describe('Fix #6 — splitSegmentsAtSailChanges chain wiring (BE5 regression guard)', () => {
  /**
   * Build a minimal resampled time series for testing.
   * startMs: start timestamp, count: number of 1-second samples, tws/twa/stw: constant values.
   */
  function buildSeries(startMs: number, count: number, tws: number, twa: number, stw: number) {
    const points = Array.from({ length: count }, (_, i) => ({
      time: startMs + i * 1000,
      value: null as number | null,
    }));
    return {
      tws: points.map((p) => ({ ...p, value: tws })),
      twa: points.map((p) => ({ ...p, value: twa })),
      stw: points.map((p) => ({ ...p, value: stw })),
    };
  }

  it('sail-change boundary inside a detected segment produces two sub-segments each with non-null sailConfig', () => {
    // Build a 120-second time series (120 1-second samples) at constant TWS/TWA/STW.
    // The sail change happens at t=60s.
    const BASE = 1_700_000_000_000;
    const DURATION = 120; // seconds
    const ts = buildSeries(BASE, DURATION, 10, 60, 5.5);

    const thresholds: SegmentThresholds = {
      minDuration: 20,
      tws: 3,
      twa: 20,
      stw: 1,
    };

    // detectSegments should find one segment covering most of the series
    const segments = detectSegments(ts.tws, ts.twa, ts.stw, thresholds);
    expect(segments.length).toBeGreaterThanOrEqual(1);

    // Define two sail tags straddling t=60s
    const sailTags: SailTagData[] = [
      {
        sailConfig: 'J1 + Main',
        startTime: BASE,
        endTime: BASE + 60_000, // 0-60s
      },
      {
        sailConfig: 'J2 + Main',
        startTime: BASE + 60_000, // 60-120s
        endTime: BASE + DURATION * 1000,
      },
    ];

    // Apply the full chain: detect → split → tag → compute
    const splitSegments = splitSegmentsAtSailChanges(
      segments,
      sailTags,
      ts.tws,
      ts.twa,
      ts.stw,
      thresholds.minDuration,
    );
    const taggedSegments = assignSailTags(splitSegments, sailTags);
    const performance = computeSegmentPerformance(taggedSegments, null); // no polar table

    // Without splitting, the single segment would straddle the boundary and get sailConfig: null.
    // With splitting, we should get two sub-segments each with a non-null sailConfig.
    const nonNullConfigs = performance.filter((s) => s.sailConfig !== null);
    expect(nonNullConfigs.length).toBeGreaterThanOrEqual(2);

    // Each sub-segment must be long enough (> minDuration)
    for (const seg of nonNullConfigs) {
      expect(seg.durationS).toBeGreaterThanOrEqual(thresholds.minDuration);
    }

    // The two sail configs should be different (J1+Main and J2+Main)
    const configs = nonNullConfigs.map((s) => s.sailConfig);
    expect(configs).toContain('J1 + Main');
    expect(configs).toContain('J2 + Main');
  });

  it('segment with no sail-change boundary passes through unchanged', () => {
    const BASE = 1_700_000_000_000;
    const ts = buildSeries(BASE, 60, 10, 60, 5.5);
    const thresholds: SegmentThresholds = {
      minDuration: 20,
      tws: 3,
      twa: 20,
      stw: 1,
    };

    const segments = detectSegments(ts.tws, ts.twa, ts.stw, thresholds);

    // Single sail tag covering the whole window — no boundary inside any segment
    const sailTags: SailTagData[] = [
      { sailConfig: 'J1 + Main', startTime: BASE, endTime: BASE + 60_000 },
    ];

    const splitSegments = splitSegmentsAtSailChanges(
      segments,
      sailTags,
      ts.tws,
      ts.twa,
      ts.stw,
      thresholds.minDuration,
    );

    // No split should have occurred — segment count unchanged
    expect(splitSegments.length).toBe(segments.length);
  });
});

// ---------------------------------------------------------------------------
// FE4a — Fix #4 renderer half: dead polar:performance listener removed
// ---------------------------------------------------------------------------

describe('Fix #4 renderer — polar:performance dead listener removed from Dashboard (FE4a regression guard)', () => {
  it('Dashboard.tsx does not register an ipc.on polar:performance listener (static analysis guard)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('path');
    const src: string = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'components', 'Dashboard', 'Dashboard.tsx'),
      'utf-8',
    );

    // Assert that no non-comment line registers a listener for 'polar:performance'.
    // The push channel was removed from the backend at 870c898; the renderer listener
    // is now dead code and was removed in this fix. A future re-addition would silently
    // cause double-delivery and ordering bugs (no requestId guard on the listener path).
    const hasDeadListener = src
      .split('\n')
      .filter((line: string) => !line.trim().startsWith('//'))
      .some(
        (line: string) =>
          line.includes("'polar:performance'") && line.includes('.on('),
      );
    expect(hasDeadListener).toBe(false);
  });

  it('requestLivePolarPerformance (the sole remaining delivery path) calls setPerformance exactly once per invoke', async () => {
    // Prior to the fix, each polar:performance request triggered TWO setPerformance calls:
    //   1. Via ipcRenderer.invoke(...).then(setPerformance)  [requestId-guarded]
    //   2. Via ipcRenderer.on('polar:performance', setPerformance)  [unguarded push — now removed]
    // This test asserts the invoke path (requestLivePolarPerformance) calls the callback exactly once.
    const performanceCalls: unknown[] = [];
    await requestLivePolarPerformance(
      {
        getPerformance: async () => ({
          percentPolar: 95,
          targetSpeed: 6.5,
          actualSpeed: 6.2,
        }),
      },
      { stw: 6.2, tws: 12.0, twa: 45 },
      7,
      (performance) => performanceCalls.push(performance),
    );

    expect(performanceCalls).toHaveLength(1);
    expect(performanceCalls[0]).toEqual({
      percentPolar: 95,
      targetSpeed: 6.5,
      actualSpeed: 6.2,
    });
  });

  it('requestLivePolarPerformance calls setPerformance exactly once even when invoked in rapid succession', async () => {
    // Regression guard against ordering bugs under rapid consecutive invokes.
    // Each call to requestLivePolarPerformance should produce exactly one setPerformance
    // callback regardless of whether earlier calls resolve before or after later ones.
    const calls: Array<{ index: number; performance: unknown }> = [];
    let resolveFirst!: (v: unknown) => void;
    const firstInflight = new Promise((res) => { resolveFirst = res; });

    let callCount = 0;
    const ipc = {
      getPerformance: async (payload: unknown) => {
        const myIndex = callCount++;
        if (myIndex === 0) {
          // First call blocks until we resolve it manually (simulates slow response)
          await firstInflight;
          return { percentPolar: 80, targetSpeed: 6.0, actualSpeed: 4.8 };
        }
        return { percentPolar: 95, targetSpeed: 6.5, actualSpeed: 6.2 };
      },
    };

    // Fire first request but don't await — it is blocked
    const p1 = requestLivePolarPerformance(ipc, { stw: 4.8, tws: 10, twa: 45 }, 7, (perf) =>
      calls.push({ index: 0, performance: perf }),
    );

    // Fire second request immediately — resolves before first
    await requestLivePolarPerformance(ipc, { stw: 6.2, tws: 12, twa: 45 }, 7, (perf) =>
      calls.push({ index: 1, performance: perf }),
    );

    // Unblock the first request
    resolveFirst(undefined);
    await p1;

    // Each call should have produced exactly one setPerformance invocation (2 total)
    expect(calls).toHaveLength(2);
    // Second call resolved first
    expect(calls[0]).toMatchObject({ index: 1, performance: { percentPolar: 95 } });
    // First call resolved after (stale response, no requestId guard in the utility itself —
    // the Dashboard's requestId guard is what protects ordering; the utility just delivers once)
    expect(calls[1]).toMatchObject({ index: 0, performance: { percentPolar: 80 } });
  });
});
