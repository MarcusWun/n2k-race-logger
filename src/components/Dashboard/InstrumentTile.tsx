import React from 'react';
import { useN2KStore } from '../../store/useN2KStore';
import { useFreshnessStore } from '../../store/useFreshnessStore';

interface InstrumentTileProps {
  label: string;
  metricKey: string;
  unit: string;
  format?: (value: number) => string;
  large?: boolean;
  colorCode?: boolean; // for % polar
  /**
   * Optional GoFree channel ID. When provided and the channel is in the
   * current staleChannels set, the tile renders '--' instead of the last
   * known value (PRD §4.2). The stored value is NOT deleted.
   */
  channelId?: number;
}

export default function InstrumentTile({
  label,
  metricKey,
  unit,
  format,
  large,
  colorCode,
  channelId,
}: InstrumentTileProps) {
  const value = useN2KStore((s) => (s as any)[metricKey] as number | null);
  const isStale = useN2KStore((s) => s.isStale(metricKey));
  const staleChannels = useFreshnessStore((s) => s.staleChannels);
  const isGoFreeChannelStale = channelId != null ? staleChannels.has(channelId) : false;

  // GoFree channel freshness takes priority: show '--' when the backend
  // reports this channel as stale (last obs older than 2× poll interval).
  const displayValue = isGoFreeChannelStale
    ? '--'
    : value !== null
      ? (format ? format(value) : value.toFixed(1))
      : '—';

  let colorClass = 'text-white';
  if (colorCode && value !== null && !isGoFreeChannelStale) {
    if (value >= 100) colorClass = 'text-n2k-success';
    else if (value >= 90) colorClass = 'text-n2k-warning';
    else colorClass = 'text-n2k-danger';
  }

  return (
    <div
      className={`bg-n2k-surface rounded-lg p-4 flex flex-col items-center justify-center transition-opacity ${
        isStale ? 'opacity-40' : 'opacity-100'
      } ${large ? 'col-span-1' : ''}`}
    >
      <span className="text-xs text-gray-500 uppercase tracking-wider mb-1">
        {label}
      </span>
      <span
        className={`${large ? 'text-4xl' : 'text-2xl'} font-mono font-bold ${colorClass}`}
        data-testid={`tile-value-${metricKey}`}
      >
        {displayValue}
      </span>
      <span className="text-xs text-gray-600 mt-1">{unit}</span>
    </div>
  );
}
