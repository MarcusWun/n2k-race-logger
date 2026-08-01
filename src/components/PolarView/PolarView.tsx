import React, { useEffect, useState } from 'react';
import { usePolarStore } from '../../store/usePolarStore';
import { getIPC } from '../../ipc';
import PolarDiagram from './PolarDiagram';
import type { BoatProfile } from '../../types/polar';

export default function PolarView() {
  const { profiles, activeProfileId, polarData, setProfiles, setActiveProfile, setPolarData } = usePolarStore();
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    const ipc = getIPC();
    if (!ipc) return;
    Promise.all([ipc.listPolars(), ipc.getSettings()]).then(([profiles, settings]) => {
      if (Array.isArray(profiles)) {
        setProfiles(profiles);
        if (profiles.length > 0) {
          const savedId = settings?.activePolarProfile ?? null;
          const savedExists = savedId !== null && profiles.some((p: BoatProfile) => p.id === savedId);
          setActiveProfile(savedExists ? savedId : profiles[0].id);
        }
      }
    });
  }, [setProfiles, setActiveProfile]);

  useEffect(() => {
    if (activeProfileId === null) return;
    const ipc = getIPC();
    if (!ipc) return;
    ipc.getPolar({ id: activeProfileId }).then((result: any) => {
      if (result?.success && result.polarData) {
        setPolarData(result.polarData);
      }
    });
  }, [activeProfileId, setPolarData]);

  const handleImport = async () => {
    const ipc = getIPC();
    if (!ipc) return;
    setImporting(true);
    try {
      const dialogResult = await ipc.openPolarDialog();
      if (dialogResult?.canceled) return;
      const result = await ipc.importPolar({ filePath: dialogResult.filePath });
      if (result?.success && result.profile) {
        const list = await ipc.listPolars();
        if (Array.isArray(list)) setProfiles(list);
        setActiveProfile(result.profile.id);
        await ipc.setSettings({ activePolarProfile: result.profile.id });
      }
    } finally {
      setImporting(false);
    }
  };

  const handleProfileChange = (id: number) => {
    setActiveProfile(id);
    const ipc = getIPC();
    if (ipc) ipc.setSettings({ activePolarProfile: id });
  };

  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="flex items-center gap-3 bg-n2k-surface rounded-lg px-4 py-2">
        <span className="text-xs text-gray-400 uppercase tracking-wider">Profile</span>
        <select
          value={activeProfileId ?? ''}
          onChange={(e) => handleProfileChange(Number(e.target.value))}
          className="bg-n2k-bg border border-gray-700 rounded px-2 py-1 text-sm text-white"
        >
          <option value="" disabled>Select profile...</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        <button
          onClick={handleImport}
          disabled={importing}
          className="ml-auto px-4 py-1 rounded text-sm font-medium bg-n2k-accent hover:bg-cyan-400 text-black"
        >
          {importing ? 'Importing...' : 'Import .pol / .csv / .txt'}
        </button>
      </div>

      <div className="flex-1 bg-n2k-surface rounded-lg p-4 min-h-0">
        <PolarDiagram polarData={polarData} />
      </div>

      {/* Legend */}
      {polarData && (
        <div className="flex gap-4 flex-wrap text-xs text-gray-400">
          {polarData.tws.map((twsVal, i) => (
            <span key={twsVal} className="flex items-center gap-1">
              <span
                className="w-3 h-0.5 inline-block"
                style={{ backgroundColor: ['#00d4ff', '#00ff88', '#ffaa00', '#ff4444', '#aa66ff', '#ff66aa'][i % 6] }}
              />
              {twsVal} kts TWS
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
