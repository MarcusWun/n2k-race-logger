import { create } from 'zustand';

interface RaceStore {
  isRecording: boolean;
  elapsed: number;
  recordCount: number;
  fileSize: number;
  timerRef: NodeJS.Timeout | null;
  startRecording: () => void;
  stopRecording: () => void;
  updateStats: (count: number, fileSize: number) => void;
  tick: () => void;
}

export const useRaceStore = create<RaceStore>((set) => ({
  isRecording: false,
  elapsed: 0,
  recordCount: 0,
  fileSize: 0,
  timerRef: null,

  startRecording: () => {
    set({ isRecording: true, elapsed: 0, recordCount: 0, fileSize: 0 });
  },

  stopRecording: () => {
    set({ isRecording: false });
  },

  updateStats: (count, fileSize) => {
    set({ recordCount: count, fileSize });
  },

  tick: () => {
    set((state) => ({ elapsed: state.elapsed + 1 }));
  },
}));
