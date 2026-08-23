import React, { useEffect } from 'react';
import { useAnalysisStore } from '../../store/useAnalysisStore';
import { getIPC } from '../../ipc';
import StripCharts from './StripCharts';
import SegmentControls from './SegmentControls';
import SailTagPanel from './SailTagPanel';
import PolarOverlay from './PolarOverlay';
import PerformanceSummary from './PerformanceSummary';
import SegmentList from './SegmentList';
import InterruptedBanner from './InterruptedBanner';
import DataQualityPanel from './DataQualityPanel';
import ProvenanceBlock from './ProvenanceBlock';

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
  const raceMetadata = useAnalysisStore((s) => s.raceMetadata);
  const dataQuality = useAnalysisStore((s) => s.dataQuality);
  const setRaceMetadata = useAnalysisStore((s) => s.setRaceMetadata);
  const setDataQuality = useAnalysisStore((s) => s.setDataQuality);

  const nonExcluded = segments.filter((s) => !s.excluded);
  const duration = timeRange ? (timeRange.end - timeRange.start) / 1000 : 0;

  // FE3/FE4: Fetch provenance and quality when a race is loaded.
  useEffect(() => {
    if (!raceMeta) return;
    const ipc = getIPC();
    if (!ipc) return;

    ipc.getRaceMetadata().then((result: any) => {
      setRaceMetadata(result?.metadata ?? null);
    }).catch(() => setRaceMetadata(null));

    ipc.getDataQuality().then((result: any) => {
      setDataQuality(result?.quality ?? null);
    }).catch(() => setDataQuality(null));
  }, [raceMeta?.id]);

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

      {/* FE2: Interrupted-recording banner (shown only when was_interrupted is truthy) */}
      {raceMeta && Boolean(raceMeta.was_interrupted) && (
        <InterruptedBanner
          wasInterrupted={raceMeta.was_interrupted}
          recoveredEndTime={raceMeta.recovered_end_time}
        />
      )}

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
          {(['polar', 'summary', 'segments', 'quality'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setAnalysisTab(tab)}
              className={`px-4 py-2 text-xs font-medium transition-colors ${
                analysisTab === tab
                  ? 'bg-n2k-bg text-white border-b-2 border-n2k-accent'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {tab === 'polar'
                ? 'Polar Overlay'
                : tab === 'summary'
                ? 'Performance Summary'
                : tab === 'segments'
                ? 'Segment List'
                : 'Quality'}
            </button>
          ))}
        </div>
        <div className="flex-1 p-3 overflow-auto min-h-[200px]">
          {analysisTab === 'polar' && <PolarOverlay />}
          {analysisTab === 'summary' && <PerformanceSummary />}
          {analysisTab === 'segments' && <SegmentList />}
          {analysisTab === 'quality' && (
            <div className="flex gap-6">
              {/* FE3: Data-quality summary */}
              <div className="flex-1 min-w-0">
                <div className="text-xs text-gray-400 uppercase tracking-wider mb-2">Data Quality</div>
                <DataQualityPanel quality={dataQuality} />
              </div>
              {/* FE4: Acquisition provenance */}
              <div className="w-56 shrink-0 border-l border-gray-800 pl-4">
                <div className="text-xs text-gray-400 uppercase tracking-wider mb-2">Provenance</div>
                <ProvenanceBlock metadata={raceMetadata} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
