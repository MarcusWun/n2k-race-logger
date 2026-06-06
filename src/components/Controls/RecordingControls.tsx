import React, { useState, useEffect, useRef } from 'react';
import { useRaceStore } from '../../store/useRaceStore';
import { getIPC } from '../../ipc';

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export default function RecordingControls() {
  const { isRecording, elapsed, recordCount, startRecording, stopRecording, tick } = useRaceStore();
  const [label, setLabel] = useState('');
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (isRecording) {
      timerRef.current = setInterval(() => tick(), 1000);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isRecording, tick]);

  const handleToggle = async () => {
    const ipc = getIPC();
    if (isRecording) {
      if (ipc) await ipc.stopRecording();
      stopRecording();
    } else {
      if (ipc) await ipc.startRecording({ label: label || undefined });
      startRecording();
    }
  };

  return (
    <div className="flex items-center gap-3 bg-n2k-surface rounded-lg px-4 py-2">
      {!isRecording && (
        <input
          type="text"
          placeholder="Race label (optional)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="bg-n2k-bg border border-gray-700 rounded px-2 py-1 text-sm text-white flex-1 min-w-0"
        />
      )}

      <button
        onClick={handleToggle}
        className={`px-4 py-1 rounded text-sm font-medium flex items-center gap-2 ${
          isRecording
            ? 'bg-n2k-danger hover:bg-red-600 text-white'
            : 'bg-n2k-success hover:bg-green-400 text-black'
        }`}
      >
        <span className={`w-2 h-2 rounded-full ${isRecording ? 'bg-white animate-pulse' : 'bg-black'}`} />
        {isRecording ? 'Stop Recording' : 'Start Recording'}
      </button>

      {isRecording && (
        <>
          <span className="text-white font-mono text-sm">{formatElapsed(elapsed)}</span>
          <span className="text-gray-400 text-xs">{recordCount} pts</span>
        </>
      )}
    </div>
  );
}
