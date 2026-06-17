import React from 'react';
import { useAnalysisStore } from '../../store/useAnalysisStore';
import StripCharts from './StripCharts';
import SegmentControls from './SegmentControls';
import SailTagPanel from './SailTagPanel';
import PolarOverlay from './PolarOverlay';
import PerformanceSummary from './PerformanceSummary';
import SegmentList from './SegmentList';

interface AnalysisViewProps {
  onBack: () => void;
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export default function AnalysisView({ onBack }: AnalysisViewProps) {
  const raceMeta = useAnalysisStore((s) => s.raceMeta);
  const timeRange = useAnalysisStore((s) => s.timeRange);
  const segments = useAnalysisStore((s) => s.segments);
  const sailTags = useAnalysisStore((s) => s.sailTags);
  const analysisTab = useAnalysisStore((s) => s.analysisTab);
  const setAnalysisTab = useAnalysisStore((s) => s.setAnalysisTab);

  const nonExcluded = segments.filter((s) => !s.excluded);
  const duration = timeRange ? (timeRange.end - timeRange.start) / 1000 : 0;

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Header */}
      <div className="flex items-center gap-3 bg-n2k-surface rounded-lg px-4 py-2">
        <button
          onClick={onBack}
          className="px-3 py-1 rounded text-sm bg-gray-700 hover:bg-gray-600 text-white"
        >
          Back
        </button>
        <div className="flex-1">
          <h2 className="text-sm font-semibold text-white">
            {raceMeta?.label || 'Untitled Race'}
          </h2>
          <div className="text-xs text-gray-400 flex gap-3">
            {raceMeta?.created_at && (
              <span>{new Date(raceMeta.created_at).toLocaleDateString()}</span>
            )}
            <span>{formatDuration(duration)}</span>
            <span>{nonExcluded.length} segments</span>
          </div>
        </div>
      </div>

      {/* Main content: strip charts + sidebar */}
      <div className="flex gap-3 flex-1 min-h-0">
        {/* Strip charts */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          <StripCharts segments={segments} sailTags={sailTags} />
        </div>

        {/* Sidebar: controls */}
        <div className="w-56 flex flex-col gap-3 shrink-0">
          <SegmentControls />
          <SailTagPanel />
        </div>
      </div>

      {/* Bottom tabs */}
      <div className="bg-n2k-surface rounded-lg overflow-hidden flex flex-col" style={{ maxHeight: '45%' }}>
        <div className="flex border-b border-gray-800">
          {(['polar', 'summary', 'segments'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setAnalysisTab(tab)}
              className={`px-4 py-2 text-xs font-medium transition-colors ${
                analysisTab === tab
                  ? 'bg-n2k-bg text-white border-b-2 border-n2k-accent'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {tab === 'polar' ? 'Polar Overlay' : tab === 'summary' ? 'Performance Summary' : 'Segment List'}
            </button>
          ))}
        </div>
        <div className="flex-1 p-3 overflow-auto min-h-[200px]">
          {analysisTab === 'polar' && <PolarOverlay />}
          {analysisTab === 'summary' && <PerformanceSummary />}
          {analysisTab === 'segments' && <SegmentList />}
        </div>
      </div>
    </div>
  );
}
