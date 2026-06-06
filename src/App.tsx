import React, { useState } from 'react';
import Dashboard from './components/Dashboard/Dashboard';
import PolarView from './components/PolarView/PolarView';
import Settings from './components/Settings/Settings';

type Tab = 'dashboard' | 'polar' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'polar', label: 'Polar' },
  { id: 'settings', label: 'Settings' },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');

  return (
    <div className="min-h-screen bg-n2k-bg text-white flex flex-col">
      {/* Header / Nav */}
      <header className="flex items-center bg-n2k-surface border-b border-gray-800 px-4 py-0 shrink-0 app-drag">
        <span className="text-sm font-bold text-n2k-accent mr-6 py-2">N2K Race Logger</span>
        <nav className="flex gap-1">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium rounded-t transition-colors app-no-drag ${
                activeTab === tab.id
                  ? 'bg-n2k-bg text-white'
                  : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
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
