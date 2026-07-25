import { describe, expect, it } from 'vitest';
import { formatWindAngle, normalizedWindAngleValue } from '../src/utils/angles';
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
