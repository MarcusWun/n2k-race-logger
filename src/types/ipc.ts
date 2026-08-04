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

export type GofreeState = 'searching' | 'connecting' | 'connected' | 'reconnecting' | 'error' | 'disconnected';

export interface GofreeStatusPayload {
  state: GofreeState;
  ip?: string;
  port?: number;
  error?: string;
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
