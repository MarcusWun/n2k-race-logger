import React from 'react';
import { useAnalysisStore } from '../../store/useAnalysisStore';
import { DEFAULT_THRESHOLDS } from '../../types/analysis';
import { getIPC } from '../../ipc';

export default function SegmentControls() {
  const thresholds = useAnalysisStore((s) => s.thresholds);
  const setThresholds = useAnalysisStore((s) => s.setThresholds);
  const segments = useAnalysisStore((s) => s.segments);
  const setSegments = useAnalysisStore((s) => s.setSegments);
  const setPerformanceSummary = useAnalysisStore((s) => s.setPerformanceSummary);

  const runDetection = async () => {
    const ipc = getIPC();
    if (!ipc) return;
    const result = await ipc.detectSegments({ thresholds });
    if (result?.success && result.segments) {
      setSegments(result.segments.map((s: any) => ({
        id: s.id,
        raceId: s.race_id,
        startTime: s.start_time,
        endTime: s.end_time,
        durationS: s.duration_s,
        meanTws: s.mean_tws,
        meanTwa: s.mean_twa,
        meanStw: s.mean_stw,
        stdTws: s.std_tws,
        stdTwa: s.std_twa,
        stdStw: s.std_stw,
        percentPolar: s.percent_polar,
        sailConfig: s.sail_config,
        excluded: !!s.excluded,
        thresholds: JSON.parse(s.thresholds),
      })));
      // Refresh performance summary
      const perfResult = await ipc.getPerformanceSummary();
      if (perfResult?.success) {
        setPerformanceSummary(perfResult.rows);
      }
    }
  };

  const handleReset = () => {
    setThresholds({ ...DEFAULT_THRESHOLDS });
  };

  const nonExcluded = segments.filter((s) => !s.excluded);
  const totalSteadyTime = nonExcluded.reduce((sum, s) => sum + s.durationS, 0);

  return (
    <div className="bg-n2k-surface rounded-lg p-3 flex flex-col gap-3">
      <h3 className="text-xs font-semibold text-n2k-accent uppercase tracking-wider">Segment Detection</h3>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <label className="flex flex-col gap-1">
          <span className="text-gray-400">TWS ± kts</span>
          <input
            type="number"
            min={0.1}
            max={5}
            step={0.1}
            value={thresholds.tws}
            onChange={(e) => setThresholds({ ...thresholds, tws: Number(e.target.value) })}
            className="bg-n2k-bg border border-gray-700 rounded px-2 py-1 text-white w-full"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-gray-400">TWA ± °</span>
          <input
            type="number"
            min={1}
            max={30}
            step={1}
            value={thresholds.twa}
            onChange={(e) => setThresholds({ ...thresholds, twa: Number(e.target.value) })}
            className="bg-n2k-bg border border-gray-700 rounded px-2 py-1 text-white w-full"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-gray-400">STW ± kts</span>
          <input
            type="number"
            min={0.1}
            max={3}
            step={0.1}
            value={thresholds.stw}
            onChange={(e) => setThresholds({ ...thresholds, stw: Number(e.target.value) })}
            className="bg-n2k-bg border border-gray-700 rounded px-2 py-1 text-white w-full"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-gray-400">Min duration (s)</span>
          <input
            type="number"
            min={30}
            max={300}
            step={10}
            value={thresholds.minDuration}
            onChange={(e) => setThresholds({ ...thresholds, minDuration: Number(e.target.value) })}
            className="bg-n2k-bg border border-gray-700 rounded px-2 py-1 text-white w-full"
          />
        </label>
      </div>

      <div className="flex gap-2">
        <button
          onClick={runDetection}
          className="flex-1 px-3 py-1.5 rounded text-xs font-medium bg-n2k-accent hover:bg-cyan-400 text-black"
        >
          Detect Segments
        </button>
        <button
          onClick={handleReset}
          className="px-3 py-1.5 rounded text-xs bg-gray-700 hover:bg-gray-600 text-white"
        >
          Reset
        </button>
      </div>

      {/* Feedback */}
      <div className="text-xs text-gray-400">
        <span className="text-white font-medium">{nonExcluded.length}</span> segments detected
        {totalSteadyTime > 0 && (
          <span className="ml-2">
            ({Math.floor(totalSteadyTime / 60)}m {Math.floor(totalSteadyTime % 60)}s steady-state)
          </span>
        )}
      </div>
    </div>
  );
}
