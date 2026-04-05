/** Read --bull / --bear CSS variables at runtime so color-theme toggle works */
export function getBullBearColors(): { bull: string; bear: string } {
  if (typeof document === 'undefined') return { bull: '#ef4444', bear: '#16a34a' };
  const style = getComputedStyle(document.documentElement);
  const bull = style.getPropertyValue('--bull').trim();
  const bear = style.getPropertyValue('--bear').trim();
  return { bull: oklchToHex(bull) || '#ef4444', bear: oklchToHex(bear) || '#16a34a' };
}

/** Convert an oklch() CSS color string to hex via offscreen canvas */
function oklchToHex(color: string): string | null {
  if (!color) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
  } catch {
    return null;
  }
}
