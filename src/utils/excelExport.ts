import { zipSync, strToU8 } from 'fflate';
import type { DetectedSegment, PerformanceSummaryRow } from '../types/analysis';
import { TWA_BANDS, TWS_BANDS } from '../types/analysis';
import { normalizeWindAngle } from './angles';
import { downloadBinary } from './download';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type CellValue = string | number | null | undefined;
type Fill = { fgColor?: { argb?: string } };
type Font = { bold?: boolean; italic?: boolean; color?: { argb?: string } };
type Alignment = { horizontal?: string; vertical?: string; wrapText?: boolean };

interface BorderSide {
  style?: string;
  color?: { argb?: string };
}

interface Border {
  top?: BorderSide;
  left?: BorderSide;
  bottom?: BorderSide;
  right?: BorderSide;
}

interface CellStyle {
  fill?: Fill;
  font?: Font;
  alignment?: Alignment;
  border?: Border;
  numFmt?: string;
}

export class WorkbookCell implements CellStyle {
  value: CellValue = null;
  fill?: Fill;
  font?: Font;
  alignment?: Alignment;
  border?: Border;
  numFmt?: string;

  constructor(public readonly rowNumber: number, public readonly colNumber: number) {}
}

export class WorkbookRow {
  height?: number;
  private readonly cells = new Map<number, WorkbookCell>();

  constructor(public readonly number: number) {}

  get values(): CellValue[] {
    const maxCol = Math.max(0, ...this.cells.keys());
    const values: CellValue[] = Array(maxCol + 1).fill(undefined);
    for (const [col, cell] of this.cells) values[col] = cell.value;
    return values;
  }

  set values(values: CellValue[]) {
    values.forEach((value, index) => {
      this.getCell(index + 1).value = value ?? null;
    });
  }

  getCell(col: number): WorkbookCell {
    let cell = this.cells.get(col);
    if (!cell) {
      cell = new WorkbookCell(this.number, col);
      this.cells.set(col, cell);
    }
    return cell;
  }

  eachCell(callback: (cell: WorkbookCell) => void): void {
    [...this.cells.keys()].sort((a, b) => a - b).forEach((col) => callback(this.getCell(col)));
  }
}

interface WorksheetView {
  state: 'frozen';
  ySplit: number;
  xSplit?: number;
}

interface AutoFilterRange {
  from: { row: number; column: number };
  to: { row: number; column: number };
}

interface WorksheetColumn {
  width: number;
}

interface MergeRange {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

export class WorkbookWorksheet {
  views: WorksheetView[] = [];
  autoFilter?: AutoFilterRange;
  columns: WorksheetColumn[] = [];
  properties = { defaultRowHeight: 18 };
  private readonly rows = new Map<number, WorkbookRow>();
  private readonly merges: MergeRange[] = [];

  constructor(public readonly name: string) {}

  getRow(rowNumber: number): WorkbookRow {
    let row = this.rows.get(rowNumber);
    if (!row) {
      row = new WorkbookRow(rowNumber);
      this.rows.set(rowNumber, row);
    }
    return row;
  }

  getCell(addressOrRow: string | number, col?: number): WorkbookCell {
    if (typeof addressOrRow === 'string') {
      const { row, column } = parseCellAddress(addressOrRow);
      return this.getRow(row).getCell(column);
    }
    return this.getRow(addressOrRow).getCell(col ?? 1);
  }

  addRow(values: CellValue[]): WorkbookRow {
    const nextRow = Math.max(0, ...this.rows.keys()) + 1;
    const row = this.getRow(nextRow);
    values.forEach((value, index) => {
      row.getCell(index + 1).value = value ?? null;
    });
    return row;
  }

  mergeCells(startRow: number, startCol: number, endRow: number, endCol: number): void {
    this.merges.push({ startRow, startCol, endRow, endCol });
  }

  eachRow(callback: (row: WorkbookRow) => void): void {
    [...this.rows.keys()].sort((a, b) => a - b).forEach((row) => callback(this.getRow(row)));
  }

  getRows(): WorkbookRow[] {
    return [...this.rows.keys()].sort((a, b) => a - b).map((row) => this.getRow(row));
  }

