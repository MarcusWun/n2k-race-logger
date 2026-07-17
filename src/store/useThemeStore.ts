import { create } from 'zustand';

type Theme = 'night' | 'day';
const KEY = 'n2k-theme';

interface ThemeStore {
  theme: Theme;
  toggleTheme: () => void;
}

function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  if (theme === 'day') {
    document.documentElement.classList.add('day');
  } else {
    document.documentElement.classList.remove('day');
  }
}

const stored =
  typeof localStorage !== 'undefined' ? (localStorage.getItem(KEY) as Theme | null) : null;
const initial: Theme = stored === 'day' ? 'day' : 'night';

// Apply immediately so there's no flash on load
applyTheme(initial);

export const useThemeStore = create<ThemeStore>((set, get) => ({
  theme: initial,
  toggleTheme: () => {
    const next: Theme = get().theme === 'night' ? 'day' : 'night';
    applyTheme(next);
    localStorage.setItem(KEY, next);
    set({ theme: next });
  },
}));
