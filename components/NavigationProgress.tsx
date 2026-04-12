'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { flushSync } from 'react-dom';

/**
 * Thin top progress bar that animates during route transitions.
 * Uses usePathname to detect when a navigation completes, showing a quick
 * flash of progress to give visual feedback during page changes.
 */
export default function NavigationProgress() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);
  const [width, setWidth] = useState(0);
  const prevPathRef = useRef(pathname);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (pathname === prevPathRef.current) return;
    prevPathRef.current = pathname;

    // Start animation - flushSync ensures immediate visual update before timers
    flushSync(() => {
      setVisible(true);
      setWidth(30);
    });

    if (timerRef.current) clearTimeout(timerRef.current);

    // Quickly run to 100%
    timerRef.current = setTimeout(() => setWidth(100), 50);

    // Fade out after complete
    timerRef.current = setTimeout(() => {
      setVisible(false);
      setWidth(0);
    }, 500);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [pathname]);

  if (!visible) return null;

  return (
    <div
      className="fixed top-0 left-0 z-[9999] h-[2px] bg-sky-500 transition-all duration-300 ease-out pointer-events-none"
      style={{ width: `${width}%`, opacity: visible ? 1 : 0 }}
      role="progressbar"
      aria-hidden="true"
    />
  );
}
