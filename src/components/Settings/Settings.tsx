import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../../store/useSettings';
import { usePolarStore } from '../../store/usePolarStore';
import { getIPC } from '../../ipc';
import { DEFAULT_PGN_FILTER, PGN_NAMES } from '../../types/n2k-pgns';
import type { AppSettings } from '../../types/ipc';
import type { BoatProfile } from '../../types/polar';
import { sanitizeTcpHost, validateTcpTarget } from '../../utils/tcp';

export default function Settings() {
  const { settings, setSettings } = useSettingsStore();
  const { profiles, setProfiles } = usePolarStore();
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

  const handleSave = async () => {
    const ipc = getIPC();
    setSaveError(null);
    const target = validateTcpTarget(draft.tcpHost || '192.168.1.1', draft.tcpPort ?? 2000);
    if (!target.ok) {
      setDraft({ ...draft, tcpHost: target.host || '192.168.1.1', tcpPort: target.tcpPort ?? 2000 });
      setSaveError(target.error);
      return;
    }
    const settingsToSave = { ...draft, tcpHost: target.host, tcpPort: target.tcpPort };
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
      {/* Connection */}
      <section>
        <h2 className="text-lg font-semibold text-n2k-accent mb-3">Connection</h2>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-gray-400 mb-1">Serial Port</label>
            <select
              value={draft.serialPort}
              onChange={(e) => setDraft({ ...draft, serialPort: e.target.value })}
              className="w-full bg-n2k-bg border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
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
            >
              {[4800, 9600, 38400, 115200].map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
        </div>
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
