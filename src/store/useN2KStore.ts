import { create } from 'zustand';

interface MetricState {
  stw: number | null;
  sog: number | null;
  cog: number | null;
  tws: number | null;
  twa: number | null;
  twd: number | null;
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

// Time constant for EMA dampening (milliseconds)
const DAMPING_TAU_MS = 1000;

// Metrics that get EMA smoothing (not GPS, not computed TWS/TWA/TWD)
const DAMPED_KEYS = new Set(['stw', 'sog', 'aws', 'awa', 'heading', 'cog']);

// Metrics that wrap around 0-360
const ANGLE_KEYS = new Set(['awa', 'cog', 'heading', 'twa', 'twd']);

export const useN2KStore = create<N2KStore>((set, get) => ({
  stw: null,
  sog: null,
  cog: null,
  tws: null,
  twa: null,
  twd: null,
  aws: null,
  awa: null,
  heading: null,
  lat: null,
  lon: null,
  lastUpdated: {},

  setMetric: (key, value) => {
    if (value == null) {
      set({ [key]: value } as unknown as Partial<MetricState>);
      return;
    }

    const state = get();
    const current = state[key as keyof MetricState] as number | null;
    const lastTime = state.lastUpdated[key] || 0;
    const now = Date.now();
    const dt = now - lastTime;

    // Apply EMA dampening for measured values (skip if first value or long gap)
    if (DAMPED_KEYS.has(key) && current != null && dt > 0 && dt < 5000) {
      const alpha = 1 - Math.exp(-dt / DAMPING_TAU_MS);

      if (ANGLE_KEYS.has(key)) {
        // Circular EMA for angles (handle 359°→1° wrap-around)
        let diff = value - current;
        if (diff > 180) diff -= 360;
        if (diff < -180) diff += 360;
        const smoothed = ((current + alpha * diff) % 360 + 360) % 360;
        set({ [key]: smoothed } as unknown as Partial<MetricState>);
      } else {
        const smoothed = current + alpha * (value - current);
        set({ [key]: smoothed } as unknown as Partial<MetricState>);
      }
    } else {
      set({ [key]: value } as unknown as Partial<MetricState>);
    }
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
