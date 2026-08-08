import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import type { DetectedSegment, PerformanceSummaryRow } from '../src/types/analysis';
import { TWA_BANDS, TWS_BANDS } from '../src/types/analysis';
import { buildPerformanceSummaryCsv, buildSegmentsCsv } from '../src/utils/csvExport';
import { createPerformanceSummaryWorkbook, createSegmentListWorkbook } from '../src/utils/excelExport';

const totalBands = TWS_BANDS.length * TWA_BANDS.length;

const sampleSummary: PerformanceSummaryRow[] = [{
  sailConfig: 'J2 + Main',
  cells: {
    '6-8:40-60': { avgPercentPolar: 101, segmentCount: 3 },
    '6-8:60-90': { avgPercentPolar: 95, segmentCount: 2 },
    '6-8:90-120': { avgPercentPolar: 89, segmentCount: 1 },
  },
  overallAvgPercent: 96,
  totalSegments: 6,
  coverage: { filled: 3, total: totalBands },
}];

const sampleSegments: DetectedSegment[] = [
  {
    id: 1,
    raceId: 10,
    startTime: '2026-07-29T18:02:05.000Z',
    endTime: '2026-07-29T18:03:36.000Z',
    durationS: 91.4,
    meanTws: 12.34,
    meanTwa: 315,
    meanStw: 6.78,
    meanVmg: 6.78 * Math.cos(315 * Math.PI / 180), // ~4.79
    stdTws: 0.23,
    stdTwa: 4.5,
    stdStw: 0.12,
    percentPolar: 101,
    sailConfig: 'J2 + Main',
    excluded: false,
    thresholds: { tws: 1.5, twa: 10, stw: 0.5, minDuration: 60 },
  },
  {
    id: 2,
    raceId: 10,
    startTime: '2026-07-29T18:04:10.000Z',
    endTime: '2026-07-29T18:05:20.000Z',
    durationS: 70.2,
    meanTws: 9.1,
    meanTwa: 88,
    meanStw: 5.4,
    meanVmg: 5.4 * Math.cos(88 * Math.PI / 180), // ~0.19
    stdTws: 0.31,
    stdTwa: 3.2,
    stdStw: 0.19,
    percentPolar: 88,
    sailConfig: 'A3 + Main',
    excluded: true,
    thresholds: { tws: 1.5, twa: 10, stw: 0.5, minDuration: 60 },
  },
];

function fillColor(cell: { fill?: unknown }): string | undefined {
  const fill = cell.fill as { fgColor?: { argb?: string } } | undefined;
  return fill?.fgColor?.argb;
}

describe('Phase 2.4 Performance Summary Excel export', () => {
  it('creates the expected sheet, grouped headers, key column order, and formats', () => {
    const workbook = createPerformanceSummaryWorkbook(sampleSummary);
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Performance Summary']);

    const sheet = workbook.getWorksheet('Performance Summary')!;
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 2, xSplit: 1 });
    expect(sheet.autoFilter).toEqual({ from: { row: 2, column: 1 }, to: { row: 2, column: 29 } });
    expect(sheet.getCell('A1').value).toBe('Sail');
    expect(sheet.getCell('B1').value).toBe('6-8 kts TWS');
    expect(sheet.getCell('B2').value).toBe('40-60 deg TWA');
    expect(sheet.getCell('Z2').value).toBe('150-180 deg TWA');
    expect(sheet.getCell('AA1').value).toBe('Avg %');
    expect(sheet.getCell('AB1').value).toBe('Segments');
    expect(sheet.getCell('AC1').value).toBe('Coverage');

    expect(sheet.getCell('B3').value).toBe(101);
    expect(sheet.getCell('C3').value).toBe(95);
    expect(sheet.getCell('D3').value).toBe(89);
    expect(sheet.getCell('AA3').value).toBe(96);
    expect(sheet.getCell('AB3').value).toBe(6);
    expect(sheet.getCell('AC3').value).toBe('3/25 (12%)');
    expect(sheet.getCell('B3').numFmt).toBe('0"%"');
    expect(sheet.getCell('AA3').numFmt).toBe('0"%"');
  });

  it('applies app-matching % Polar threshold styling', () => {
    const sheet = createPerformanceSummaryWorkbook(sampleSummary).getWorksheet('Performance Summary')!;
    expect(fillColor(sheet.getCell('B3'))).toBe('FF166534');
    expect(fillColor(sheet.getCell('C3'))).toBe('FF854D0E');
    expect(fillColor(sheet.getCell('D3'))).toBe('FF7F1D1D');
  });

  it('serializes to a valid local XLSX package with workbook and worksheet parts', async () => {
    const workbook = createPerformanceSummaryWorkbook(sampleSummary);
    const files = unzipSync(await workbook.writeBuffer());

    expect(files['[Content_Types].xml']).toBeDefined();
    expect(files['xl/workbook.xml']).toBeDefined();
    expect(files['xl/worksheets/sheet1.xml']).toBeDefined();
    expect(strFromU8(files['xl/workbook.xml'])).toContain('Performance Summary');
    expect(strFromU8(files['xl/worksheets/sheet1.xml'])).toContain('autoFilter ref="A2:AC2"');
  });
});

