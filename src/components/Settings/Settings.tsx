import React, { useEffect, useState } from 'react';
import { useSettingsStore } from '../../store/useSettings';
import { usePolarStore } from '../../store/usePolarStore';
import { getIPC } from '../../ipc';
import { DEFAULT_PGN_FILTER, PGN_NAMES } from '../../types/n2k-pgns';
import type { AppSettings } from '../../types/ipc';
import type { BoatProfile } from '../../types/polar';

export default function Settings() {
  const { settings, setSettings } = useSettingsStore();
  const { profiles, setProfiles } = usePolarStore();
  const [draft, setDraft] = useState<AppSettings>({ ...settings });
  const [ports, setPorts] = useState<Array<{ path: string; manufacturer?: string }>>([]);
  const [saved, setSaved] = useState(false);
  const [discoveredSources, setDiscoveredSources] = useState<Record<number, number[]>>({});

  useEffect(() => {
    const ipc = getIPC();
    if (!ipc) return;

    ipc.getSettings().then((s: AppSettings) => {
      if (s) {
        setSettings(s);
        setDraft({ ...s, sourcePreferences: s.sourcePreferences ?? {} });
      }
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
    return () => { if (unsub) unsub(); };
  }, [setSettings, setProfiles]);

  const handleSave = async () => {
    const ipc = getIPC();
    if (ipc) {
      await ipc.setSettings(draft);
    }
    setSettings(draft);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleCancel = () => {
    setDraft({ ...settings });
  };

  const togglePGN = (pgn: number) => {
    const current = draft.pgnFilter || [];
    if (current.includes(pgn)) {
      setDraft({ ...draft, pgnFilter: current.filter((p) => p !== pgn) });
    } else {
      setDraft({ ...draft, pgnFilter: [...current, pgn] });
    }
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

      {/* PGN Filter */}
      <section>
        <h2 className="text-lg font-semibold text-n2k-accent mb-3">PGN Filter</h2>
        <div className="grid grid-cols-1 gap-1">
          {DEFAULT_PGN_FILTER.map((pgn) => (
            <label
              key={pgn}
              className="flex items-center gap-2 text-sm text-gray-300 hover:text-white cursor-pointer"
            >
              <input
                type="checkbox"
                checked={(draft.pgnFilter || []).includes(pgn)}
                onChange={() => togglePGN(pgn)}
                className="accent-n2k-accent"
              />
              <span className="font-mono text-gray-500">{pgn}</span>
              <span>{PGN_NAMES[pgn] || 'Unknown'}</span>
            </label>
          ))}
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

      {/* Actions */}
      <div className="flex gap-3">
        <button
          onClick={handleSave}
          className="px-6 py-2 rounded text-sm font-medium bg-n2k-accent hover:bg-cyan-400 text-black"
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
