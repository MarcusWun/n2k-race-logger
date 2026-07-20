import React from 'react';
import { useAnalysisStore } from '../../store/useAnalysisStore';
import { TWS_BANDS, TWA_BANDS } from '../../types/analysis';
import { downloadCsv } from '../../utils/download';

function cellColor(percent: number): string {
  if (percent >= 100) return 'bg-green-900/40 text-green-300';
  if (percent >= 90) return 'bg-yellow-900/40 text-yellow-300';
  return 'bg-red-900/40 text-red-300';
}

function bandKey(twsBand: [number, number], twaBand: [number, number]): string {
  return `${twsBand[0]}-${twsBand[1]}:${twaBand[0]}-${twaBand[1]}`;
}

function exportCsv(performanceSummary: import('../../types/analysis').PerformanceSummaryRow[]): void {
  // Header row
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

  const csv = rows.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(',')).join('\n');
  const date = new Date().toISOString().slice(0, 10);
  downloadCsv(`n2k-performance-summary-${date}.csv`, csv);
}

export default function PerformanceSummary() {
  const performanceSummary = useAnalysisStore((s) => s.performanceSummary);

  if (performanceSummary.length === 0) {
    return (
      <div className="text-gray-500 text-sm py-8 text-center">
        No performance data. Run segment detection and tag sails first.
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-end mb-2">
        <button
          onClick={() => exportCsv(performanceSummary)}
          className="px-3 py-1 rounded text-xs bg-gray-700 hover:bg-gray-600 text-white"
        >
          Export CSV
        </button>
      </div>
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr>
            <th className="text-left text-gray-400 px-2 py-1 sticky left-0 bg-n2k-bg z-10">Sail</th>
            {TWS_BANDS.map(([lo, hi]) => (
              <th key={`tws-${lo}-${hi}`} colSpan={TWA_BANDS.length} className="text-center text-gray-400 px-1 py-1 border-b border-gray-800">
                {lo}–{hi} kts TWS
              </th>
            ))}
            <th className="text-center text-gray-400 px-2 py-1">Avg %</th>
            <th className="text-center text-gray-400 px-2 py-1">Segs</th>
            <th className="text-center text-gray-400 px-2 py-1">Coverage</th>
          </tr>
          <tr>
            <th className="sticky left-0 bg-n2k-bg z-10" />
            {TWS_BANDS.flatMap(([twsLo, twsHi]) =>
              TWA_BANDS.map(([twaLo, twaHi]) => (
                <th key={`${twsLo}-${twsHi}:${twaLo}-${twaHi}`} className="text-center text-gray-500 px-1 py-0.5 font-normal">
                  {twaLo}–{twaHi}°
                </th>
              )),
            )}
            <th /><th /><th />
          </tr>
        </thead>
        <tbody>
          {performanceSummary.map((row) => (
            <tr key={row.sailConfig} className="border-t border-gray-800">
              <td className="text-white font-medium px-2 py-1.5 whitespace-nowrap sticky left-0 bg-n2k-bg z-10">
                {row.sailConfig}
              </td>
              {TWS_BANDS.flatMap(([twsLo, twsHi]) =>
                TWA_BANDS.map(([twaLo, twaHi]) => {
                  const key = bandKey([twsLo, twsHi], [twaLo, twaHi]);
                  const cell = row.cells[key];
                  return (
                    <td key={key} className={`text-center px-1 py-1.5 ${cell ? cellColor(cell.avgPercentPolar) : 'text-gray-700'}`}>
                      {cell ? `${cell.avgPercentPolar}%` : '—'}
                    </td>
                  );
                }),
              )}
              <td className={`text-center px-2 py-1.5 font-medium ${row.overallAvgPercent > 0 ? cellColor(row.overallAvgPercent) : 'text-gray-500'}`}>
                {row.overallAvgPercent > 0 ? `${row.overallAvgPercent}%` : '—'}
              </td>
              <td className="text-center text-gray-300 px-2 py-1.5">
                {row.totalSegments}
              </td>
              <td className="text-center text-gray-400 px-2 py-1.5">
                {row.coverage.filled}/{row.coverage.total}
                <span className="text-gray-600 ml-1">
                  ({Math.round((row.coverage.filled / row.coverage.total) * 100)}%)
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </div>
  );
}
