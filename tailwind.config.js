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
          bg: 'var(--n2k-bg)',
          surface: 'var(--n2k-surface)',
          accent: 'var(--n2k-accent)',
          success: 'var(--n2k-success)',
          warning: 'var(--n2k-warning)',
          danger: 'var(--n2k-danger)',
        },
      },
    },
  },
  plugins: [],
};
