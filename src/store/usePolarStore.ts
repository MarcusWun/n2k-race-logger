import { create } from 'zustand';
import type { PolarData, BoatProfile, PolarPerformance } from '../types/polar';

interface PolarStore {
  profiles: BoatProfile[];
  activeProfileId: number | null;
  polarData: PolarData | null;
  performance: PolarPerformance;
  setProfiles: (profiles: BoatProfile[]) => void;
  setActiveProfile: (id: number | null) => void;
  setPolarData: (data: PolarData) => void;
  setPerformance: (performance: PolarPerformance) => void;
}

export const usePolarStore = create<PolarStore>((set) => ({
  profiles: [],
  activeProfileId: null,
  polarData: null,
  performance: { percentPolar: null, targetSpeed: null, actualSpeed: null },

  setProfiles: (profiles) => set({ profiles }),
  setActiveProfile: (id) => set({ activeProfileId: id }),
  setPolarData: (data) => set({ polarData: data }),
  setPerformance: (performance) => set({ performance }),
}));
