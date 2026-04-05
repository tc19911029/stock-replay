'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import NavigationProgress from '@/components/NavigationProgress';
import {
  Moon, Sun,
  Star, Briefcase, Settings, Menu, ChevronDown, Scale,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';
import {
  Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { useState, useRef, useEffect } from 'react';

// ── Navigation Items ──────────────────────────────────────────────────────────

// Items under the settings (gear) dropdown
const SETTINGS_SUB = [
  { href: '/watchlist',  label: '自選股', icon: Star },
  { href: '/portfolio',  label: '持倉',   icon: Briefcase },
  { href: '/settings',   label: '設定',   icon: Settings },
  { href: '/disclaimer', label: '免責聲明', icon: Scale },
] as const;

// ── Dropdown component ────────────────────────────────────────────────────────

interface DropdownItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}

function NavDropdown({
  trigger,
  items,
  isActive,
}: {
  trigger: React.ReactNode;
  items: readonly DropdownItem[];
  isActive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
          isActive
            ? 'bg-sky-500/15 text-sky-400'
            : 'text-muted-foreground hover:text-foreground hover:bg-secondary',
        )}
      >
        {trigger}
        <ChevronDown className={cn('w-3 h-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full mt-1 w-40 bg-popover border border-border rounded-lg shadow-lg z-[60] py-1 overflow-hidden"
        >
          {items.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            >
              <Icon className="w-3.5 h-3.5 shrink-0" />
              {label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface PageShellProps {
  children: React.ReactNode;
  /** Slot for page-specific header content (e.g. StockSelector on chart page) */
  headerSlot?: React.ReactNode;
  /** Use full-viewport mode (no scroll on main). For chart/daytrade pages. */
  fullViewport?: boolean;
  className?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PageShell({ children, headerSlot, fullViewport, className }: PageShellProps) {
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href.split('?')[0]);

  const isSettingsActive = pathname.startsWith('/watchlist') || pathname.startsWith('/portfolio')
    || pathname.startsWith('/settings') || pathname.startsWith('/disclaimer');

  return (
    <div className={cn(
      'flex flex-col bg-background text-foreground',
      fullViewport ? 'h-screen overflow-hidden' : 'min-h-screen',
    )}>
      <NavigationProgress />
      {/* Skip to content */}
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:z-[100] focus:top-2 focus:left-2 focus:px-4 focus:py-2 focus:bg-sky-600 focus:text-white focus:rounded-lg focus:text-sm">
        跳到主要內容
      </a>

      {/* ── Top Navigation ── */}
      <header role="banner" className="shrink-0 border-b border-border bg-background px-3 sticky top-0 z-50">
        <div className="h-12 flex items-center gap-2">

          {/* Header slot (e.g. StockSelector) */}
          {headerSlot && (
            <div className="shrink-0">{headerSlot}</div>
          )}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Secondary Nav — desktop icon-only + settings dropdown */}
          <nav aria-label="輔助導覽" className="hidden md:flex items-center gap-0.5">
            {/* Watchlist & Portfolio direct links */}
            {([
              { href: '/watchlist', label: '自選股', icon: Star },
              { href: '/portfolio', label: '持倉',   icon: Briefcase },
            ] as const).map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                title={label}
                className={cn(
                  'p-2 rounded-md transition-colors',
                  isActive(href)
                    ? 'text-sky-400 bg-sky-500/10'
                    : 'text-muted-foreground hover:text-foreground/80 hover:bg-secondary',
                )}
              >
                <Icon className="w-4 h-4" />
              </Link>
            ))}

            {/* Settings dropdown */}
            <NavDropdown
              isActive={isSettingsActive}
              trigger={<Settings className="w-4 h-4" />}
              items={SETTINGS_SUB}
            />

            {/* Divider */}
            <span className="w-px h-5 bg-border mx-1" />

            {/* Theme Toggle */}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="切換主題"
              className="text-muted-foreground hover:text-foreground/80 w-8 h-8"
            >
              <Sun className="w-4 h-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
              <Moon className="absolute w-4 h-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
            </Button>
          </nav>

          {/* Mobile Menu */}
          <div className="md:hidden">
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger
                render={<Button variant="ghost" size="icon" aria-label="開啟選單" className="text-muted-foreground w-8 h-8" />}
              >
                <Menu className="w-5 h-5" />
              </SheetTrigger>
              <SheetContent side="right" className="w-64 bg-background border-border">
                <SheetHeader>
                  <SheetTitle className="text-sky-400">
                    選單
                  </SheetTitle>
                </SheetHeader>
                <nav aria-label="行動版導覽" className="flex flex-col gap-1 mt-4 px-2">
                  {/* Mobile: flat list of sub-pages */}
                  {[
                    { href: '/watchlist',            label: '自選股',    icon: Star },
                    { href: '/portfolio',            label: '持倉',      icon: Briefcase },
                    { href: '/settings',             label: '設定',      icon: Settings },
                    { href: '/disclaimer',           label: '免責聲明',  icon: Scale },
                  ].map(({ href, label, icon: Icon }) => (
                    <Link
                      key={href}
                      href={href}
                      onClick={() => setMobileOpen(false)}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                        isActive(href)
                          ? 'bg-sky-500/15 text-sky-400'
                          : 'text-muted-foreground hover:text-foreground hover:bg-secondary',
                      )}
                    >
                      <Icon className="w-4 h-4" />
                      {label}
                    </Link>
                  ))}
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>

      {/* ── Page Content ── */}
      <main id="main-content" role="main" className={cn('flex-1', fullViewport && 'overflow-hidden', className)}>
        {children}
      </main>
    </div>
  );
}
