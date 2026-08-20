/**
 * GoFree Hardening — Frontend Tests
 *
 * Covers FE0–FE3 acceptance criteria:
 *   FE0:  IPC type shapes — GoFreeFreshnessEvent, GofreeState including 'stale'
 *   FE1:  Freshness store updates; channel-to-metric mapping; tile staleness logic
 *         including wind-pair partial staleness (TWA stale + TWS fresh, etc.)
 *   FE2:  ConnectionBar chip — label/color for 'stale' state; state-machine transitions
 *   FE3:  Regression guard — existing tests pass, new stale paths covered
 *
 * Test strategy: pure unit tests (no DOM/React) following the existing
 * electron/phase-2-7-frontend.test.ts pattern.  Zustand stores are imported
 * directly; state is reset via setState() in afterEach to isolate tests.
 */

import { describe, expect, it, afterEach } from 'vitest';
import {
  getGofreeStatusLabel,
  getGofreeStatusColor,
} from '../src/utils/gofree';
import type { GofreeStatusPayload, GoFreeFreshnessEvent } from '../src/types/ipc';
import { useFreshnessStore, METRIC_CHANNEL_MAP, CH_VMG, CH_LEE } from '../src/store/useFreshnessStore';

// ---------------------------------------------------------------------------
// FE0: Type shape — GofreeState includes 'stale'; GoFreeFreshnessEvent shape
// ---------------------------------------------------------------------------
describe('FE0: GofreeState union includes stale', () => {
  it("accepts 'stale' as a valid GofreeState value", () => {
    const payload: GofreeStatusPayload = { state: 'stale' };
    expect(payload.state).toBe('stale');
  });

  it('GoFreeFreshnessEvent carries staleChannels number array', () => {
    const evt: GoFreeFreshnessEvent = { staleChannels: [41, 45, 47] };
    expect(evt.staleChannels).toEqual([41, 45, 47]);
  });

  it('GoFreeFreshnessEvent with empty staleChannels is valid (all fresh)', () => {
    const evt: GoFreeFreshnessEvent = { staleChannels: [] };
    expect(evt.staleChannels).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FE2: Connection chip label — 'stale' state
// ---------------------------------------------------------------------------
describe('FE2: GoFree status chip — stale state label and color', () => {
  it("returns 'GoFree — Stale (no data)' for state=stale", () => {
    const payload: GofreeStatusPayload = { state: 'stale' };
    expect(getGofreeStatusLabel(payload)).toBe('GoFree — Stale (no data)');
  });

  it('stale color is amber/warning (bg-n2k-warning) without animate-pulse', () => {
    const color = getGofreeStatusColor('stale');
    expect(color).toContain('bg-n2k-warning');
    // stale is NOT pulsing — it is a steady amber to distinguish from
    // transitional states (connecting / reconnecting which DO pulse)
    expect(color).not.toContain('animate-pulse');
  });

  it('connected color remains green (unchanged)', () => {
    expect(getGofreeStatusColor('connected')).toBe('bg-n2k-success');
  });

  it('reconnecting color is pulsing amber (unchanged)', () => {
    const color = getGofreeStatusColor('reconnecting');
    expect(color).toContain('bg-n2k-warning');
    expect(color).toContain('animate-pulse');
  });

  it('getGofreeStatusLabel handles all 7 known GoFree states (including stale)', () => {
    const states: Array<GofreeStatusPayload['state']> = [
      'searching', 'connecting', 'connected', 'stale', 'reconnecting', 'error', 'disconnected',
    ];
    for (const state of states) {
      const label = getGofreeStatusLabel({ state });
      expect(label).toMatch(/^GoFree —/);
    }
  });
});

// ---------------------------------------------------------------------------
// FE1: Freshness store — setStaleChannels / isChannelStale
// ---------------------------------------------------------------------------
describe('FE1: useFreshnessStore — set and query stale channels', () => {
  afterEach(() => {
    // Reset store to pristine state between tests
    useFreshnessStore.setState({ staleChannels: new Set() });
  });

  it('starts with an empty stale-channel set (all channels fresh)', () => {
    const { staleChannels } = useFreshnessStore.getState();
    expect(staleChannels.size).toBe(0);
  });

  it('setStaleChannels replaces the set with the supplied channel IDs', () => {
    useFreshnessStore.getState().setStaleChannels([41, 45, 47]);
    const { staleChannels } = useFreshnessStore.getState();
    expect(staleChannels.size).toBe(3);
    expect(staleChannels.has(41)).toBe(true);
    expect(staleChannels.has(45)).toBe(true);
    expect(staleChannels.has(47)).toBe(true);
  });

  it('isChannelStale returns true for a channel in the stale set', () => {
    useFreshnessStore.getState().setStaleChannels([42, 46]);
    expect(useFreshnessStore.getState().isChannelStale(42)).toBe(true);
    expect(useFreshnessStore.getState().isChannelStale(46)).toBe(true);
  });

  it('isChannelStale returns false for a channel not in the stale set', () => {
    useFreshnessStore.getState().setStaleChannels([42]);
    expect(useFreshnessStore.getState().isChannelStale(47)).toBe(false);
  });

  it('setStaleChannels with empty array clears staleness (all channels fresh again)', () => {
    useFreshnessStore.getState().setStaleChannels([41, 45, 47]);
    useFreshnessStore.getState().setStaleChannels([]);
    expect(useFreshnessStore.getState().staleChannels.size).toBe(0);
    expect(useFreshnessStore.getState().isChannelStale(45)).toBe(false);
  });

  it('setStaleChannels is idempotent — calling twice with same data gives same result', () => {
    useFreshnessStore.getState().setStaleChannels([41, 45]);
    useFreshnessStore.getState().setStaleChannels([41, 45]);
    expect(useFreshnessStore.getState().staleChannels.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// FE1: METRIC_CHANNEL_MAP — authoritative channel ID mapping
// ---------------------------------------------------------------------------
describe('FE1: METRIC_CHANNEL_MAP — channel IDs match gofree-manager.ts constants', () => {
  it('stw maps to CH_BSPD = 42', () => expect(METRIC_CHANNEL_MAP.stw).toBe(42));
  it('sog maps to CH_SOG  = 41', () => expect(METRIC_CHANNEL_MAP.sog).toBe(41));
  it('awa maps to CH_AWA  = 44', () => expect(METRIC_CHANNEL_MAP.awa).toBe(44));
  it('twa maps to CH_TWA  = 45', () => expect(METRIC_CHANNEL_MAP.twa).toBe(45));
  it('aws maps to CH_AWS  = 46', () => expect(METRIC_CHANNEL_MAP.aws).toBe(46));
  it('tws maps to CH_TWS  = 47', () => expect(METRIC_CHANNEL_MAP.tws).toBe(47));
  it('cog maps to CH_COG  =  9', () => expect(METRIC_CHANNEL_MAP.cog).toBe(9));
  it('heading maps to CH_HDG = 37', () => expect(METRIC_CHANNEL_MAP.heading).toBe(37));
  it('lat maps to CH_LAT  = 421', () => expect(METRIC_CHANNEL_MAP.lat).toBe(421));
  it('lon maps to CH_LON  = 422', () => expect(METRIC_CHANNEL_MAP.lon).toBe(422));
  it('CH_VMG constant = 235', () => expect(CH_VMG).toBe(235));
  it('CH_LEE constant = 226', () => expect(CH_LEE).toBe(226));
});

// ---------------------------------------------------------------------------
// FE1: Wind-pair partial staleness (PRD §4.2 + §4.3)
// The freshness store tracks individual channels — TWA and TWS are independent.
// A stale TWA must not suppress TWS display and vice versa.
// ---------------------------------------------------------------------------
describe('FE1: Wind-pair partial staleness — TWA/TWS and AWA/AWS independence', () => {
  afterEach(() => {
    useFreshnessStore.setState({ staleChannels: new Set() });
  });

  it('TWA stale + TWS fresh: TWA channel stale, TWS channel fresh', () => {
    useFreshnessStore.getState().setStaleChannels([METRIC_CHANNEL_MAP.twa]); // ch45 only
    const { isChannelStale } = useFreshnessStore.getState();
    expect(isChannelStale(METRIC_CHANNEL_MAP.twa)).toBe(true);   // TWA → '--'
    expect(isChannelStale(METRIC_CHANNEL_MAP.tws)).toBe(false);  // TWS → shows value
  });

  it('TWS stale + TWA fresh: TWS channel stale, TWA channel fresh', () => {
    useFreshnessStore.getState().setStaleChannels([METRIC_CHANNEL_MAP.tws]); // ch47 only
    const { isChannelStale } = useFreshnessStore.getState();
    expect(isChannelStale(METRIC_CHANNEL_MAP.tws)).toBe(true);   // TWS → '--'
    expect(isChannelStale(METRIC_CHANNEL_MAP.twa)).toBe(false);  // TWA → shows value
  });

  it('AWA stale + AWS fresh: AWA channel stale, AWS channel fresh', () => {
    useFreshnessStore.getState().setStaleChannels([METRIC_CHANNEL_MAP.awa]); // ch44 only
    const { isChannelStale } = useFreshnessStore.getState();
    expect(isChannelStale(METRIC_CHANNEL_MAP.awa)).toBe(true);
    expect(isChannelStale(METRIC_CHANNEL_MAP.aws)).toBe(false);
  });

  it('AWS stale + AWA fresh: AWS channel stale, AWA channel fresh', () => {
    useFreshnessStore.getState().setStaleChannels([METRIC_CHANNEL_MAP.aws]); // ch46 only
    const { isChannelStale } = useFreshnessStore.getState();
    expect(isChannelStale(METRIC_CHANNEL_MAP.aws)).toBe(true);
    expect(isChannelStale(METRIC_CHANNEL_MAP.awa)).toBe(false);
  });

  it('Both TWA and TWS stale: both channels stale', () => {
    useFreshnessStore.getState().setStaleChannels([
      METRIC_CHANNEL_MAP.twa,
      METRIC_CHANNEL_MAP.tws,
    ]);
    const { isChannelStale } = useFreshnessStore.getState();
    expect(isChannelStale(METRIC_CHANNEL_MAP.twa)).toBe(true);
    expect(isChannelStale(METRIC_CHANNEL_MAP.tws)).toBe(true);
  });

  it('After both TWA/TWS stale then data resumes (empty staleChannels), both become fresh', () => {
    useFreshnessStore.getState().setStaleChannels([
      METRIC_CHANNEL_MAP.twa,
      METRIC_CHANNEL_MAP.tws,
    ]);
    useFreshnessStore.getState().setStaleChannels([]); // data resumed
    const { isChannelStale } = useFreshnessStore.getState();
    expect(isChannelStale(METRIC_CHANNEL_MAP.twa)).toBe(false);
    expect(isChannelStale(METRIC_CHANNEL_MAP.tws)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FE1: Freshness store — gofree:freshness event simulation
// Verifies the store behaves correctly when driven by event payloads that
// mirror what GoFreeManager emits (as wired in ipc-handlers.ts).
// ---------------------------------------------------------------------------
describe('FE1: Freshness store — driven by gofree:freshness event payloads', () => {
  afterEach(() => {
    useFreshnessStore.setState({ staleChannels: new Set() });
  });

  it('fast-group tick with no stale channels → all fast channels fresh', () => {
    const event: GoFreeFreshnessEvent = { staleChannels: [] };
    useFreshnessStore.getState().setStaleChannels(event.staleChannels);
    const { isChannelStale } = useFreshnessStore.getState();
    // Fast group: BSPD=42, TWA=45, TWS=47, AWA=44, AWS=46
    for (const ch of [42, 45, 47, 44, 46]) {
      expect(isChannelStale(ch)).toBe(false);
    }
  });

  it('event with all fast channels stale → all 5 fast channels stale', () => {
    const event: GoFreeFreshnessEvent = { staleChannels: [42, 44, 45, 46, 47] };
    useFreshnessStore.getState().setStaleChannels(event.staleChannels);
    const { isChannelStale } = useFreshnessStore.getState();
    for (const ch of [42, 44, 45, 46, 47]) {
      expect(isChannelStale(ch)).toBe(true);
    }
    // Normal group must remain fresh
    for (const ch of [41, 9, 37]) {
      expect(isChannelStale(ch)).toBe(false);
    }
  });

  it('subsequent event with subset of channels stale replaces prior set', () => {
    useFreshnessStore.getState().setStaleChannels([42, 44, 45, 46, 47]);
    // Next tick: only TWA is still stale
    const nextEvent: GoFreeFreshnessEvent = { staleChannels: [45] };
    useFreshnessStore.getState().setStaleChannels(nextEvent.staleChannels);
    const { isChannelStale } = useFreshnessStore.getState();
    expect(isChannelStale(45)).toBe(true);
    expect(isChannelStale(42)).toBe(false);
    expect(isChannelStale(44)).toBe(false);
    expect(isChannelStale(46)).toBe(false);
    expect(isChannelStale(47)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FE2: ConnectionBar isConnected logic — 'stale' state behaves like connected
// (the WebSocket is still open; Disconnect should remain available)
// ---------------------------------------------------------------------------
describe('FE2: ConnectionBar isConnected logic for GoFree stale state', () => {
  function gofreeIsConnected(state: GofreeStatusPayload['state'] | undefined): boolean {
    // Mirrors the logic in ConnectionBar.tsx for isGoFree=true branch
    return state === 'connected' || state === 'stale';
  }

  it('connected → isConnected=true', () => {
    expect(gofreeIsConnected('connected')).toBe(true);
  });

  it('stale → isConnected=true (socket is open; Disconnect must be available)', () => {
    expect(gofreeIsConnected('stale')).toBe(true);
  });

  it('reconnecting → isConnected=false', () => {
    expect(gofreeIsConnected('reconnecting')).toBe(false);
  });

  it('disconnected → isConnected=false', () => {
    expect(gofreeIsConnected('disconnected')).toBe(false);
  });

  it('connecting → isConnected=false', () => {
    expect(gofreeIsConnected('connecting')).toBe(false);
  });

  it('undefined → isConnected=false (not yet received status event)', () => {
    expect(gofreeIsConnected(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regression: existing Phase 2.7 chip behavior is unaffected
// ---------------------------------------------------------------------------
describe('Regression: Phase 2.7 chip behavior unchanged after hardening', () => {
  it('connected label still shows ip:port', () => {
    const payload: GofreeStatusPayload = { state: 'connected', ip: '192.168.1.233', port: 2053 };
    expect(getGofreeStatusLabel(payload)).toBe('GoFree — Connected (192.168.1.233:2053)');
  });

  it('disconnected label unchanged', () => {
    expect(getGofreeStatusLabel({ state: 'disconnected' })).toBe('GoFree — Disconnected');
  });

  it('null payload returns disconnected label', () => {
    expect(getGofreeStatusLabel(null)).toBe('GoFree — Disconnected');
  });

  it('reconnecting color is still pulsing amber', () => {
    expect(getGofreeStatusColor('reconnecting')).toContain('animate-pulse');
  });

  it('error color is still red', () => {
    expect(getGofreeStatusColor('error')).toBe('bg-n2k-danger');
  });
});
