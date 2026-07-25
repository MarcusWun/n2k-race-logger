const DEFAULT_TCP_HOST = '192.168.1.1';
const DEFAULT_TCP_PORT = 2000;

export function sanitizeTcpHost(host: string | undefined | null): string {
  return String(host ?? '').trim().replace(/\.+$/, '');
}

export function parseTcpPort(port: number | string | undefined | null): number | null {
  if (typeof port === 'number' && Number.isInteger(port)) return port;
  const raw = String(port ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

export function validateTcpTarget(hostInput: string | undefined | null, portInput: number | string | undefined | null): { ok: true; host: string; tcpPort: number } | { ok: false; host: string; tcpPort: number | null; error: string } {
  const host = sanitizeTcpHost(hostInput);
  const tcpPort = parseTcpPort(portInput);

  if (!host) {
    return { ok: false, host, tcpPort, error: `TCP host is required. Default is ${DEFAULT_TCP_HOST}:${DEFAULT_TCP_PORT}.` };
  }

  const ipv4Parts = host.split('.');
  const looksLikePartialIpv4 = /^\d+(\.\d+){0,2}$/.test(host);
  const isIpv4 = ipv4Parts.length === 4 && ipv4Parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
  const isHostname = /^(?=.{1,253}$)(?!-)[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*(?<!-)$/.test(host) && /[A-Za-z]/.test(host);

  if (looksLikePartialIpv4 || (!isIpv4 && !isHostname)) {
    return { ok: false, host, tcpPort, error: `Malformed TCP host "${host}". Use a full IPv4 address such as ${DEFAULT_TCP_HOST} or a valid hostname.` };
  }

  if (tcpPort == null || tcpPort < 1 || tcpPort > 65535) {
    return { ok: false, host, tcpPort, error: `TCP port must be a whole number from 1 to 65535. Default is ${DEFAULT_TCP_PORT}.` };
  }

  return { ok: true, host, tcpPort };
}
