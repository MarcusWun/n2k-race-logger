/** Safe accessor for the Electron IPC bridge exposed via preload. */
export function getIPC() {
  return (window as any).n2k as Window['n2k'] | undefined;
}