  getMerges(): MergeRange[] {
    return this.merges;
  }
}

export class Workbook {
  creator = 'N2K Race Logger';
  created = new Date();
  worksheets: WorkbookWorksheet[] = [];

  addWorksheet(name: string): WorkbookWorksheet {
    const sheet = new WorkbookWorksheet(name);
    this.worksheets.push(sheet);
    return sheet;
  }

  getWorksheet(name: string): WorkbookWorksheet | undefined {
    return this.worksheets.find((sheet) => sheet.name === name);
  }

  async writeBuffer(): Promise<Uint8Array> {
    return writeWorkbookBuffer(this);
  }
}

const HEADER_FILL: Fill = { fgColor: { argb: 'FF1F2937' } };
const SUBHEADER_FILL: Fill = { fgColor: { argb: 'FF374151' } };
const GREEN_FILL: Fill = { fgColor: { argb: 'FF166534' } };
const YELLOW_FILL: Fill = { fgColor: { argb: 'FF854D0E' } };
const RED_FILL: Fill = { fgColor: { argb: 'FF7F1D1D' } };
const EXCLUDED_FILL: Fill = { fgColor: { argb: 'FFE5E7EB' } };

function applyHeaderStyle(cell: WorkbookCell, fill: Fill = HEADER_FILL): void {
  cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  cell.fill = fill;
  cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  cell.border = {
    top: { style: 'thin', color: { argb: 'FF6B7280' } },
    left: { style: 'thin', color: { argb: 'FF6B7280' } },
    bottom: { style: 'thin', color: { argb: 'FF6B7280' } },
    right: { style: 'thin', color: { argb: 'FF6B7280' } },
  };
}

function applyPercentPolarStyle(cell: WorkbookCell, percent: number): void {
  if (percent >= 100) cell.fill = GREEN_FILL;
  else if (percent >= 90) cell.fill = YELLOW_FILL;
  else cell.fill = RED_FILL;
  cell.font = { color: { argb: 'FFFFFFFF' }, bold: true };
}

function styleWorksheetDefaults(sheet: WorkbookWorksheet): void {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.properties.defaultRowHeight = 18;
  sheet.eachRow((row) => {
    row.eachCell((cell) => {
      cell.alignment = { vertical: 'middle' };
    });
  });
}

function bandKey(twsBand: [number, number], twaBand: [number, number]): string {
  return `${twsBand[0]}-${twsBand[1]}:${twaBand[0]}-${twaBand[1]}`;
}

function elapsedLabel(iso: string, startMs: number): string {
  const ms = new Date(iso).getTime();
  const elapsed = Math.max(0, Math.floor((ms - startMs) / 1000));
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function coverageLabel(row: PerformanceSummaryRow): string {
  const percent = row.coverage.total > 0
    ? Math.round((row.coverage.filled / row.coverage.total) * 100)
    : 0;
  return `${row.coverage.filled}/${row.coverage.total} (${percent}%)`;
}

export function createPerformanceSummaryWorkbook(
  performanceSummary: PerformanceSummaryRow[],
): Workbook {
  const workbook = new Workbook();

  const sheet = workbook.addWorksheet('Performance Summary');
  sheet.views = [{ state: 'frozen', ySplit: 2, xSplit: 1 }];

  const headerRow = sheet.getRow(1);
  const subheaderRow = sheet.getRow(2);
  headerRow.height = 24;
  subheaderRow.height = 22;

  sheet.mergeCells(1, 1, 2, 1);
  sheet.getCell(1, 1).value = 'Sail';

  let col = 2;
  for (const [twsLo, twsHi] of TWS_BANDS) {
    const groupStart = col;
    const groupEnd = col + TWA_BANDS.length - 1;
    sheet.mergeCells(1, groupStart, 1, groupEnd);
    sheet.getCell(1, groupStart).value = `${twsLo}-${twsHi} kts TWS`;
    for (const [twaLo, twaHi] of TWA_BANDS) {
      sheet.getCell(2, col).value = `${twaLo}-${twaHi} deg TWA`;
      col += 1;
    }
  }

  const avgCol = col;
  const segmentsCol = col + 1;
  const coverageCol = col + 2;
  sheet.mergeCells(1, avgCol, 2, avgCol);
  sheet.mergeCells(1, segmentsCol, 2, segmentsCol);
  sheet.mergeCells(1, coverageCol, 2, coverageCol);
  sheet.getCell(1, avgCol).value = 'Avg %';
  sheet.getCell(1, segmentsCol).value = 'Segments';
  sheet.getCell(1, coverageCol).value = 'Coverage';

  for (let c = 1; c <= coverageCol; c += 1) {
    applyHeaderStyle(sheet.getCell(1, c));
    applyHeaderStyle(sheet.getCell(2, c), SUBHEADER_FILL);
  }

  performanceSummary.forEach((summaryRow, index) => {
    const excelRow = sheet.getRow(index + 3);
    const values: Array<string | number | null> = [summaryRow.sailConfig];
    for (const twsBand of TWS_BANDS) {
      for (const twaBand of TWA_BANDS) {
        const cell = summaryRow.cells[bandKey(twsBand, twaBand)];
        values.push(cell ? cell.avgPercentPolar : null);
      }
    }
    values.push(
      summaryRow.overallAvgPercent > 0 ? summaryRow.overallAvgPercent : null,
      summaryRow.totalSegments,
      coverageLabel(summaryRow),
    );
    excelRow.values = values;

    for (let c = 2; c < avgCol; c += 1) {
      const cell = excelRow.getCell(c);
      cell.numFmt = '0"%"';
      if (typeof cell.value === 'number') applyPercentPolarStyle(cell, cell.value);
    }

    const overallCell = excelRow.getCell(avgCol);
    overallCell.numFmt = '0"%"';
    if (typeof overallCell.value === 'number') applyPercentPolarStyle(overallCell, overallCell.value);
  });

  sheet.autoFilter = { from: { row: 2, column: 1 }, to: { row: 2, column: coverageCol } };
  sheet.columns = [
    { width: 22 },
    ...Array(TWS_BANDS.length * TWA_BANDS.length).fill(null).map(() => ({ width: 13 })),
    { width: 10 },
    { width: 10 },
    { width: 14 },
  ];

  return workbook;
}

export function createSegmentListWorkbook(
  segments: DetectedSegment[],
  startMs: number,
): Workbook {
  const workbook = new Workbook();

  const sheet = workbook.addWorksheet('Segment List');
  const headers = [
    'Start Time',
    'Duration (s)',
    'Sail Config',
    'TWS (kts)',
    'TWA (deg)',
    'TWA Side',
    'STW (kts)',
    '% Polar',
    'sigma TWS',
    'sigma TWA',
    'sigma STW',
    'Excluded',
  ];
  sheet.addRow(headers);
  headers.forEach((_, index) => applyHeaderStyle(sheet.getCell(1, index + 1)));

  segments.forEach((segment) => {
    const twa = normalizeWindAngle(segment.meanTwa);
    const row = sheet.addRow([
      elapsedLabel(segment.startTime, startMs),
      Math.round(segment.durationS),
      segment.sailConfig || '',
      segment.meanTws,
      twa.angle,
      twa.side,
      segment.meanStw,
      segment.percentPolar,
      segment.stdTws,
      segment.stdTwa,
      segment.stdStw,
      segment.excluded ? 'Yes' : 'No',
    ]);

    row.getCell(2).numFmt = '0';
    row.getCell(4).numFmt = '0.0';
    row.getCell(5).numFmt = '0" deg"';
    row.getCell(7).numFmt = '0.0';
    row.getCell(8).numFmt = '0"%"';
    row.getCell(9).numFmt = '0.00';
    row.getCell(10).numFmt = '0.0';
    row.getCell(11).numFmt = '0.00';

    const percentCell = row.getCell(8);
    if (typeof percentCell.value === 'number') applyPercentPolarStyle(percentCell, percentCell.value);

    if (segment.excluded) {
      row.eachCell((cell) => {
        cell.fill = EXCLUDED_FILL;
        cell.font = { color: { argb: 'FF6B7280' }, italic: true };
      });
    }
  });

  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
  sheet.columns = [
    { width: 12 },
    { width: 12 },
    { width: 20 },
    { width: 10 },
    { width: 10 },
    { width: 9 },
    { width: 10 },
    { width: 10 },
    { width: 10 },
    { width: 10 },
    { width: 10 },
    { width: 10 },
  ];
  styleWorksheetDefaults(sheet);

  return workbook;
}

export async function downloadWorkbook(filename: string, workbook: Workbook): Promise<void> {
  const buffer = await workbook.writeBuffer();
  downloadBinary(filename, toArrayBuffer(buffer), XLSX_MIME);
}

export function exportPerformanceSummaryExcel(performanceSummary: PerformanceSummaryRow[]): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  return downloadWorkbook(
    `n2k-performance-summary-${date}.xlsx`,
    createPerformanceSummaryWorkbook(performanceSummary),
  );
}

export function exportSegmentListExcel(segments: DetectedSegment[], startMs: number): Promise<void> {
  const date = new Date().toISOString().slice(0, 10);
  return downloadWorkbook(
    `n2k-segments-${date}.xlsx`,
    createSegmentListWorkbook(segments, startMs),
  );
}

function writeWorkbookBuffer(workbook: Workbook): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': xmlFile(contentTypesXml(workbook)),
    '_rels/.rels': xmlFile(rootRelsXml()),
    'docProps/core.xml': xmlFile(coreXml(workbook)),
    'docProps/app.xml': xmlFile(appXml(workbook)),
    'xl/workbook.xml': xmlFile(workbookXml(workbook)),
    'xl/_rels/workbook.xml.rels': xmlFile(workbookRelsXml(workbook)),
    'xl/styles.xml': xmlFile(stylesXml(workbook)),
  };

  workbook.worksheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = xmlFile(worksheetXml(sheet, workbook));
  });

  return zipSync(files, { level: 6 });
}

