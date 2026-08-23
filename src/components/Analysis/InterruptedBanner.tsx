import React from 'react';
import { formatRecoveredTime } from '../../utils/ngt1';

interface InterruptedBannerProps {
  wasInterrupted: number | boolean;
  recoveredEndTime: string | null | undefined;
}

/**
 * FE2 — Interrupted-recording banner (PRD §3.7).
 *
 * Shown when a race was not cleanly stopped (e.g. crash / power loss).
 * Displays the timestamp of the last recovered data point.
 * Does NOT block analysis — the race remains fully analyzable.
 */
export default function InterruptedBanner({ wasInterrupted, recoveredEndTime }: InterruptedBannerProps) {
  if (!wasInterrupted) return null;

  return (
    <div
      className="flex items-start gap-2 bg-yellow-900/40 border border-yellow-700/60 rounded px-3 py-2 text-xs"
      data-testid="interrupted-banner"
      role="status"
      aria-label="Recording interrupted"
    >
      <span className="text-yellow-400 mt-0.5">⚠</span>
      <div>
        <span className="text-yellow-300 font-medium">Recording interrupted</span>
        <span className="text-yellow-500 ml-1">
          — Recovered data through {formatRecoveredTime(recoveredEndTime)}
        </span>
      </div>
    </div>
  );
}
