/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        n2k: {
          bg: '#0a0a0a',
          surface: '#1a1a2e',
          accent: '#00d4ff',
          success: '#00ff88',
          warning: '#ffaa00',
          danger: '#ff4444',
        },
      },
    },
  },
  plugins: [],
};
