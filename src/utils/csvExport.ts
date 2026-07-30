import type { DetectedSegment, PerformanceSummaryRow } from '../types/analysis';
import { TWA_BANDS, TWS_BANDS } from '../types/analysis';
import { formatWindAngle } from './angles';

function csv(rows: string[][]): string {
  return rows.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(',')).join('\n');
}

export function buildPerformanceSummaryCsv(performanceSummary: PerformanceSummaryRow[]): string {
  const bandHeaders = TWS_BANDS.flatMap(([twsLo, twsHi]) =>
    TWA_BANDS.map(([twaLo, twaHi]) => `TWS ${twsLo}-${twsHi} / TWA ${twaLo}-${twaHi}°`),
  );
  const headers = ['Sail', ...bandHeaders, 'Avg %', 'Segments', 'Coverage'];
  const rows: string[][] = [headers];

  for (const row of performanceSummary) {
    const cells = TWS_BANDS.flatMap(([twsLo, twsHi]) =>
      TWA_BANDS.map(([twaLo, twaHi]) => {
        const key = `${twsLo}-${twsHi}:${twaLo}-${twaHi}`;
        const cell = row.cells[key];
        return cell ? `${cell.avgPercentPolar}%` : '';
      }),
    );
    rows.push([
      row.sailConfig,
      ...cells,
      row.overallAvgPercent > 0 ? `${row.overallAvgPercent}%` : '',
      String(row.totalSegments),
      `${row.coverage.filled}/${row.coverage.total}`,
    ]);
  }

  return csv(rows);
}

export function buildSegmentsCsv(segments: DetectedSegment[], startMs: number): string {
  const headers = ['Start Time', 'Duration (s)', 'Sail Config', 'TWS (kts)', 'TWA (°)', 'STW (kts)', '% Polar', 'σ TWS', 'σ TWA', 'σ STW', 'Excluded'];
  const rows: string[][] = [headers];

  for (const seg of segments) {
    const ms = new Date(seg.startTime).getTime();
    const elapsed = Math.floor((ms - startMs) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    const startLabel = `${m}:${String(s).padStart(2, '0')}`;

    rows.push([
      startLabel,
      String(Math.round(seg.durationS)),
      seg.sailConfig || '',
      seg.meanTws.toFixed(1),
      formatWindAngle(seg.meanTwa),
      seg.meanStw.toFixed(1),
      seg.percentPolar != null ? `${seg.percentPolar}%` : '',
      seg.stdTws.toFixed(2),
      seg.stdTwa.toFixed(1),
      seg.stdStw.toFixed(2),
      seg.excluded ? 'Yes' : 'No',
    ]);
  }

  return csv(rows);
}
