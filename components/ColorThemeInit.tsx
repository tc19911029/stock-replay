'use client';

import { useEffect } from 'react';
import { useSettingsStore } from '@/store/settingsStore';

/**
 * Hydrates the `data-color-theme` attribute on <html> from persisted settings.
 * Must be rendered once in the root layout.
 */
export function ColorThemeInit() {
  const colorTheme = useSettingsStore(s => s.colorTheme);

  useEffect(() => {
    if (colorTheme === 'western') {
      document.documentElement.setAttribute('data-color-theme', 'western');
    } else {
      document.documentElement.removeAttribute('data-color-theme');
    }
  }, [colorTheme]);

  return null;
}
