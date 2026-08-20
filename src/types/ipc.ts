export interface ConnectionStatus {
  mode?: 'serial' | 'tcp';
  port?: string;
  baud?: number;
  host?: string;
  tcpPort?: number;
  status: 'disconnected' | 'connecting' | 'connected' | 'error';
  error?: string;
}

export interface RecordingStatus {
  active: boolean;
  elapsed: number;
  count: number;
  fileSize: number;
}

export interface PolarPerformance {
  percentPolar: number | null;
  targetSpeed: number | null;
  actualSpeed: number | null;
}

export type DataSource = 'ngt1' | 'gofree';

export type GofreeState = 'searching' | 'connecting' | 'connected' | 'stale' | 'reconnecting' | 'error' | 'disconnected';

export interface GofreeStatusPayload {
  state: GofreeState;
  ip?: string;
  port?: number;
  error?: string;
}

/**
 * GoFree per-value freshness event (BE2/BE5).
 * Channel IDs whose last valid observation is older than 2× their group's poll interval.
 * Fast channels (BSP/TWA/TWS/AWA/AWS): stale after ~400 ms.
 * Normal channels (SOG/COG/HDG/VMG/LEE/LAT/LON): stale after ~2 000 ms.
 */
export interface GoFreeFreshnessEvent {
  staleChannels: number[];
}

export interface AppSettings {
  serialPort: string;
  serialBaud: number;
  pgnFilter: number[];
  sourcePreferences: Record<number, number>; // PGN → preferred source address
  dataDirectory: string;
  polarDirectory: string;
  activePolarProfile?: number;
  connectionMode?: 'serial' | 'tcp';
  tcpHost?: string;
  tcpPort?: number;
  sailInventory?: Array<{ id: string; label: string }>;
  // Phase 2.7 — GoFree data source
  dataSource?: DataSource;
  gofreeHost?: string;
  gofreePort?: number;
}

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  productId?: string;
  vendorId?: string;
}