function xmlFile(xml: string): Uint8Array {
  return strToU8(xml);
}

function toArrayBuffer(buffer: Uint8Array): ArrayBuffer {
  const arrayBuffer = new ArrayBuffer(buffer.byteLength);
  new Uint8Array(arrayBuffer).set(buffer);
  return arrayBuffer;
}

function contentTypesXml(workbook: Workbook): string {
  const sheets = workbook.worksheets
    .map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;
}

function rootRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function coreXml(workbook: Workbook): string {
  const created = workbook.created.toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:creator>${escapeXml(workbook.creator)}</dc:creator>
<cp:lastModifiedBy>${escapeXml(workbook.creator)}</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${created}</dcterms:created>
<dcterms:modified xsi:type="dcterms:W3CDTF">${created}</dcterms:modified>
</cp:coreProperties>`;
}

function appXml(workbook: Workbook): string {
  const sheetNames = workbook.worksheets.map((sheet) => `<vt:lpstr>${escapeXml(sheet.name)}</vt:lpstr>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
<Application>N2K Race Logger</Application>
<TitlesOfParts><vt:vector size="${workbook.worksheets.length}" baseType="lpstr">${sheetNames}</vt:vector></TitlesOfParts>
</Properties>`;
}

function workbookXml(workbook: Workbook): string {
  const sheets = workbook.worksheets
    .map((sheet, index) => `<sheet name="${escapeXmlAttribute(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets}</sheets>
</workbook>`;
}

function workbookRelsXml(workbook: Workbook): string {
  const sheetRels = workbook.worksheets
    .map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheetRels}
<Relationship Id="rId${workbook.worksheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function worksheetXml(sheet: WorkbookWorksheet, workbook: Workbook): string {
  const maxRow = Math.max(1, ...sheet.getRows().map((row) => row.number));
  const maxCol = Math.max(1, sheet.columns.length, ...sheet.getRows().flatMap((row) => row.values.map((_, index) => index)));
  const rows = sheet.getRows().map((row) => rowXml(row, workbook)).join('');
  const columns = sheet.columns.length > 0
    ? `<cols>${sheet.columns.map((col, index) => `<col min="${index + 1}" max="${index + 1}" width="${col.width}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const panes = sheet.views[0] ? paneXml(sheet.views[0]) : '';
  const autoFilter = sheet.autoFilter
    ? `<autoFilter ref="${cellRef(sheet.autoFilter.from.row, sheet.autoFilter.from.column)}:${cellRef(sheet.autoFilter.to.row, sheet.autoFilter.to.column)}"/>`
    : '';
  const merges = sheet.getMerges().length > 0
    ? `<mergeCells count="${sheet.getMerges().length}">${sheet.getMerges().map((merge) => `<mergeCell ref="${cellRef(merge.startRow, merge.startCol)}:${cellRef(merge.endRow, merge.endCol)}"/>`).join('')}</mergeCells>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${cellRef(maxRow, maxCol)}"/>
<sheetViews>${panes}</sheetViews>
<sheetFormatPr defaultRowHeight="${sheet.properties.defaultRowHeight}"/>
${columns}
<sheetData>${rows}</sheetData>
${autoFilter}
${merges}
</worksheet>`;
}

function paneXml(view: WorksheetView): string {
  const xSplit = view.xSplit ?? 0;
  const ySplit = view.ySplit;
  const topLeftCell = cellRef(ySplit + 1, xSplit + 1);
  const activePane = xSplit > 0 && ySplit > 0 ? 'bottomRight' : ySplit > 0 ? 'bottomLeft' : 'topRight';
  return `<sheetView workbookViewId="0"><pane xSplit="${xSplit}" ySplit="${ySplit}" topLeftCell="${topLeftCell}" activePane="${activePane}" state="frozen"/></sheetView>`;
}

function rowXml(row: WorkbookRow, workbook: Workbook): string {
  const cells = row.values
    .map((_, index) => index)
    .filter((col) => col > 0)
    .map((col) => cellXml(row.getCell(col), workbook))
    .join('');
  const height = row.height ? ` ht="${row.height}" customHeight="1"` : '';
  return `<row r="${row.number}"${height}>${cells}</row>`;
}

function cellXml(cell: WorkbookCell, workbook: Workbook): string {
  const ref = cellRef(cell.rowNumber, cell.colNumber);
  const styleId = styleIdFor(workbook, cell);
  const style = styleId > 0 ? ` s="${styleId}"` : '';

  if (typeof cell.value === 'number') return `<c r="${ref}"${style}><v>${cell.value}</v></c>`;
  if (typeof cell.value === 'string') return `<c r="${ref}" t="inlineStr"${style}><is><t>${escapeXml(cell.value)}</t></is></c>`;
  return `<c r="${ref}"${style}/>`;
}

function stylesXml(workbook: Workbook): string {
  const styles = collectStyles(workbook);
  const numFmts = styles.numFmts
    .map((fmt, index) => `<numFmt numFmtId="${164 + index}" formatCode="${escapeXmlAttribute(fmt)}"/>`)
    .join('');
  const fonts = styles.fonts.map((font) => {
    const bold = font.bold ? '<b/>' : '';
    const italic = font.italic ? '<i/>' : '';
    const color = font.color?.argb ? `<color rgb="${font.color.argb}"/>` : '';
    return `<font>${bold}${italic}${color}<sz val="11"/><name val="Calibri"/></font>`;
  }).join('');
  const fills = styles.fills.map((fill) => {
    if (!fill.fgColor?.argb) return '<fill><patternFill patternType="none"/></fill>';
    return `<fill><patternFill patternType="solid"><fgColor rgb="${fill.fgColor.argb}"/><bgColor indexed="64"/></patternFill></fill>`;
  }).join('');
  const borders = styles.borders.map((border) => `<border>${borderSideXml('left', border.left)}${borderSideXml('right', border.right)}${borderSideXml('top', border.top)}${borderSideXml('bottom', border.bottom)}<diagonal/></border>`).join('');
  const cellXfs = styles.cellXfs.map((style) => {
    const numFmtId = style.numFmt ? 164 + styles.numFmts.indexOf(style.numFmt) : 0;
    const applyNumberFormat = style.numFmt ? ' applyNumberFormat="1"' : '';
    const applyFont = style.fontId > 0 ? ' applyFont="1"' : '';
    const applyFill = style.fillId > 0 ? ' applyFill="1"' : '';
    const applyBorder = style.borderId > 0 ? ' applyBorder="1"' : '';
    const alignment = style.alignment
      ? `<alignment${style.alignment.horizontal ? ` horizontal="${style.alignment.horizontal}"` : ''}${style.alignment.vertical ? ` vertical="${style.alignment.vertical}"` : ''}${style.alignment.wrapText ? ' wrapText="1"' : ''}/>`
      : '';
    return `<xf numFmtId="${numFmtId}" fontId="${style.fontId}" fillId="${style.fillId}" borderId="${style.borderId}" xfId="0"${applyNumberFormat}${applyFont}${applyFill}${applyBorder}>${alignment}</xf>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
${styles.numFmts.length > 0 ? `<numFmts count="${styles.numFmts.length}">${numFmts}</numFmts>` : ''}
<fonts count="${styles.fonts.length}">${fonts}</fonts>
<fills count="${styles.fills.length}">${fills}</fills>
<borders count="${styles.borders.length}">${borders}</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="${styles.cellXfs.length}">${cellXfs}</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function borderSideXml(name: string, side?: BorderSide): string {
  if (!side?.style) return `<${name}/>`;
  const color = side.color?.argb ? `<color rgb="${side.color.argb}"/>` : '';
  return `<${name} style="${side.style}">${color}</${name}>`;
}

interface StyleCollections {
  numFmts: string[];
  fonts: Font[];
  fills: Fill[];
  borders: Border[];
  cellXfs: Array<CellStyle & { fontId: number; fillId: number; borderId: number }>;
  styleIds: Map<WorkbookCell, number>;
}

function collectStyles(workbook: Workbook): StyleCollections {
  const styles: StyleCollections = {
    numFmts: [],
    fonts: [{}],
    fills: [{}, {}],
    borders: [{}],
    cellXfs: [{ fontId: 0, fillId: 0, borderId: 0 }],
    styleIds: new Map(),
  };

  workbook.worksheets.forEach((sheet) => {
    sheet.getRows().forEach((row) => {
      row.eachCell((cell) => {
        const key = styleKey(cell);
        if (key === '{}') return;
        const fontId = indexFor(styles.fonts, cell.font ?? {});
        const fillId = cell.fill ? indexFor(styles.fills, cell.fill) : 0;
        const borderId = cell.border ? indexFor(styles.borders, cell.border) : 0;
        if (cell.numFmt && !styles.numFmts.includes(cell.numFmt)) styles.numFmts.push(cell.numFmt);

        const xf = {
          numFmt: cell.numFmt,
          font: cell.font,
          fill: cell.fill,
          alignment: cell.alignment,
          border: cell.border,
          fontId,
          fillId,
          borderId,
        };
        const styleId = indexFor(styles.cellXfs, xf);
        styles.styleIds.set(cell, styleId);
      });
    });
  });

  return styles;
}

function styleIdFor(workbook: Workbook, cell: WorkbookCell): number {
  return collectStyles(workbook).styleIds.get(cell) ?? 0;
}

function indexFor<T>(items: T[], value: T): number {
  const key = JSON.stringify(value);
  const index = items.findIndex((item) => JSON.stringify(item) === key);
  if (index >= 0) return index;
  items.push(value);
  return items.length - 1;
}

function styleKey(cell: WorkbookCell): string {
  return JSON.stringify({
    fill: cell.fill,
    font: cell.font,
    alignment: cell.alignment,
    border: cell.border,
    numFmt: cell.numFmt,
  });
}

function parseCellAddress(address: string): { row: number; column: number } {
  const match = /^([A-Z]+)(\d+)$/.exec(address);
  if (!match) throw new Error(`Invalid cell address: ${address}`);
  return { column: columnNumber(match[1]), row: Number(match[2]) };
}

function columnNumber(letters: string): number {
  return letters.split('').reduce((total, letter) => total * 26 + letter.charCodeAt(0) - 64, 0);
}

function columnLetters(col: number): string {
  let current = col;
  let letters = '';
  while (current > 0) {
    const remainder = (current - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    current = Math.floor((current - 1) / 26);
  }
  return letters;
}

function cellRef(row: number, col: number): string {
  return `${columnLetters(col)}${row}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlAttribute(value: string): string {
  return escapeXml(value).replace(/"/g, '&quot;');
}
