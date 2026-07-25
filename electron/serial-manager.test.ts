import { describe, it, expect } from 'vitest';
import { sanitizeTcpHost, sanitizeTcpPort } from './serial-manager';

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
