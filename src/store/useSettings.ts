import { create } from 'zustand';
import type { AppSettings } from '../types/ipc';

const defaultSettings: AppSettings = {
  serialPort: 'COM3',
  serialBaud: 115200,
  pgnFilter: [128259, 129025, 129026, 129029, 127250, 130306, 130310, 127257, 129284],
  dataDirectory: '~/n2k-race-logger/races/',
  polarDirectory: '~/n2k-race-logger/polars/',
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
