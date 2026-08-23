import React from 'react';
import type { RaceMetadata } from '../../types/metadata';
import { formatProvenanceSource } from '../../utils/ngt1';

interface ProvenanceBlockProps {
  metadata: RaceMetadata | null;
}

/** Format an ISO timestamp as a short local date-time string. */
function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
  } catch {
    return iso;
  }
}

/** Shorten a git commit SHA to 7 characters (standard short form). */
function shortSha(sha: string | null | undefined): string {
  if (!sha) return '—';
  return sha.slice(0, 7);
}

/**
 * FE4 — Race provenance block (PRD §3.9).
 *
 * Shows acquisition source, software version, git commit, and recording timestamps.
 * Legacy races (metadata = null): shows a single fallback line.
 */
export default function ProvenanceBlock({ metadata }: ProvenanceBlockProps) {
  if (!metadata) {
    return (
      <div className="text-gray-500 text-xs italic" data-testid="provenance-unavailable">
        Provenance unavailable (legacy recording)
      </div>
    );
  }

  const sourceLabel = formatProvenanceSource(
    metadata.data_source,
    metadata.serial_port,
    metadata.h5000_ip,
  );

  return (
    <div className="flex flex-col gap-0.5 text-xs" data-testid="provenance-block">
      <div className="flex justify-between">
        <span className="text-gray-400">Source</span>
        <span className="text-white" data-testid="provenance-source">{sourceLabel}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-gray-400">Version</span>
        <span className="text-white">{metadata.application_version}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-gray-400">Commit</span>
        <span className="text-white font-mono">{shortSha(metadata.git_commit)}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-gray-400">Start</span>
        <span className="text-white">{fmtDateTime(metadata.recording_start)}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-gray-400">End</span>
        <span className="text-white">{fmtDateTime(metadata.recording_end)}</span>
      </div>
      {metadata.polar_file && (
        <div className="flex justify-between">
          <span className="text-gray-400">Polar</span>
          <span className="text-white">{metadata.polar_file}</span>
        </div>
      )}
      {metadata.boat_profile_id != null && (
        <div className="flex justify-between">
          <span className="text-gray-400">Profile ID</span>
          <span className="text-white">{metadata.boat_profile_id}</span>
        </div>
      )}
    </div>
  );
}
