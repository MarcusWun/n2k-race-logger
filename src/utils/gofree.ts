import type { GofreeStatusPayload, GofreeState } from '../types/ipc';
import { sanitizeTcpHost, parseTcpPort, validateTcpTarget } from './tcp';

const DEFAULT_GOFREE_HOST = '192.168.1.233';
const DEFAULT_GOFREE_PORT = 2053;

/** Returns the human-readable label for a GoFree connection status payload. */
export function getGofreeStatusLabel(status: GofreeStatusPayload | null): string {
  if (!status) return 'GoFree — Disconnected';
  switch (status.state) {
    case 'searching':
      return 'GoFree — Searching...';
    case 'connecting':
      return 'GoFree — Connecting...';
    case 'connected': {
      const ip = status.ip ?? DEFAULT_GOFREE_HOST;
      const port = status.port ?? DEFAULT_GOFREE_PORT;
      return `GoFree — Connected (${ip}:${port})`;
    }
    case 'reconnecting':
      return 'GoFree — Reconnecting...';
    case 'error':
      return `GoFree — Error: ${status.error ?? 'Unknown error'}`;
    case 'disconnected':
    default:
      return 'GoFree — Disconnected';
  }
}

/** Returns the Tailwind color class for a GoFree connection state (mirrors NGT-1 chip colors). */
export function getGofreeStatusColor(state: GofreeState | undefined): string {
  switch (state) {
    case 'connected':
      return 'bg-n2k-success';
    case 'connecting':
    case 'searching':
    case 'reconnecting':
      return 'bg-n2k-warning animate-pulse';
    case 'error':
      return 'bg-n2k-danger';
    case 'disconnected':
    default:
      return 'bg-gray-500';
  }
}

export function sanitizeGofreeHost(host: string | undefined | null): string {
  return sanitizeTcpHost(host);
}

export function parseGofreePort(port: number | string | undefined | null): number | null {
  return parseTcpPort(port);
}

/** Validate a GoFree IP + port target (same rules as TCP, different defaults). */
export function validateGofreeTarget(
  hostInput: string | undefined | null,
  portInput: number | string | undefined | null,
): { ok: true; host: string; port: number } | { ok: false; host: string; port: number | null; error: string } {
  const result = validateTcpTarget(
    hostInput || DEFAULT_GOFREE_HOST,
    portInput ?? DEFAULT_GOFREE_PORT,
  );
  if (result.ok) {
    return { ok: true, host: result.host, port: result.tcpPort };
  }
  return { ok: false, host: result.host, port: result.tcpPort, error: result.error };
}
