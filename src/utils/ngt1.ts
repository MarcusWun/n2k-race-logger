import type { ConnectionStatus } from '../types/ipc';

/**
 * Returns the human-readable label for a NGT-1 connection status.
 * Mirrors getGofreeStatusLabel() convention from src/utils/gofree.ts.
 */
export function getNgt1StatusLabel(status: ConnectionStatus | null): string {
  if (!status) return 'NGT-1 — Disconnected';
  switch (status.status) {
    case 'connecting':
      return 'NGT-1 — Connecting...';
    case 'connected':
      return 'NGT-1 — Connected';
    case 'stale':
      // PRD §3.1 / FE1: port open but no valid PGN within watchdog timeout.
      return 'NGT-1 — Stale (no data)';
    case 'error':
      return `NGT-1 — Error: ${status.error ?? 'Unknown error'}`;
    case 'disconnected':
    default:
      return 'NGT-1 — Disconnected';
  }
}

/**
 * Returns the Tailwind dot-color class for a NGT-1 connection state.
 * Mirrors getGofreeStatusColor() convention from src/utils/gofree.ts.
 *
 * 'stale' → steady amber (bg-n2k-warning, no pulse) — port open, silent instrument network.
 * 'connecting' → pulsing amber.
 * 'connected' → green.
 * 'error' → red.
 * 'disconnected' / unknown → gray.
 */
export function getNgt1StatusColor(statusStr: string | undefined): string {
  switch (statusStr) {
    case 'connected':
      return 'bg-n2k-success';
    case 'stale':
      // Steady amber — transport live, no data.  No animate-pulse (mirrors GoFree stale).
      return 'bg-n2k-warning';
    case 'connecting':
      return 'bg-n2k-warning animate-pulse';
    case 'error':
      return 'bg-n2k-danger';
    case 'disconnected':
    default:
      return 'bg-gray-500';
  }
}

/**
 * Format a recovered_end_time ISO string as HH:MM:SS (local time).
 * Used in the interrupted-recording banner (FE2).
 */
export function formatRecoveredTime(isoTimestamp: string | null | undefined): string {
  if (!isoTimestamp) return '??:??:??';
  try {
    const d = new Date(isoTimestamp);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  } catch {
    return '??:??:??';
  }
}

/**
 * Format a data_source + port/ip into a human-readable source label (FE4).
 * e.g. 'ngt1' + 'COM4' → 'NGT-1 (COM4)'
 *      'gofree' + '192.168.1.233' → 'GoFree (192.168.1.233)'
 */
export function formatProvenanceSource(
  dataSource: 'ngt1' | 'gofree' | string | null | undefined,
  serialPort: string | null | undefined,
  h5000Ip: string | null | undefined,
): string {
  if (dataSource === 'ngt1') {
    return serialPort ? `NGT-1 (${serialPort})` : 'NGT-1';
  }
  if (dataSource === 'gofree') {
    return h5000Ip ? `GoFree (${h5000Ip})` : 'GoFree';
  }
  return dataSource ?? 'Unknown';
}
