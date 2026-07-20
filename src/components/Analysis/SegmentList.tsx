import React, { useState } from 'react';
import { useAnalysisStore } from '../../store/useAnalysisStore';
import { getIPC } from '../../ipc';
import type { DetectedSegment } from '../../types/analysis';
import { downloadCsv } from '../../utils/download';

type SortKey = 'startTime' | 'durationS' | 'meanTws' | 'meanTwa' | 'meanStw' | 'percentPolar' | 'sailConfig';

function formatTime(iso: string, startMs: number): string {
  const ms = new Date(iso).getTime();
  const s = Math.floor((ms - startMs) / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function percentColor(val: number | null): string {
  if (val == null) return 'text-gray-500';
  if (val >= 100) return 'text-green-400';
  if (val >= 90) return 'text-yellow-400';
  return 'text-red-400';
}

function exportSegmentsCsv(segments: DetectedSegment[], startMs: number): void {
  const headers = ['Start Time', 'Duration (s)', 'Sail Config', 'TWS (kts)', 'TWA (°)', 'STW (kts)', '% Polar', 'σ TWS', 'σ TWA', 'σ STW', 'Excluded'];
  const rows: string[][] = [headers];

  for (const seg of segments) {
    const ms = new Date(seg.startTime).getTime();
    const elapsed = Math.floor((ms - startMs) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    const startLabel = `${m}:${String(s).padStart(2, '0')}`;

    rows.push([
      startLabel,
      String(Math.round(seg.durationS)),
      seg.sailConfig || '',
      seg.meanTws.toFixed(1),
      seg.meanTwa.toFixed(0),
      seg.meanStw.toFixed(1),
      seg.percentPolar != null ? `${seg.percentPolar}%` : '',
      seg.stdTws.toFixed(2),
      seg.stdTwa.toFixed(1),
      seg.stdStw.toFixed(2),
      seg.excluded ? 'Yes' : 'No',
    ]);
  }

  const csv = rows.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(',')).join('\n');
  const date = new Date().toISOString().slice(0, 10);
  downloadCsv(`n2k-segments-${date}.csv`, csv);
}

export default function SegmentList() {
  const segments = useAnalysisStore((s) => s.segments);
  const setSegments = useAnalysisStore((s) => s.setSegments);
  const timeRange = useAnalysisStore((s) => s.timeRange);
  const setViewRange = useAnalysisStore((s) => s.setViewRange);
  const setPerformanceSummary = useAnalysisStore((s) => s.setPerformanceSummary);
  const [sortKey, setSortKey] = useState<SortKey>('startTime');
  const [sortAsc, setSortAsc] = useState(true);

  const startMs = timeRange?.start || 0;

  const handleSort = (key: SortKey) => {
    if (sortKey === key) setSortAsc(!sortAsc);
    else { setSortKey(key); setSortAsc(true); }
  };

  const sorted = [...segments].sort((a, b) => {
    let av: any = a[sortKey];
    let bv: any = b[sortKey];
    if (av == null) av = sortAsc ? Infinity : -Infinity;
    if (bv == null) bv = sortAsc ? Infinity : -Infinity;
    if (typeof av === 'string') return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
    return sortAsc ? av - bv : bv - av;
  });

  const handleClickSegment = (seg: DetectedSegment) => {
    const st = new Date(seg.startTime).getTime();
    const et = new Date(seg.endTime).getTime();
    const padding = (et - st) * 0.2;
    setViewRange(st - padding, et + padding);
  };

  const handleToggleExclude = async (seg: DetectedSegment) => {
    const ipc = getIPC();
    if (!ipc) return;
    const newExcluded = !seg.excluded;
    await ipc.excludeSegment({ segmentId: seg.id, excluded: newExcluded });
    setSegments(segments.map((s) => s.id === seg.id ? { ...s, excluded: newExcluded } : s));
    // Refresh performance summary
    const perfResult = await ipc.getPerformanceSummary();
    if (perfResult?.success) {
      setPerformanceSummary(perfResult.rows);
    }
  };

  const thClass = 'px-2 py-1 text-left text-gray-400 cursor-pointer hover:text-white select-none';
  const arrow = (key: SortKey) => sortKey === key ? (sortAsc ? ' ↑' : ' ↓') : '';

  return (
    <div>
      {sorted.length > 0 && (
        <div className="flex justify-end mb-1">
          <button
            onClick={() => exportSegmentsCsv(sorted, startMs)}
            className="px-3 py-1 rounded text-xs bg-gray-700 hover:bg-gray-600 text-white"
          >
            Export CSV
          </button>
        </div>
      )}
    <div className="overflow-y-auto max-h-[400px]">
      {sorted.length === 0 ? (
        <div className="text-gray-500 text-sm py-8 text-center">
          No segments detected. Run segment detection first.
        </div>
      ) : (
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 bg-n2k-bg z-10">
            <tr>
              <th className={thClass} onClick={() => handleSort('startTime')}>Time{arrow('startTime')}</th>
              <th className={thClass} onClick={() => handleSort('durationS')}>Duration{arrow('durationS')}</th>
              <th className={thClass} onClick={() => handleSort('sailConfig')}>Sail{arrow('sailConfig')}</th>
              <th className={thClass} onClick={() => handleSort('meanTws')}>TWS{arrow('meanTws')}</th>
              <th className={thClass} onClick={() => handleSort('meanTwa')}>TWA{arrow('meanTwa')}</th>
              <th className={thClass} onClick={() => handleSort('meanStw')}>STW{arrow('meanStw')}</th>
              <th className={thClass} onClick={() => handleSort('percentPolar')}>% Polar{arrow('percentPolar')}</th>
              <th className="px-2 py-1 text-gray-400">σ</th>
              <th className="px-2 py-1 text-gray-400">Excl</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((seg) => (
              <tr
                key={seg.id}
                className={`border-t border-gray-800 cursor-pointer hover:bg-gray-800/50 ${seg.excluded ? 'opacity-40' : ''}`}
                onClick={() => handleClickSegment(seg)}
              >
                <td className="px-2 py-1.5 text-white">{formatTime(seg.startTime, startMs)}</td>
                <td className="px-2 py-1.5 text-gray-300">{Math.round(seg.durationS)}s</td>
                <td className="px-2 py-1.5 text-gray-300">{seg.sailConfig || '—'}</td>
                <td className="px-2 py-1.5 text-gray-300">{seg.meanTws.toFixed(1)}</td>
                <td className="px-2 py-1.5 text-gray-300">{seg.meanTwa.toFixed(0)}°</td>
                <td className="px-2 py-1.5 text-gray-300">{seg.meanStw.toFixed(1)}</td>
                <td className={`px-2 py-1.5 font-medium ${percentColor(seg.percentPolar)}`}>
                  {seg.percentPolar != null ? `${seg.percentPolar}%` : '—'}
                </td>
                <td className="px-2 py-1.5 text-gray-500">
                  {seg.stdTws.toFixed(1)}/{seg.stdTwa.toFixed(0)}/{seg.stdStw.toFixed(1)}
                </td>
                <td className="px-2 py-1.5">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleToggleExclude(seg); }}
                    className={`px-1.5 py-0.5 rounded text-xs ${seg.excluded ? 'bg-gray-700 text-gray-400' : 'bg-red-900/30 text-red-400 hover:bg-red-900/60'}`}
                  >
                    {seg.excluded ? 'Include' : 'Exclude'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
    </div>
  );
}
