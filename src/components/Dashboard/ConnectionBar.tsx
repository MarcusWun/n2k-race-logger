import React, { useState, useEffect, useCallback } from 'react';
import { getIPC } from '../../ipc';
import { useConnectionStore } from '../../store/useConnectionStore';
import type { ConnectionStatus, SerialPortInfo } from '../../types/ipc';

export default function ConnectionBar() {
  const {
    mode, setMode,
    selectedPort, setSelectedPort,
    baudRate, setBaudRate,
    tcpHost, setTcpHost,
    tcpPort, setTcpPort,
    status, setStatus,
  } = useConnectionStore();

  // ports is transient OS state — local useState is fine
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);

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

    // Load saved settings for mode/tcp — only when disconnected to avoid overriding active state
    ipc.getSettings().then((s: any) => {
      if (status.status === 'disconnected') {
        if (s?.connectionMode) setMode(s.connectionMode);
        if (s?.tcpHost) setTcpHost(s.tcpHost.trim().replace(/\.+$/, ''));
        if (s?.tcpPort) setTcpPort(s.tcpPort);
        if (s?.serialPort) setSelectedPort(s.serialPort);
        if (s?.serialBaud) setBaudRate(s.serialBaud);
      }
    });

    const unsub = ipc.on('connection:status', (s: ConnectionStatus) => {
      setStatus(s);
    });
    return () => { unsub(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshPorts]);

  const handleConnect = async () => {
    const ipc = getIPC();
    if (!ipc) return;
    if (status.status === 'connected') {
      await ipc.disconnect();
    } else {
      await ipc.connect(
        mode === 'serial'
          ? { mode: 'serial', port: selectedPort, baud: baudRate }
          : { mode: 'tcp', host: tcpHost.trim().replace(/\.+$/, ''), tcpPort: tcpPort },
      );
    }
  };

  const handleDebug = () => {
    const ipc = getIPC();
    if (ipc) ipc.openDebug();
  };

  const isConnected = status.status === 'connected';

  const statusColor = {
    disconnected: 'bg-gray-500',
    connecting: 'bg-n2k-warning animate-pulse',
    connected: 'bg-n2k-success',
    error: 'bg-n2k-danger',
  }[status.status];

  return (
    <div className="flex items-center gap-3 bg-n2k-surface rounded-lg px-4 py-2 flex-wrap">
      <div className={`w-3 h-3 rounded-full ${statusColor}`} />
      <span className="text-xs text-gray-400 uppercase tracking-wider">
        {status.status}
      </span>

      {/* Mode toggle */}
      <div className="flex rounded overflow-hidden border border-gray-700">
        <button
          onClick={() => setMode('serial')}
          disabled={isConnected}
          className={`px-3 py-1 text-xs font-medium ${
            mode === 'serial' ? 'bg-n2k-accent text-black' : 'bg-n2k-bg text-gray-400'
          }`}
        >
          Serial
        </button>
        <button
          onClick={() => setMode('tcp')}
          disabled={isConnected}
          className={`px-3 py-1 text-xs font-medium ${
            mode === 'tcp' ? 'bg-n2k-accent text-black' : 'bg-n2k-bg text-gray-400'
          }`}
        >
          TCP
        </button>
      </div>

      {mode === 'serial' ? (
        <>
          <select
            value={selectedPort}
            onChange={(e) => setSelectedPort(e.target.value)}
            disabled={isConnected}
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
            disabled={isConnected}
            className="text-gray-400 hover:text-white text-sm px-1"
            title="Refresh ports"
          >
            ↻
          </button>

          <select
            value={baudRate}
            onChange={(e) => setBaudRate(Number(e.target.value))}
            disabled={isConnected}
            className="bg-n2k-bg border border-gray-700 rounded px-2 py-1 text-sm text-white"
          >
            {[4800, 9600, 38400, 115200].map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </>
      ) : (
        <>
          <input
            type="text"
            value={tcpHost}
            onChange={(e) => setTcpHost(e.target.value)}
            disabled={isConnected}
            placeholder="IP address"
            className="bg-n2k-bg border border-gray-700 rounded px-2 py-1 text-sm text-white w-32"
          />
          <span className="text-gray-500 text-sm">:</span>
          <input
            type="number"
            value={tcpPort}
            onChange={(e) => setTcpPort(Number(e.target.value))}
            disabled={isConnected}
            placeholder="Port"
            className="bg-n2k-bg border border-gray-700 rounded px-2 py-1 text-sm text-white w-20"
          />
        </>
      )}

      <button
        onClick={handleConnect}
        className={`px-4 py-1 rounded text-sm font-medium ${
          isConnected
            ? 'bg-n2k-danger hover:bg-red-600'
            : 'bg-n2k-accent hover:bg-cyan-400 text-black'
        }`}
      >
        {isConnected ? 'Disconnect' : 'Connect'}
      </button>

      <button
        onClick={handleDebug}
        className="px-3 py-1 rounded text-sm font-medium bg-gray-700 hover:bg-gray-600 text-gray-300"
        title="Open debug window"
      >
        Debug
      </button>

      {status.error && (
        <span className="text-n2k-danger text-xs ml-2">{status.error}</span>
      )}
    </div>
  );
}
