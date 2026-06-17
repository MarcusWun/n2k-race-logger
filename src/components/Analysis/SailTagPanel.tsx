import React, { useState, useEffect } from 'react';
import { useAnalysisStore } from '../../store/useAnalysisStore';
import { useSettingsStore } from '../../store/useSettings';
import { getIPC } from '../../ipc';
import type { SailTag, SailInventoryItem } from '../../types/analysis';

const DEFAULT_SAIL_INVENTORY: SailInventoryItem[] = [
  { id: 'j1-main', label: 'J1 + Main' },
  { id: 'j2-main', label: 'J2 + Main' },
  { id: 'j3-main', label: 'J3 + Main' },
  { id: 'a2-main', label: 'A2 + Main' },
  { id: 'a3-main', label: 'A3 + Main' },
  { id: 'j2-reef1', label: 'J2 + Main + 1 reef' },
  { id: 'j3-reef1', label: 'J3 + Main + 1 reef' },
];

function formatTime(iso: string, startMs: number): string {
  const ms = new Date(iso).getTime();
  const s = Math.floor((ms - startMs) / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export default function SailTagPanel() {
  const sailTags = useAnalysisStore((s) => s.sailTags);
  const setSailTags = useAnalysisStore((s) => s.setSailTags);
  const raceMeta = useAnalysisStore((s) => s.raceMeta);
  const timeRange = useAnalysisStore((s) => s.timeRange);
  const settings = useSettingsStore((s) => s.settings);
  const [selectedSail, setSelectedSail] = useState('');
  const [tagStart, setTagStart] = useState('');
  const [tagEnd, setTagEnd] = useState('');

  const inventory: SailInventoryItem[] = (settings as any).sailInventory || DEFAULT_SAIL_INVENTORY;

  useEffect(() => {
    if (!raceMeta) return;
    const ipc = getIPC();
    if (!ipc) return;
    ipc.getSailTags({ raceId: raceMeta.id }).then((result: any) => {
      if (result?.success && result.tags) {
        setSailTags(result.tags.map((t: any) => ({
          id: t.id,
          raceId: t.race_id,
          sailConfig: t.sail_config,
          startTime: t.start_time,
          endTime: t.end_time,
        })));
      }
    });
  }, [raceMeta, setSailTags]);

  const handleAddTag = async () => {
    if (!selectedSail || !tagStart || !tagEnd || !raceMeta) return;
    const ipc = getIPC();
    if (!ipc) return;

    // Convert elapsed minutes to ISO times
    const startMs = timeRange!.start + Number(tagStart) * 60 * 1000;
    const endMs = timeRange!.start + Number(tagEnd) * 60 * 1000;

    const newTag: SailTag = {
      raceId: raceMeta.id,
      sailConfig: selectedSail,
      startTime: new Date(startMs).toISOString(),
      endTime: new Date(endMs).toISOString(),
    };

    const updatedTags = [...sailTags, newTag];
    setSailTags(updatedTags);

    // Save to DB
    await ipc.saveSailTags({
      raceId: raceMeta.id,
      tags: updatedTags.map((t) => ({
        config: t.sailConfig,
        start: t.startTime,
        end: t.endTime,
      })),
    });

    setSelectedSail('');
    setTagStart('');
    setTagEnd('');
  };

  const handleRemoveTag = async (index: number) => {
    if (!raceMeta) return;
    const ipc = getIPC();
    if (!ipc) return;

    const updatedTags = sailTags.filter((_, i) => i !== index);
    setSailTags(updatedTags);

    await ipc.saveSailTags({
      raceId: raceMeta.id,
      tags: updatedTags.map((t) => ({
        config: t.sailConfig,
        start: t.startTime,
        end: t.endTime,
      })),
    });
  };

  const startMs = timeRange?.start || 0;

  return (
    <div className="bg-n2k-surface rounded-lg p-3 flex flex-col gap-3">
      <h3 className="text-xs font-semibold text-n2k-accent uppercase tracking-wider">Sail Tags</h3>

      {/* Current tags */}
      {sailTags.length > 0 && (
        <div className="flex flex-col gap-1 max-h-32 overflow-y-auto">
          {sailTags.map((tag, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="text-white font-medium flex-1 truncate">{tag.sailConfig}</span>
              <span className="text-gray-400">
                {formatTime(tag.startTime, startMs)} – {formatTime(tag.endTime, startMs)}
              </span>
              <button
                onClick={() => handleRemoveTag(i)}
                className="text-red-400 hover:text-red-300 px-1"
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add new tag */}
      <div className="flex flex-col gap-2">
        <select
          value={selectedSail}
          onChange={(e) => setSelectedSail(e.target.value)}
          className="bg-n2k-bg border border-gray-700 rounded px-2 py-1 text-xs text-white"
        >
          <option value="">Select sail...</option>
          {inventory.map((s) => (
            <option key={s.id} value={s.label}>{s.label}</option>
          ))}
        </select>
        <div className="grid grid-cols-2 gap-2">
          <input
            type="number"
            min={0}
            step={1}
            placeholder="Start (min)"
            value={tagStart}
            onChange={(e) => setTagStart(e.target.value)}
            className="bg-n2k-bg border border-gray-700 rounded px-2 py-1 text-xs text-white"
          />
          <input
            type="number"
            min={0}
            step={1}
            placeholder="End (min)"
            value={tagEnd}
            onChange={(e) => setTagEnd(e.target.value)}
            className="bg-n2k-bg border border-gray-700 rounded px-2 py-1 text-xs text-white"
          />
        </div>
        <button
          onClick={handleAddTag}
          disabled={!selectedSail || !tagStart || !tagEnd}
          className="px-3 py-1.5 rounded text-xs font-medium bg-n2k-accent hover:bg-cyan-400 text-black disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Add Sail Tag
        </button>
      </div>
    </div>
  );
}
