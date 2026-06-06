import { create } from 'zustand';

interface MetricState {
  stw: number | null;
  sog: number | null;
  cog: number | null;
  tws: number | null;
  twa: number | null;
  aws: number | null;
  awa: number | null;
  heading: number | null;
  lat: number | null;
  lon: number | null;
  lastUpdated: Record<string, number>;
}

interface N2KStore extends MetricState {
  setMetric: (key: string, value: number | null) => void;
  updateLastUpdated: (key: string) => void;
  isStale: (key: string) => boolean;
}

export const useN2KStore = create<N2KStore>((set, get) => ({
  stw: null,
  sog: null,
  cog: null,
  tws: null,
  twa: null,
  aws: null,
  awa: null,
  heading: null,
  lat: null,
  lon: null,
  lastUpdated: {},

  setMetric: (key, value) => {
    set({ [key]: value } as unknown as Partial<MetricState>);
  },

  updateLastUpdated: (key) => {
    set((state) => ({
      lastUpdated: { ...state.lastUpdated, [key]: Date.now() },
    }));
  },

  isStale: (key) => {
    const last = get().lastUpdated[key] || 0;
    return Date.now() - last > 5000;
  },
}));
