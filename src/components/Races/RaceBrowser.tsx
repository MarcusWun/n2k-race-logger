import React, { useEffect, useState } from 'react';
import { useAnalysisStore } from '../../store/useAnalysisStore';
import { getIPC } from '../../ipc';
import type { RaceFileInfo } from '../../types/analysis';

interface RaceBrowserProps {
  onOpenRace: (filePath: string) => void;
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
      ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

export default function RaceBrowser({ onOpenRace }: RaceBrowserProps) {
  const { raceFiles, setRaceFiles } = useAnalysisStore();
  const [search, setSearch] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadRaces();
  }, []);

  const loadRaces = async () => {
    const ipc = getIPC();
    if (!ipc) { setLoading(false); return; }
    setLoading(true);
    const files = await ipc.listRaces();
    if (Array.isArray(files)) {
      setRaceFiles(files);
    }
    setLoading(false);
  };

  const handleDelete = async (filePath: string) => {
    const ipc = getIPC();
    if (!ipc) return;
    const result = await ipc.deleteRace({ filePath });
    if (result?.success) {
      setRaceFiles(raceFiles.filter((r) => r.path !== filePath));
      setDeleteConfirm(null);
    }
  };

  const filtered = raceFiles.filter((r) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (r.label && r.label.toLowerCase().includes(s)) ||
      r.date.toLowerCase().includes(s);
  });

  return (
    <div className="flex flex-col gap-4 h-full">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold text-n2k-accent">Recorded Races</h2>
        <input
          type="text"
          placeholder="Search by label..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ml-auto bg-n2k-bg border border-gray-700 rounded px-3 py-1.5 text-sm text-white w-64"
        />
        <button
          onClick={loadRaces}
          className="px-3 py-1.5 rounded text-sm bg-gray-700 hover:bg-gray-600 text-white"
        >
          Refresh
        </button>
      </div>

      {loading ? (
        <div className="text-gray-500 text-sm py-8 text-center">Loading races...</div>
      ) : filtered.length === 0 ? (
        <div className="text-gray-500 text-sm py-8 text-center">
          {raceFiles.length === 0 ? 'No recorded races found.' : 'No races match your search.'}
        </div>
      ) : (
        <div className="flex flex-col gap-2 overflow-y-auto">
          {filtered.map((race) => (
            <div
              key={race.path}
              className="bg-n2k-surface rounded-lg px-4 py-3 flex items-center gap-4 hover:bg-gray-800 transition-colors cursor-pointer group"
              onClick={() => onOpenRace(race.path)}
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-white truncate">
                  {race.label || 'Untitled Race'}
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {formatDate(race.date)}
                </div>
              </div>
              <div className="text-xs text-gray-400 text-right whitespace-nowrap">
                {formatDuration(race.duration)}
              </div>
              <div className="text-xs text-gray-400 text-right whitespace-nowrap w-20">
                {race.points.toLocaleString()} pts
              </div>
              <div className="text-xs text-gray-500 text-right whitespace-nowrap w-16">
                {formatSize(race.size)}
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setDeleteConfirm(race.path);
                }}
                className="opacity-0 group-hover:opacity-100 px-2 py-1 rounded text-xs bg-red-900/50 hover:bg-red-700 text-red-300 hover:text-white transition-all"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-n2k-surface rounded-lg p-6 max-w-sm shadow-xl">
            <h3 className="text-white font-semibold mb-2">Delete Race?</h3>
            <p className="text-gray-400 text-sm mb-4">
              This will permanently delete the race file. This cannot be undone.
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-1.5 rounded text-sm bg-gray-700 hover:bg-gray-600 text-white"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deleteConfirm)}
                className="px-4 py-1.5 rounded text-sm bg-red-600 hover:bg-red-500 text-white"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
