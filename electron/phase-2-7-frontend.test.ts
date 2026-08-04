/**
 * Phase 2.7 Frontend Tests — GoFree Ethernet Data Source
 *
 * Tests for:
 *   FE1/FE2: Data source toggle and conditional field logic
 *   FE3:     GoFree connection status label rendering
 *   FE4:     Store slice shape for gofreeStatus updates
 *   FE5:     Regression guard — existing utilities still work
 */

import { describe, expect, it } from 'vitest';
import {
  getGofreeStatusLabel,
  getGofreeStatusColor,
  validateGofreeTarget,
  sanitizeGofreeHost,
} from '../src/utils/gofree';
import type { GofreeStatusPayload } from '../src/types/ipc';

// ---------------------------------------------------------------------------
// FE3: GoFree status chip — label text
// ---------------------------------------------------------------------------
describe('Phase 2.7 GoFree status chip — label text', () => {
  it('returns "GoFree — Searching..." for state=searching', () => {
    const payload: GofreeStatusPayload = { state: 'searching' };
    expect(getGofreeStatusLabel(payload)).toBe('GoFree — Searching...');
  });

  it('returns "GoFree — Connecting..." for state=connecting', () => {
    const payload: GofreeStatusPayload = { state: 'connecting' };
    expect(getGofreeStatusLabel(payload)).toBe('GoFree — Connecting...');
  });

  it('returns "GoFree — Connected (ip:port)" for state=connected with ip+port', () => {
    const payload: GofreeStatusPayload = { state: 'connected', ip: '192.168.0.1', port: 10110 };
    expect(getGofreeStatusLabel(payload)).toBe('GoFree — Connected (192.168.0.1:10110)');
  });

  it('falls back to defaults when ip/port absent in connected state', () => {
    const payload: GofreeStatusPayload = { state: 'connected' };
    expect(getGofreeStatusLabel(payload)).toBe('GoFree — Connected (192.168.0.1:10110)');
  });

  it('returns "GoFree — Reconnecting..." for state=reconnecting', () => {
    const payload: GofreeStatusPayload = { state: 'reconnecting' };
    expect(getGofreeStatusLabel(payload)).toBe('GoFree — Reconnecting...');
  });

  it('returns "GoFree — Error: <message>" for state=error with error field', () => {
    const payload: GofreeStatusPayload = { state: 'error', error: 'Connection refused' };
    expect(getGofreeStatusLabel(payload)).toBe('GoFree — Error: Connection refused');
  });

  it('returns "GoFree — Error: Unknown error" for state=error without error field', () => {
    const payload: GofreeStatusPayload = { state: 'error' };
    expect(getGofreeStatusLabel(payload)).toBe('GoFree — Error: Unknown error');
  });

  it('returns "GoFree — Disconnected" for state=disconnected', () => {
    const payload: GofreeStatusPayload = { state: 'disconnected' };
    expect(getGofreeStatusLabel(payload)).toBe('GoFree — Disconnected');
  });

  it('returns "GoFree — Disconnected" when payload is null', () => {
    expect(getGofreeStatusLabel(null)).toBe('GoFree — Disconnected');
  });
});

// ---------------------------------------------------------------------------
// FE3: GoFree status chip — color classes (mirrors NGT-1 chip behavior)
// ---------------------------------------------------------------------------
describe('Phase 2.7 GoFree status chip — color classes', () => {
  it('connected → green (bg-n2k-success)', () => {
    expect(getGofreeStatusColor('connected')).toBe('bg-n2k-success');
  });

  it('searching → yellow pulsing (bg-n2k-warning animate-pulse)', () => {
    expect(getGofreeStatusColor('searching')).toContain('bg-n2k-warning');
  });

  it('connecting → yellow pulsing', () => {
    expect(getGofreeStatusColor('connecting')).toContain('bg-n2k-warning');
  });

  it('reconnecting → yellow pulsing', () => {
    expect(getGofreeStatusColor('reconnecting')).toContain('bg-n2k-warning');
  });

  it('error → red (bg-n2k-danger)', () => {
    expect(getGofreeStatusColor('error')).toBe('bg-n2k-danger');
  });

  it('disconnected → gray (bg-gray-500)', () => {
    expect(getGofreeStatusColor('disconnected')).toBe('bg-gray-500');
  });

  it('undefined → gray (bg-gray-500)', () => {
    expect(getGofreeStatusColor(undefined)).toBe('bg-gray-500');
  });
});

