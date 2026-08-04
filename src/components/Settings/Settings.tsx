import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../../store/useSettings';
import { usePolarStore } from '../../store/usePolarStore';
import { useConnectionStore } from '../../store/useConnectionStore';
import { getIPC } from '../../ipc';
import { DEFAULT_PGN_FILTER, PGN_NAMES } from '../../types/n2k-pgns';
import type { AppSettings, DataSource } from '../../types/ipc';
import type { BoatProfile } from '../../types/polar';
import { sanitizeTcpHost, validateTcpTarget } from '../../utils/tcp';
import { sanitizeGofreeHost, validateGofreeTarget } from '../../utils/gofree';

export default function Settings() {
  const { settings, setSettings } = useSettingsStore();
  const { profiles, setProfiles } = usePolarStore();
  const setStoreDataSource = useConnectionStore((s) => s.setDataSource);
  const [draft, setDraft] = useState<AppSettings>({ ...settings });
  const [ports, setPorts] = useState<Array<{ path: string; manufacturer?: string }>>([]);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadWarning, setLoadWarning] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [discoveredSources, setDiscoveredSources] = useState<Record<number, number[]>>({});

  useEffect(() => {
    const ipc = getIPC();
    if (!ipc) { setLoaded(true); return; }

    ipc.getSettings().then((s: AppSettings & { _loadError?: string }) => {
      if (s) {
        if (s._loadError) {
          setLoadWarning(s._loadError);
        }
        const { _loadError: _ignored, ...cleanSettings } = s as any;
        setSettings(cleanSettings);
        setDraft({ ...cleanSettings, sourcePreferences: cleanSettings.sourcePreferences ?? {} });
      }
      setLoaded(true);
    });
    ipc.listPorts().then((p: any[]) => {
      if (Array.isArray(p)) setPorts(p);
    });
    ipc.listPolars().then((p: BoatProfile[]) => {
      if (Array.isArray(p)) setProfiles(p);
    });
    ipc.getSources().then((sources: Record<number, number[]>) => {
      if (sources) setDiscoveredSources(sources);
    });

    const unsub = ipc.on('sources:discovered', (sources: Record<number, number[]>) => {
      setDiscoveredSources(sources);
    });
    const unsubSettingsError = ipc.on('settings:error', (msg: { error?: string }) => {
      setSaveError(msg?.error || 'Settings persistence error.');
    });
    return () => { if (unsub) unsub(); if (unsubSettingsError) unsubSettingsError(); };
  }, [setSettings, setProfiles]);

  /** Immediately switch data source: persist to settings AND notify backend manager. */
  const handleDataSourceChange = async (newSource: DataSource) => {
    const ipc = getIPC();
    setDraft((prev) => ({ ...prev, dataSource: newSource }));
    const merged = { ...settings, ...draft, dataSource: newSource };
    if (ipc) {
      await ipc.setSettings(merged);
      await ipc.setDataSource({ dataSource: newSource });
    }
    setSettings(merged);
    setStoreDataSource(newSource);
  };

  const handleSave = async () => {
    const ipc = getIPC();
    setSaveError(null);
    const target = validateTcpTarget(draft.tcpHost || '192.168.1.1', draft.tcpPort ?? 2000);
    if (!target.ok) {
      setDraft({ ...draft, tcpHost: target.host || '192.168.1.1', tcpPort: target.tcpPort ?? 2000 });
      setSaveError(target.error);
      return;
    }
    // Validate GoFree IP/port if GoFree is selected
    let gofreeCorrections: { gofreeHost?: string; gofreePort?: number } = {};
    if (draft.dataSource === 'gofree') {
      const gofreeTarget = validateGofreeTarget(draft.gofreeHost, draft.gofreePort);
      if (!gofreeTarget.ok) {
        setDraft({ ...draft, gofreeHost: gofreeTarget.host || '192.168.0.1', gofreePort: gofreeTarget.port ?? 10110 });
        setSaveError(gofreeTarget.error);
        return;
      }
      gofreeCorrections = { gofreeHost: gofreeTarget.host, gofreePort: gofreeTarget.port };
    }
    const settingsToSave = { ...draft, tcpHost: target.host, tcpPort: target.tcpPort, ...gofreeCorrections };
    if (ipc) {
      const result = await ipc.setSettings(settingsToSave);
      if (result && result.success === false) {
        setSaveError(result.error || 'Failed to save settings.');
        return;
      }
    }
    setSettings(settingsToSave);
    setDraft(settingsToSave);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleCancel = () => {
    setDraft({ ...settings });
  };

  const setSourcePreference = (pgn: number, src: number | null) => {
    const current = { ...(draft.sourcePreferences || {}) };
    if (src == null) {
      delete current[pgn];
    } else {
      current[pgn] = src;
    }
    setDraft({ ...draft, sourcePreferences: current });
  };

  const handleRescan = async () => {
    const ipc = getIPC();
    if (ipc) {
      await ipc.rescanSources();
      setDiscoveredSources({});
    }
  };

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      {loadWarning && (
        <div className="bg-yellow-900/40 border border-yellow-700 rounded px-4 py-2 text-yellow-300 text-sm">
          {loadWarning}
        </div>
      )}
      {saveError && (
        <div className="bg-red-900/40 border border-red-700 rounded px-4 py-2 text-red-300 text-sm">
          Save failed: {saveError}
        </div>
      )}
      {/* Connection — Data Source */}
      <section>
        <h2 className="text-lg font-semibold text-n2k-accent mb-3">Connection</h2>

        {/* FE1: Data Source radio group */}
        <div className="mb-4">
          <label className="block text-xs text-gray-400 mb-2">Data Source</label>
          <div className="flex rounded overflow-hidden border border-gray-700 w-fit">
            <button
              type="button"
              onClick={() => handleDataSourceChange('ngt1')}
              className={`px-4 py-1.5 text-sm font-medium transition-colors ${
                (draft.dataSource ?? 'ngt1') === 'ngt1'
                  ? 'bg-n2k-accent text-black'
                  : 'bg-n2k-bg text-gray-400 hover:text-gray-200'
              }`}
              data-testid="datasource-ngt1"
            >
              NGT-1 (USB)
            </button>
            <button
              type="button"
              onClick={() => handleDataSourceChange('gofree')}
              className={`px-4 py-1.5 text-sm font-medium transition-colors ${
                draft.dataSource === 'gofree'
                  ? 'bg-n2k-accent text-black'
                  : 'bg-n2k-bg text-gray-400 hover:text-gray-200'
              }`}
              data-testid="datasource-gofree"
            >
              GoFree (Ethernet)
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-1">
            {draft.dataSource === 'gofree'
              ? 'Receiving NMEA 0183 from a B&G GoFree router over TCP.'
              : 'Receiving NMEA 2000 data from an Actisense NGT-1 USB adapter.'}
          </p>
        </div>

        {/* FE2: NGT-1 fields — Serial Port + Baud Rate */}
        {(draft.dataSource ?? 'ngt1') === 'ngt1' && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Serial Port</label>
              <select
                value={draft.serialPort}
                onChange={(e) => setDraft({ ...draft, serialPort: e.target.value })}
                className="w-full bg-n2k-bg border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
                data-testid="serial-port-select"
              >
                <option value={draft.serialPort}>{draft.serialPort}</option>
                {ports.filter((p) => p.path !== draft.serialPort).map((p) => (
                  <option key={p.path} value={p.path}>
                    {p.path} {p.manufacturer ? `(${p.manufacturer})` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Baud Rate</label>
              <select
                value={draft.serialBaud}
                onChange={(e) => setDraft({ ...draft, serialBaud: Number(e.target.value) })}
                className="w-full bg-n2k-bg border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
                data-testid="baud-rate-select"
              >
                {[4800, 9600, 38400, 115200].map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* FE2: GoFree fields — IP + Port */}
        {draft.dataSource === 'gofree' && (
          <div className="grid grid-cols-[1fr_auto_7rem] gap-2 items-end">
            <div>
              <label className="block text-xs text-gray-400 mb-1">GoFree IP Address</label>
              <input
                type="text"
                value={draft.gofreeHost ?? '192.168.0.1'}
                onChange={(e) => setDraft({ ...draft, gofreeHost: e.target.value })}
                onBlur={(e) => setDraft({ ...draft, gofreeHost: sanitizeGofreeHost(e.target.value) || '192.168.0.1' })}
                className="w-full bg-n2k-bg border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
                placeholder="192.168.0.1"
                data-testid="gofree-host-input"
              />
            </div>
            <span className="text-gray-500 pb-1.5">:</span>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Port</label>
              <input
                type="number"
                min={1}
                max={65535}
                step={1}
                value={draft.gofreePort ?? 10110}
                onChange={(e) => setDraft({ ...draft, gofreePort: Number(e.target.value) })}
                className="w-full bg-n2k-bg border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
                placeholder="10110"
                data-testid="gofree-port-input"
              />
            </div>
          </div>
        )}
      </section>

      {/* PGN Sources */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold text-n2k-accent">PGN Sources</h2>
          <button
            onClick={handleRescan}
            className="px-3 py-1 rounded text-xs font-medium bg-gray-700 hover:bg-gray-600 text-white"
          >
            Rescan Sources
          </button>
        </div>
        <div className="flex flex-col gap-2">
          {DEFAULT_PGN_FILTER.map((pgn) => {
            const sources = discoveredSources[pgn] ?? [];
            const preferred = (draft.sourcePreferences ?? {})[pgn];
            return (
              <div key={pgn} className="flex items-center justify-between text-sm">
                <div className="flex gap-2 text-gray-300">
                  <span className="font-mono text-gray-500">{pgn}</span>
                  <span>{PGN_NAMES[pgn] || 'Unknown'}</span>
                </div>
                {sources.length === 0 ? (
                  <span className="text-gray-600 text-xs italic">No sources observed</span>
                ) : sources.length === 1 ? (
                  <span className="text-gray-400 text-xs">src {sources[0]}</span>
                ) : (
                  <select
                    value={preferred ?? ''}
                    onChange={(e) => setSourcePreference(pgn, e.target.value ? Number(e.target.value) : null)}
                    className="bg-n2k-bg border border-gray-700 rounded px-2 py-0.5 text-xs text-white"
                  >
                    <option value="">Any source</option>
                    {sources.map((src) => (
                      <option key={src} value={src}>src {src}</option>
                    ))}
                  </select>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* TCP Settings */}
      <section>
        <h2 className="text-lg font-semibold text-n2k-accent mb-3">TCP Gateway</h2>
        <div className="grid grid-cols-[1fr_auto_7rem] gap-2 items-end">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Host</label>
            <input
              type="text"
              value={draft.tcpHost || '192.168.1.1'}
              onChange={(e) => setDraft({ ...draft, tcpHost: e.target.value })}
              onBlur={(e) => setDraft({ ...draft, tcpHost: sanitizeTcpHost(e.target.value) || '192.168.1.1' })}
              className="w-full bg-n2k-bg border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
              placeholder="192.168.1.1"
            />
          </div>
          <span className="text-gray-500 pb-1.5">:</span>
          <div>
            <label className="block text-xs text-gray-400 mb-1">Port</label>
            <input
              type="number"
              min={1}
              max={65535}
              step={1}
              value={draft.tcpPort ?? 2000}
              onChange={(e) => setDraft({ ...draft, tcpPort: Number(e.target.value) })}
              className="w-full bg-n2k-bg border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
              placeholder="2000"
            />
          </div>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Connection target shown and saved as {sanitizeTcpHost(draft.tcpHost || '192.168.1.1') || '192.168.1.1'}:{draft.tcpPort ?? 2000}. Default is 192.168.1.1:2000.
        </p>
      </section>

      {/* Data Directory */}
      <section>
        <h2 className="text-lg font-semibold text-n2k-accent mb-3">Data Directory</h2>
        <input
          type="text"
          value={draft.dataDirectory}
          onChange={(e) => setDraft({ ...draft, dataDirectory: e.target.value })}
          className="w-full bg-n2k-bg border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
        />
      </section>

      {/* Active Polar Profile */}
      <section>
        <h2 className="text-lg font-semibold text-n2k-accent mb-3">Active Polar Profile</h2>
        <select
          value={draft.activePolarProfile ?? ''}
          onChange={(e) => setDraft({ ...draft, activePolarProfile: e.target.value ? Number(e.target.value) : undefined })}
          className="w-full bg-n2k-bg border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
        >
          <option value="">None</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </section>

      {/* Sail Inventory (Phase 2) */}
      <section>
        <h2 className="text-lg font-semibold text-n2k-accent mb-3">Sail Inventory</h2>
        <div className="flex flex-col gap-2">
          {(draft.sailInventory || DEFAULT_SAIL_INVENTORY).map((sail, i) => (
            <div key={sail.id || i} className="flex items-center gap-2">
              <input
                type="text"
                value={sail.label}
                onChange={(e) => {
                  const inv = [...(draft.sailInventory || DEFAULT_SAIL_INVENTORY)];
                  inv[i] = { ...inv[i], label: e.target.value };
                  setDraft({ ...draft, sailInventory: inv });
                }}
                className="flex-1 bg-n2k-bg border border-gray-700 rounded px-2 py-1 text-sm text-white"
              />
              <button
                onClick={() => {
                  const inv = [...(draft.sailInventory || DEFAULT_SAIL_INVENTORY)];
                  inv.splice(i, 1);
                  setDraft({ ...draft, sailInventory: inv });
                }}
                className="px-2 py-1 rounded text-xs bg-red-900/50 hover:bg-red-700 text-red-300"
              >
                Remove
              </button>
            </div>
          ))}
          <button
            onClick={() => {
              const inv = [...(draft.sailInventory || DEFAULT_SAIL_INVENTORY)];
              const id = `sail-${Date.now()}`;
              inv.push({ id, label: 'New Sail' });
              setDraft({ ...draft, sailInventory: inv });
            }}
            className="px-3 py-1.5 rounded text-xs bg-gray-700 hover:bg-gray-600 text-white self-start"
          >
            + Add Sail Configuration
          </button>
        </div>
      </section>

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={handleSave}
          disabled={!loaded}
          className="px-6 py-2 rounded text-sm font-medium bg-n2k-accent hover:bg-cyan-400 text-black disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saved ? '✓ Saved' : 'Save'}
        </button>
        <button
          onClick={handleCancel}
          className="px-6 py-2 rounded text-sm font-medium bg-gray-700 hover:bg-gray-600 text-white"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

const DEFAULT_SAIL_INVENTORY = [
  { id: 'j1-main', label: 'J1 + Main' },
  { id: 'j2-main', label: 'J2 + Main' },
  { id: 'j3-main', label: 'J3 + Main' },
  { id: 'a2-main', label: 'A2 + Main' },
  { id: 'a3-main', label: 'A3 + Main' },
  { id: 'j2-reef1', label: 'J2 + Main + 1 reef' },
  { id: 'j3-reef1', label: 'J3 + Main + 1 reef' },
];
