import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
const KEY = 'image-resizer:theme';

function read(): ThemePreference {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Persists a per-viewer theme override; "system" follows prefers-color-scheme. */
export function useTheme() {
  const [theme, setTheme] = useState<ThemePreference>(read);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (theme === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    } catch {
      /* storage unavailable (private mode) — the in-memory choice still applies */
    }
  }, [theme]);

  const cycle = useCallback(() => setTheme((t) => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system')), []);
  return { theme, cycle };
}
