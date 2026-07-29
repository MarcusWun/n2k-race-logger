import type { PolarPerformance } from '../types/polar';
import { normalizedWindAngleValue } from './angles';

export const EMPTY_POLAR_PERFORMANCE: PolarPerformance = {
  percentPolar: null,
  targetSpeed: null,
  actualSpeed: null,
};

export interface LivePolarMetrics {
  stw: number | null;
  tws: number | null;
  twa: number | null;
}

export interface LivePolarPerformancePayload {
  stw: number;
  tws: number;
  twa: number;
  profileId: number;
}

interface LivePolarIPC {
  getPerformance: (payload: LivePolarPerformancePayload) => Promise<PolarPerformance | { success: false; error?: string }>;
}

function isUsableNumber(value: number | null): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPerformanceError(result: PolarPerformance | { success: false; error?: string }): result is { success: false; error?: string } {
  return 'success' in result && result.success === false;
}

export function prepareLivePolarPerformancePayload(
  metrics: LivePolarMetrics,
  activeProfileId: number | null,
): LivePolarPerformancePayload | null {
  if (
    activeProfileId === null ||
    !isUsableNumber(metrics.stw) ||
    !isUsableNumber(metrics.tws) ||
    !isUsableNumber(metrics.twa)
  ) {
    return null;
  }

  return {
    stw: metrics.stw,
    tws: metrics.tws,
    twa: normalizedWindAngleValue(metrics.twa),
    profileId: activeProfileId,
  };
}

export async function requestLivePolarPerformance(
  ipc: LivePolarIPC,
  metrics: LivePolarMetrics,
  activeProfileId: number | null,
  setPerformance: (performance: PolarPerformance) => void,
): Promise<LivePolarPerformancePayload | null> {
  const payload = prepareLivePolarPerformancePayload(metrics, activeProfileId);
  if (!payload) {
    setPerformance(EMPTY_POLAR_PERFORMANCE);
    return null;
  }

  const result = await ipc.getPerformance(payload);
  if (isPerformanceError(result)) {
    setPerformance(EMPTY_POLAR_PERFORMANCE);
  } else {
    setPerformance(result);
  }
  return payload;
}
