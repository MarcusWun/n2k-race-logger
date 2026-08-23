import { create } from 'zustand';
import type {
  TimeSeries,
  SegmentThresholds,
  DetectedSegment,
  SailTag,
  RaceFileInfo,
  PerformanceSummaryRow,
} from '../types/analysis';
import { DEFAULT_THRESHOLDS } from '../types/analysis';
import type { RaceMetadata, DataQualityRow } from '../types/metadata';

interface AnalysisStore {
  // Race browser
  raceFiles: RaceFileInfo[];
  setRaceFiles: (files: RaceFileInfo[]) => void;

  // Loaded race
  loadedRacePath: string | null;
  raceMeta: any | null;
  metrics: TimeSeries | null;
  timeRange: { start: number; end: number } | null;
  // Phase 2.8: provenance + quality (BE9/BE10, FE3/FE4)
  raceMetadata: RaceMetadata | null;
  dataQuality: DataQualityRow | null;

  setLoadedRace: (path: string, meta: any, metrics: TimeSeries, timeRange: { start: number; end: number }) => void;
  clearLoadedRace: () => void;
  setRaceMetadata: (metadata: RaceMetadata | null) => void;
  setDataQuality: (quality: DataQualityRow | null) => void;

  // Segment detection
  thresholds: SegmentThresholds;
  segments: DetectedSegment[];
  setThresholds: (t: SegmentThresholds) => void;
  setSegments: (segments: DetectedSegment[]) => void;

  // Sail tags
  sailTags: SailTag[];
  setSailTags: (tags: SailTag[]) => void;

  // Performance
  performanceSummary: PerformanceSummaryRow[];
  setPerformanceSummary: (rows: PerformanceSummaryRow[]) => void;

  // Strip chart view state
  viewStart: number | null;
  viewEnd: number | null;
  setViewRange: (start: number, end: number) => void;
  resetViewRange: () => void;

  // Analysis sub-tab (quality tab added for FE3/FE4)
  analysisTab: 'polar' | 'summary' | 'segments' | 'quality';
  setAnalysisTab: (tab: 'polar' | 'summary' | 'segments' | 'quality') => void;

  // Filters
  sailFilter: string | null;
  twsFilter: [number, number] | null;
  setSailFilter: (sail: string | null) => void;
  setTwsFilter: (band: [number, number] | null) => void;
}

export const useAnalysisStore = create<AnalysisStore>((set, get) => ({
  raceFiles: [],
  setRaceFiles: (files) => set({ raceFiles: files }),

  loadedRacePath: null,
  raceMeta: null,
  metrics: null,
  timeRange: null,
  raceMetadata: null,
  dataQuality: null,

  setLoadedRace: (path, meta, metrics, timeRange) => set({
    loadedRacePath: path,
    raceMeta: meta,
    metrics,
    timeRange,
    viewStart: timeRange.start,
    viewEnd: timeRange.end,
    segments: [],
    sailTags: [],
    performanceSummary: [],
    raceMetadata: null,
    dataQuality: null,
  }),
  clearLoadedRace: () => set({
    loadedRacePath: null,
    raceMeta: null,
    metrics: null,
    timeRange: null,
    viewStart: null,
    viewEnd: null,
    segments: [],
    sailTags: [],
    performanceSummary: [],
    raceMetadata: null,
    dataQuality: null,
  }),
  setRaceMetadata: (metadata) => set({ raceMetadata: metadata }),
  setDataQuality: (quality) => set({ dataQuality: quality }),

  thresholds: { ...DEFAULT_THRESHOLDS },
  segments: [],
  setThresholds: (t) => set({ thresholds: t }),
  setSegments: (segments) => set({ segments }),

  sailTags: [],
  setSailTags: (tags) => set({ sailTags: tags }),

  performanceSummary: [],
  setPerformanceSummary: (rows) => set({ performanceSummary: rows }),

  viewStart: null,
  viewEnd: null,
  setViewRange: (start, end) => set({ viewStart: start, viewEnd: end }),
  resetViewRange: () => {
    const { timeRange } = get();
    if (timeRange) set({ viewStart: timeRange.start, viewEnd: timeRange.end });
  },

  analysisTab: 'polar',
  setAnalysisTab: (tab) => set({ analysisTab: tab }),

  sailFilter: null,
  twsFilter: null,
  setSailFilter: (sail) => set({ sailFilter: sail }),
  setTwsFilter: (band) => set({ twsFilter: band }),
}));
