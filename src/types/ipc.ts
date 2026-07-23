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
}

export interface SerialPortInfo {
  path: string;
  manufacturer?: string;
  productId?: string;
  vendorId?: string;
}