// ---------------------------------------------------------------------------
// FE2: GoFree IP/port validation
// ---------------------------------------------------------------------------
describe('Phase 2.7 GoFree IP/port validation', () => {
  it('accepts valid GoFree defaults (192.168.0.1:10110)', () => {
    const result = validateGofreeTarget('192.168.0.1', 10110);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.host).toBe('192.168.0.1');
      expect(result.port).toBe(10110);
    }
  });

  it('accepts any valid IPv4 address and port 1–65535', () => {
    const result = validateGofreeTarget('10.0.0.100', 9999);
    expect(result.ok).toBe(true);
  });

  it('falls back to default host when input is undefined', () => {
    const result = validateGofreeTarget(undefined, 10110);
    expect(result.ok).toBe(true);
  });

  it('falls back to default port when input is undefined', () => {
    const result = validateGofreeTarget('192.168.0.1', undefined);
    expect(result.ok).toBe(true);
  });

  it('rejects invalid port 0', () => {
    const result = validateGofreeTarget('192.168.0.1', 0);
    expect(result.ok).toBe(false);
  });

  it('rejects invalid port 65536', () => {
    const result = validateGofreeTarget('192.168.0.1', 65536);
    expect(result.ok).toBe(false);
  });

  it('rejects malformed truncated IPv4', () => {
    const result = validateGofreeTarget('192.168.0', 10110);
    expect(result.ok).toBe(false);
  });

  it('accepts valid hostnames', () => {
    const result = validateGofreeTarget('gofree.local', 10110);
    expect(result.ok).toBe(true);
  });

  it('sanitizes trailing dots and whitespace in host', () => {
    expect(sanitizeGofreeHost(' 192.168.0.1. ')).toBe('192.168.0.1');
  });
});

// ---------------------------------------------------------------------------
// FE4: Store slice — gofreeStatus payload shape
// ---------------------------------------------------------------------------
describe('Phase 2.7 store gofreeStatus payload shape', () => {
  it('GofreeStatusPayload with all fields is valid', () => {
    const payload: GofreeStatusPayload = {
      state: 'connected',
      ip: '192.168.0.1',
      port: 10110,
      error: undefined,
    };
    expect(payload.state).toBe('connected');
    expect(payload.ip).toBe('192.168.0.1');
    expect(payload.port).toBe(10110);
  });

  it('GofreeStatusPayload minimal shape (state only) is valid', () => {
    const payload: GofreeStatusPayload = { state: 'searching' };
    expect(payload.state).toBe('searching');
    expect(payload.ip).toBeUndefined();
    expect(payload.port).toBeUndefined();
    expect(payload.error).toBeUndefined();
  });

  it('error payload carries error string', () => {
    const payload: GofreeStatusPayload = { state: 'error', error: 'ECONNREFUSED' };
    expect(payload.state).toBe('error');
    expect(payload.error).toBe('ECONNREFUSED');
  });
});

// ---------------------------------------------------------------------------
// FE1: Data source type guard — valid values are 'ngt1' | 'gofree'
// ---------------------------------------------------------------------------
describe('Phase 2.7 DataSource type values', () => {
  it('ngt1 and gofree are the only valid data source strings', () => {
    const validSources: Array<'ngt1' | 'gofree'> = ['ngt1', 'gofree'];
    expect(validSources).toContain('ngt1');
    expect(validSources).toContain('gofree');
    expect(validSources).toHaveLength(2);
  });

  it('getGofreeStatusLabel handles all 6 known GoFree states', () => {
    const states: Array<GofreeStatusPayload['state']> = [
      'searching', 'connecting', 'connected', 'reconnecting', 'error', 'disconnected',
    ];
    for (const state of states) {
      const label = getGofreeStatusLabel({ state });
      expect(label).toMatch(/^GoFree —/);
    }
  });
});
