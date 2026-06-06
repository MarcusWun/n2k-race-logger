import React, { useState, useEffect, useCallback } from 'react';
import { getIPC } from '../../ipc';
import type { ConnectionStatus, SerialPortInfo } from '../../types/ipc';

export default function ConnectionBar() {
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [selectedPort, setSelectedPort] = useState('COM3');
  const [baudRate, setBaudRate] = useState(115200);
  const [status, setStatus] = useState<ConnectionStatus>({
    port: 'COM3',
    baud: 115200,
    status: 'disconnected',
  });

  const refreshPorts = useCallback(async () => {
    const ipc = getIPC();
    if (!ipc) return;
    const result = await ipc.listPorts();
    if (Array.isArray(result)) setPorts(result);
  }, []);

  useEffect(() => {
    refreshPorts();
    const ipc = getIPC();
    if (!ipc) return;
    const unsub = ipc.on('connection:status', (s: ConnectionStatus) => {
      setStatus(s);
    });
    return () => { unsub(); };
  }, [refreshPorts]);

  const handleConnect = async () => {
    const ipc = getIPC();
    if (!ipc) return;
    if (status.status === 'connected') {
      await ipc.disconnect();
    } else {
      await ipc.connect({ port: selectedPort, baud: baudRate });
    }
  };

  const statusColor = {
    disconnected: 'bg-gray-500',
    connecting: 'bg-n2k-warning animate-pulse',
    connected: 'bg-n2k-success',
    error: 'bg-n2k-danger',
  }[status.status];

  return (
    <div className="flex items-center gap-3 bg-n2k-surface rounded-lg px-4 py-2">
      <div className={`w-3 h-3 rounded-full ${statusColor}`} />
      <span className="text-xs text-gray-400 uppercase tracking-wider">
        {status.status}
      </span>

      <select
        value={selectedPort}
        onChange={(e) => setSelectedPort(e.target.value)}
        disabled={status.status === 'connected'}
        className="bg-n2k-bg border border-gray-700 rounded px-2 py-1 text-sm text-white"
      >
        {ports.length === 0 && <option value={selectedPort}>{selectedPort}</option>}
        {ports.map((p) => (
          <option key={p.path} value={p.path}>
            {p.path} {p.manufacturer ? `(${p.manufacturer})` : ''}
          </option>
        ))}
      </select>

      <button
        onClick={refreshPorts}
        disabled={status.status === 'connected'}
        className="text-gray-400 hover:text-white text-sm px-1"
        title="Refresh ports"
      >
        ↻
      </button>

      <select
        value={baudRate}
        onChange={(e) => setBaudRate(Number(e.target.value))}
        disabled={status.status === 'connected'}
        className="bg-n2k-bg border border-gray-700 rounded px-2 py-1 text-sm text-white"
      >
        {[4800, 9600, 38400, 115200].map((b) => (
          <option key={b} value={b}>{b}</option>
        ))}
      </select>

      <button
        onClick={handleConnect}
        className={`px-4 py-1 rounded text-sm font-medium ${
          status.status === 'connected'
            ? 'bg-n2k-danger hover:bg-red-600'
            : 'bg-n2k-accent hover:bg-cyan-400 text-black'
        }`}
      >
        {status.status === 'connected' ? 'Disconnect' : 'Connect'}
      </button>

      {status.error && (
        <span className="text-n2k-danger text-xs ml-2">{status.error}</span>
      )}
    </div>
  );
}
