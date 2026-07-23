import { create } from 'zustand';
import type { AppSettings } from '../types/ipc';

const defaultSettings: AppSettings = {
  serialPort: 'COM3',
  serialBaud: 115200,
  pgnFilter: [128259, 129025, 129026, 129029, 127250, 130306, 130310, 127257, 129284],
  sourcePreferences: { 130306: 16 },
  dataDirectory: '~/n2k-race-logger/races/',
  polarDirectory: '~/n2k-race-logger/polars/',
  connectionMode: 'serial',
  tcpHost: '192.168.1.1',
  tcpPort: 2000,
  sailInventory: [
    { id: 'j1-main', label: 'J1 + Main' },
    { id: 'j2-main', label: 'J2 + Main' },
    { id: 'j3-main', label: 'J3 + Main' },
    { id: 'a2-main', label: 'A2 + Main' },
    { id: 'a3-main', label: 'A3 + Main' },
    { id: 'j2-reef1', label: 'J2 + Main + 1 reef' },
    { id: 'j3-reef1', label: 'J3 + Main + 1 reef' },
  ],
};

interface SettingsStore {
  settings: AppSettings;
  setSettings: (settings: AppSettings) => void;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  settings: defaultSettings,
  setSettings: (settings) => set({ settings }),
  updateSetting: (key, value) =>
    set((state) => ({ settings: { ...state.settings, [key]: value } })),
}));
