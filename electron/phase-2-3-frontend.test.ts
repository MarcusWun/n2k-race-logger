import { describe, expect, it } from 'vitest';
import { formatWindAngle, normalizedWindAngleValue } from '../src/utils/angles';
import { EMPTY_POLAR_PERFORMANCE, prepareLivePolarPerformancePayload, requestLivePolarPerformance } from '../src/utils/livePolarPerformance';
import { sanitizeTcpHost, validateTcpTarget } from '../src/utils/tcp';

describe('Phase 2.3 frontend AWA/TWA normalization', () => {
  it('formats relative wind angles as 0-180° with port/starboard side', () => {
    expect(formatWindAngle(45)).toBe('45°S');
    expect(formatWindAngle(180)).toBe('180°S');
    expect(formatWindAngle(315)).toBe('45°P');
    expect(formatWindAngle(359)).toBe('1°P');
  });

  it('normalizes chart/export numeric values without exposing raw port-side 0-360° angles', () => {
    expect(normalizedWindAngleValue(315)).toBe(45);
    expect(normalizedWindAngleValue(270)).toBe(90);
    expect(normalizedWindAngleValue(181)).toBe(179);
  });

  it('normalizes dashboard live polar requests before lookup', () => {
    expect(prepareLivePolarPerformancePayload(
      { stw: 6, tws: 12, twa: 315 },
      7,
    )).toEqual({ stw: 6, tws: 12, twa: 45, profileId: 7 });
  });

  it('does not request dashboard live polar performance without required inputs or profile', async () => {
    const calls: unknown[] = [];
    const updates: unknown[] = [];

    const payload = await requestLivePolarPerformance(
      { getPerformance: async (request) => { calls.push(request); return { percentPolar: 100, targetSpeed: 6, actualSpeed: 6 }; } },
      { stw: 6, tws: null, twa: 90 },
      7,
      (performance) => updates.push(performance),
    );

    expect(payload).toBeNull();
    expect(calls).toHaveLength(0);
    expect(updates).toEqual([EMPTY_POLAR_PERFORMANCE]);
  });

  it('invokes dashboard live polar performance when STW/TWS/TWA and active profile are present', async () => {
    const calls: unknown[] = [];
    const updates: unknown[] = [];

    const payload = await requestLivePolarPerformance(
      { getPerformance: async (request) => {
        calls.push(request);
        return { percentPolar: 94, targetSpeed: 6.4, actualSpeed: 6 };
      } },
      { stw: 6, tws: 12, twa: 90 },
      7,
      (performance) => updates.push(performance),
    );

    expect(payload).toEqual({ stw: 6, tws: 12, twa: 90, profileId: 7 });
    expect(calls).toEqual([payload]);
    expect(updates).toEqual([{ percentPolar: 94, targetSpeed: 6.4, actualSpeed: 6 }]);
  });
});

describe('Phase 2.3 TCP settings validation', () => {
  it('preserves the default TCP target', () => {
    const target = validateTcpTarget('192.168.1.1', 2000);
    expect(target).toEqual({ ok: true, host: '192.168.1.1', tcpPort: 2000 });
  });

  it('sanitizes trailing dots and whitespace before save/connect', () => {
    expect(sanitizeTcpHost(' 192.168.1.1. ')).toBe('192.168.1.1');
    const target = validateTcpTarget(' 192.168.1.1. ', '2000');
    expect(target).toEqual({ ok: true, host: '192.168.1.1', tcpPort: 2000 });
  });

  it('rejects malformed truncated host 192.168.1 instead of saving/connecting it', () => {
    const target = validateTcpTarget('192.168.1', 2000);
    expect(target.ok).toBe(false);
    if (!target.ok) expect(target.error).toContain('Malformed TCP host');
  });

  it('rejects invalid TCP ports', () => {
    expect(validateTcpTarget('192.168.1.1', 0).ok).toBe(false);
    expect(validateTcpTarget('192.168.1.1', 65536).ok).toBe(false);
    expect(validateTcpTarget('192.168.1.1', 'abc').ok).toBe(false);
  });
});
