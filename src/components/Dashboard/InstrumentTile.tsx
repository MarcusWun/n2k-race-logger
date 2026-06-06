import React from 'react';
import { useN2KStore } from '../../store/useN2KStore';

interface InstrumentTileProps {
  label: string;
  metricKey: string;
  unit: string;
  format?: (value: number) => string;
  large?: boolean;
  colorCode?: boolean; // for % polar
}

export default function InstrumentTile({
  label,
  metricKey,
  unit,
  format,
  large,
  colorCode,
}: InstrumentTileProps) {
  const value = useN2KStore((s) => (s as any)[metricKey] as number | null);
  const isStale = useN2KStore((s) => s.isStale(metricKey));

  const displayValue = value !== null
    ? (format ? format(value) : value.toFixed(1))
    : '—';

  let colorClass = 'text-white';
  if (colorCode && value !== null) {
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
      >
        {displayValue}
      </span>
      <span className="text-xs text-gray-600 mt-1">{unit}</span>
    </div>
  );
}
