/** Trigger a browser-side file download from a string (CSV, etc.). */
export function downloadText(filename: string, content: string, mimeType = 'text/plain'): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function downloadCsv(filename: string, csv: string): void {
  downloadText(filename, csv, 'text/csv');
}
