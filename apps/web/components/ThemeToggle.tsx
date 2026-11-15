'use client';

import { useEffect, useState } from 'react';
import { Icon } from './Icons';

type Theme = 'system' | 'light' | 'dark';
const ORDER: Theme[] = ['system', 'light', 'dark'];
const LABEL: Record<Theme, string> = { system: 'Auto', light: 'Light', dark: 'Dark' };

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('system');

  useEffect(() => {
    const saved = document.documentElement.dataset.theme;
    if (saved === 'light' || saved === 'dark') setTheme(saved);
  }, []);

  function cycle() {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]!;
    setTheme(next);
    if (next === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
    try {
      if (next === 'system') localStorage.removeItem('hs-theme');
      else localStorage.setItem('hs-theme', next);
    } catch {
      /* storage can be unavailable; the choice then lasts for this page view */
    }
  }

  return (
    <button type="button" className="btn btn-quiet theme-toggle" onClick={cycle} aria-label={`Theme: ${LABEL[theme]}. Change theme`}>
      <Icon name={theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'contrast'} />
      <span>{LABEL[theme]}</span>
    </button>
  );
}