describe('Phase 2.4 Segment List Excel export', () => {
  it('creates the expected sheet, headers, key column order, numeric values, and formats', () => {
    const workbook = createSegmentListWorkbook(sampleSegments, new Date('2026-07-29T18:00:00.000Z').getTime());
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Segment List']);

    const sheet = workbook.getWorksheet('Segment List')!;
    expect(sheet.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(sheet.autoFilter).toEqual({ from: { row: 1, column: 1 }, to: { row: 1, column: 13 } });
    expect(sheet.getRow(1).values).toEqual([
      undefined,
      'Start Time',
      'Duration (s)',
      'Sail Config',
      'TWS (kts)',
      'TWA (deg)',
      'TWA Side',
      'STW (kts)',
      'VMG (kts)',
      '% Polar',
      'sigma TWS',
      'sigma TWA',
      'sigma STW',
      'Excluded',
    ]);

    expect(sheet.getCell('A2').value).toBe('2:05');
    expect(sheet.getCell('B2').value).toBe(91);
    expect(sheet.getCell('D2').value).toBe(12.34);
    expect(sheet.getCell('E2').value).toBe(45);
    expect(sheet.getCell('F2').value).toBe('P');
    expect(sheet.getCell('G2').value).toBe(6.78);
    // H2 = VMG
    expect(sheet.getCell('I2').value).toBe(101); // % Polar shifted to col 9
    expect(sheet.getCell('J2').value).toBe(0.23);
    expect(sheet.getCell('K2').value).toBe(4.5);
    expect(sheet.getCell('L2').value).toBe(0.12);
    expect(sheet.getCell('D2').numFmt).toBe('0.0');
    expect(sheet.getCell('E2').numFmt).toBe('0" deg"');
    expect(sheet.getCell('H2').numFmt).toBe('0.00'); // VMG format
    expect(sheet.getCell('I2').numFmt).toBe('0"%"'); // % Polar shifted
  });

  it('applies % Polar colors and visually distinguishes excluded rows', () => {
    const sheet = createSegmentListWorkbook(sampleSegments, new Date('2026-07-29T18:00:00.000Z').getTime()).getWorksheet('Segment List')!;
    expect(fillColor(sheet.getCell('I2'))).toBe('FF166534'); // % Polar ≥ 100 → green (col 9)
    expect(fillColor(sheet.getCell('I3'))).toBe('FFE5E7EB'); // excluded row styling
    expect(sheet.getCell('M3').value).toBe('Yes'); // Excluded column is col 13 (M)
  });
});

describe('Phase 2.4 CSV regression safety', () => {
  it('keeps performance summary CSV shape and percent text unchanged', () => {
    const csv = buildPerformanceSummaryCsv(sampleSummary);
    expect(csv.split('\n')[0]).toContain('"Sail","TWS 6-8 / TWA 40-60°"');
    expect(csv.split('\n')[1]).toContain('"J2 + Main","101%","95%","89%"');
    expect(csv.split('\n')[1].endsWith('"96%","6","3/25"')).toBe(true);
  });

  it('keeps segment CSV normalized wind angle text and standard deviation columns unchanged', () => {
    const csv = buildSegmentsCsv(sampleSegments, new Date('2026-07-29T18:00:00.000Z').getTime());
    expect(csv.split('\n')[0]).toBe('"Start Time","Duration (s)","Sail Config","TWS (kts)","TWA (°)","STW (kts)","VMG (kts)","% Polar","σ TWS","σ TWA","σ STW","Excluded"');
    expect(csv.split('\n')[1]).toContain('"2:05","91","J2 + Main","12.3","45°P","6.8"');
    expect(csv.split('\n')[1]).toContain('"101%","0.23","4.5","0.12","No"');
  });
});
