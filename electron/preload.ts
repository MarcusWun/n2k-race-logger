import { contextBridge, ipcRenderer } from 'electron';

const api = {
  // Window controls
  windowMinimize: () => ipcRenderer.invoke('window:minimize'),
  windowMaximize: () => ipcRenderer.invoke('window:maximize'),
  windowClose: () => ipcRenderer.invoke('window:close'),

  // Debug
  openDebug: () => ipcRenderer.invoke('debug:open'),

  // Connection
  connect: (payload: { mode?: string; port?: string; baud?: number; host?: string; tcpPort?: number }) =>
    ipcRenderer.invoke('connection:connect', payload),
  disconnect: () => ipcRenderer.invoke('connection:disconnect'),
  listPorts: () => ipcRenderer.invoke('serial:list-ports'),

  // Recording
  startRecording: (payload: { label?: string }) =>
    ipcRenderer.invoke('recording:start', payload),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),
  getRecordingStatus: () => ipcRenderer.invoke('recording:status'),

  // Polar
  openPolarDialog: () => ipcRenderer.invoke('polar:open-dialog'),
  importPolar: (payload: { filePath: string }) =>
    ipcRenderer.invoke('polar:import', payload),
  listPolars: () => ipcRenderer.invoke('polar:list'),
  getPolar: (payload: { id: number }) =>
    ipcRenderer.invoke('polar:get', payload),
  getPerformance: (payload: { tws: number | null; twa: number | null; stw: number | null; profileId: number }) =>
    ipcRenderer.invoke('polar:performance', payload),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (payload: Record<string, any>) =>
    ipcRenderer.invoke('settings:set', payload),

  // Source discovery
  getSources: () => ipcRenderer.invoke('sources:get'),
  rescanSources: () => ipcRenderer.invoke('sources:rescan'),

  // Phase 2: Races & Analysis
  listRaces: () => ipcRenderer.invoke('races:list'),
  openRace: (payload: { filePath: string }) => ipcRenderer.invoke('races:open', payload),
  deleteRace: (payload: { filePath: string }) => ipcRenderer.invoke('races:delete', payload),
  getAnalysisData: () => ipcRenderer.invoke('analysis:data'),
  detectSegments: (payload: { thresholds: any }) => ipcRenderer.invoke('analysis:detect-segments', payload),
  getSegments: () => ipcRenderer.invoke('analysis:segments'),
  excludeSegment: (payload: { segmentId: number; excluded: boolean }) => ipcRenderer.invoke('analysis:exclude-segment', payload),
  saveSailTags: (payload: { raceId: number; tags: Array<{ config: string; start: string; end: string }> }) =>
    ipcRenderer.invoke('analysis:sail-tags', payload),
  getSailTags: (payload: { raceId: number }) => ipcRenderer.invoke('analysis:get-sail-tags', payload),
  getPerformanceSummary: () => ipcRenderer.invoke('analysis:performance-summary'),

  // Event listeners
  on: (channel: string, callback: (...args: any[]) => void) => {
    const validChannels = [
      'connection:status',
      'pgn:data',
      'recording:status',
      'serial:ports',
      'polar:profiles',
      'polar:data',
      'polar:performance',
      'sources:discovered',
      'settings:error',
      'analysis:data',
      'analysis:segments',
      'races:files',
    ];
    if (validChannels.includes(channel)) {
      const listener = (_event: any, ...args: any[]) => callback(...args);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    }
    return () => {};
  },

  removeAllListeners: (channel: string) => {
    ipcRenderer.removeAllListeners(channel);
  },
};

contextBridge.exposeInMainWorld('n2k', api);

export type N2KAPI = typeof api;
