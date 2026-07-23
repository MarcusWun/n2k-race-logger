import { create } from 'zustand';
import type { ConnectionStatus } from '../types/ipc';

type ConnectionMode = 'serial' | 'tcp';

interface ConnectionStore {
  mode: ConnectionMode;
  selectedPort: string;
  baudRate: number;
  tcpHost: string;
  tcpPort: number;
  status: ConnectionStatus;
  setMode: (mode: ConnectionMode) => void;
  setSelectedPort: (port: string) => void;
  setBaudRate: (baud: number) => void;
  setTcpHost: (host: string) => void;
  setTcpPort: (port: number) => void;
  setStatus: (status: ConnectionStatus) => void;
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  mode: 'serial',
  selectedPort: 'COM3',
  baudRate: 115200,
  tcpHost: '192.168.1.1',
  tcpPort: 2000,
  status: { port: 'COM3', baud: 115200, status: 'disconnected' },
  setMode: (mode) => set({ mode }),
  setSelectedPort: (port) => set({ selectedPort: port }),
  setBaudRate: (baud) => set({ baudRate: baud }),
  setTcpHost: (host) => set({ tcpHost: host }),
  setTcpPort: (port) => set({ tcpPort: port }),
  setStatus: (status) => set({ status }),
}));
