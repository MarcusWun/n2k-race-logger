import React from 'react';
import { useN2KStore } from '../../store/useN2KStore';
import { useFreshnessStore, METRIC_CHANNEL_MAP } from '../../store/useFreshnessStore';

function formatCoord(deg: number, isLat: boolean): string {
  const dir = isLat ? (deg >= 0 ? 'N' : 'S') : (deg >= 0 ? 'E' : 'W');
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const m = (abs - d) * 60;
  return `${d}°${m.toFixed(3)}' ${dir}`;
}

export default function GPSTile() {
  const lat = useN2KStore((s) => s.lat);
  const lon = useN2KStore((s) => s.lon);
  const isStale = useN2KStore((s) => s.isStale('lat'));
  const staleChannels = useFreshnessStore((s) => s.staleChannels);
  const isLatStale = staleChannels.has(METRIC_CHANNEL_MAP.lat);
  const isLonStale = staleChannels.has(METRIC_CHANNEL_MAP.lon);

  return (
    <div
      className={`bg-n2k-surface rounded-lg p-4 flex flex-col items-center justify-center transition-opacity ${
        isStale ? 'opacity-40' : 'opacity-100'
      }`}
    >
      <span className="text-xs text-gray-500 uppercase tracking-wider mb-1">
        GPS Position
      </span>
      <span className="text-lg font-mono text-white" data-testid="tile-value-lat">
        {isLatStale ? '--' : lat !== null ? formatCoord(lat, true) : '—'}
      </span>
      <span className="text-lg font-mono text-white" data-testid="tile-value-lon">
        {isLonStale ? '--' : lon !== null ? formatCoord(lon, false) : '—'}
      </span>
    </div>
  );
}
