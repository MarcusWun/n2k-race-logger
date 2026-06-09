import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('n2kDebug', {
  onData: (callback: (timestamp: string, line: string) => void) => {
    ipcRenderer.on('debug:data', (_event, timestamp: string, line: string) => {
      callback(timestamp, line);
    });
  },
  close: () => ipcRenderer.invoke('debug:close'),
});
