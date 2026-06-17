import React, { useState } from 'react';
import Dashboard from './components/Dashboard/Dashboard';
import PolarView from './components/PolarView/PolarView';
import Settings from './components/Settings/Settings';
import { getIPC } from './ipc';

type Tab = 'dashboard' | 'polar' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'polar', label: 'Polar' },
  { id: 'settings', label: 'Settings' },
];

function WindowControls() {
  const ipc = getIPC();
  return (
    <div className="flex items-center ml-auto app-no-drag">
      <button
        onClick={() => ipc?.windowMinimize()}
        className="w-10 h-8 flex items-center justify-center text-gray-400 hover:bg-gray-700 hover:text-white transition-colors"
        title="Minimize"
      >
        <svg width="10" height="1" viewBox="0 0 10 1"><rect fill="currentColor" width="10" height="1"/></svg>
      </button>
      <button
        onClick={() => ipc?.windowMaximize()}
        className="w-10 h-8 flex items-center justify-center text-gray-400 hover:bg-gray-700 hover:text-white transition-colors"
        title="Maximize"
      >
        <svg width="10" height="10" viewBox="0 0 10 10"><rect fill="none" stroke="currentColor" strokeWidth="1" x="0.5" y="0.5" width="9" height="9"/></svg>
      </button>
      <button
        onClick={() => ipc?.windowClose()}
        className="w-10 h-8 flex items-center justify-center text-gray-400 hover:bg-red-600 hover:text-white transition-colors"
        title="Close"
      >
        <svg width="10" height="10" viewBox="0 0 10 10"><line stroke="currentColor" strokeWidth="1.2" x1="1" y1="1" x2="9" y2="9"/><line stroke="currentColor" strokeWidth="1.2" x1="9" y1="1" x2="1" y2="9"/></svg>
      </button>
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');

  return (
    <div className="h-screen bg-n2k-bg text-white flex flex-col">
      {/* Header / Nav */}
      <header className="flex items-center bg-n2k-surface border-b border-gray-800 px-4 py-0 shrink-0 app-drag">
        <span className="text-sm font-bold text-n2k-accent mr-6 py-2">N2K Race Logger</span>
        <nav className="flex gap-1 app-no-drag">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium rounded-t transition-colors ${
                activeTab === tab.id
                  ? 'bg-n2k-bg text-white'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        <WindowControls />
      </header>

      {/* Content */}
      <main className="flex-1 p-4 overflow-y-auto">
        {activeTab === 'dashboard' && <Dashboard />}
        {activeTab === 'polar' && <PolarView />}
        {activeTab === 'settings' && <Settings />}
      </main>
    </div>
  );
}
