import { create } from 'zustand';

interface FreshnessStore {
  /** Set of GoFree channel IDs currently reported as stale by the backend watchdog. */
  staleChannels: Set<number>;
  /** Replace the stale-channel set with the latest event payload. */
  setStaleChannels: (channels: number[]) => void;
  /** O(1) staleness query for a single channel. */
  isChannelStale: (channelId: number) => boolean;
}

export const useFreshnessStore = create<FreshnessStore>((set, get) => ({
  staleChannels: new Set(),
  setStaleChannels: (channels) => set({ staleChannels: new Set(channels) }),
  isChannelStale: (channelId) => get().staleChannels.has(channelId),
}));

/**
 * Maps renderer metric keys (as used in useN2KStore) to GoFree channel IDs.
 * Authoritative source: electron/gofree-manager.ts CH_* constants + CONTRACTS.md.
 *
 *   41=SOG, 42=BSPD(stw), 44=AWA, 45=TWA, 46=AWS, 47=TWS,
 *   9=COG, 37=HDG, 421=LAT, 422=LON
 *
 * VMG (235) and Leeway (226) are direct GoFree channels but are currently
 * derived values in the renderer (not stored as individual metric keys), so
 * they are exposed as named constants for use in Dashboard's VmgTile.
 */
export const METRIC_CHANNEL_MAP: Readonly<Record<string, number>> = {
  stw: 42,      // CH_BSPD — Boat Speed
  sog: 41,      // CH_SOG  — Speed Over Ground
  awa: 44,      // CH_AWA  — Apparent Wind Angle
  twa: 45,      // CH_TWA  — True Wind Angle
  aws: 46,      // CH_AWS  — Apparent Wind Speed
  tws: 47,      // CH_TWS  — True Wind Speed
  cog: 9,       // CH_COG  — Course Over Ground
  heading: 37,  // CH_HDG  — Vessel Heading
  lat: 421,     // CH_LAT  — Latitude
  lon: 422,     // CH_LON  — Longitude
};

/** Channel IDs for derived dashboard tiles that have no direct metric key. */
export const CH_VMG = 235;
export const CH_LEE = 226;
