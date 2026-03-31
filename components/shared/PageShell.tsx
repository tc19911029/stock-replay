'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Moon, Sun, TrendingUp,
  BarChart2, ScanSearch, Activity, FileBarChart, Settings2,
  Star, Briefcase, Settings, Menu, BookOpen, FlaskConical,
} from 'lucide-react';
import { useTheme } from 'next-themes';
import { Button } from '@/components/ui/button';
import {
  Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { useState } from 'react';

// ── Navigation Items ──────────────────────────────────────────────────────────

const PRIMARY_NAV = [
  { href: '/',           label: '走圖',   icon: BarChart2 },
  { href: '/scan',       label: '掃描',   icon: ScanSearch },
  { href: '/live-daytrade', label: '當沖', icon: Activity },
  { href: '/report',     label: '報表',   icon: FileBarChart },
  { href: '/strategies', label: '策略',   icon: Settings2 },
  { href: '/learn',      label: '教學',   icon: BookOpen },
] as const;

/** Page-specific brand title shown in the logo area */
function getBrandTitle(pathname: string): string {
  if (pathname.startsWith('/scan')) return '選股神器';
  if (pathname.startsWith('/live-daytrade')) return '當沖神器';
  if (pathname.startsWith('/rule-group-analysis')) return '規則回測';
  return '走圖神器';
}

const SECONDARY_NAV = [
  { href: '/watchlist',  label: '自選股', icon: Star },
  { href: '/portfolio',  label: '持倉',   icon: Briefcase },
  { href: '/rule-group-analysis', label: '規則回測', icon: FlaskConical },
  { href: '/settings',   label: '設定',   icon: Settings },
] as const;

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
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <div className={cn(
      'flex flex-col bg-[#0b1120] text-white',
      fullViewport ? 'h-screen overflow-hidden' : 'min-h-screen',
    )}>
      {/* ── Top Navigation ── */}
      <header className="shrink-0 border-b border-slate-800 bg-slate-950 px-3 sticky top-0 z-50">
        <div className="h-12 flex items-center gap-2">

          {/* Logo */}
          <Link href="/" className="flex items-center gap-1.5 shrink-0">
            <TrendingUp className="w-5 h-5 text-sky-400" />
            <span className="font-bold text-sm text-sky-400 tracking-tight hidden sm:block">
              {getBrandTitle(pathname)}
            </span>
          </Link>

          {/* Header slot (e.g. StockSelector) */}
          {headerSlot && (
            <div className="shrink-0">{headerSlot}</div>
          )}

          {/* Primary Nav — desktop */}
          <nav className="hidden md:flex items-center gap-0.5 ml-1">
            {PRIMARY_NAV.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                className={cn(
                  'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                  isActive(href)
                    ? 'bg-sky-500/15 text-sky-400'
                    : 'text-slate-400 hover:text-white hover:bg-slate-800',
                )}
              >
                <Icon className="w-4 h-4" />
                {label}
              </Link>
            ))}
          </nav>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Secondary Nav — desktop icon-only */}
          <div className="hidden md:flex items-center gap-0.5">
            {SECONDARY_NAV.map(({ href, label, icon: Icon }) => (
              <Link
                key={href}
                href={href}
                title={label}
                className={cn(
                  'p-2 rounded-md transition-colors',
                  isActive(href)
                    ? 'text-sky-400 bg-sky-500/10'
                    : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800',
                )}
              >
                <Icon className="w-4 h-4" />
              </Link>
            ))}

            {/* Divider */}
            <span className="w-px h-5 bg-slate-800 mx-1" />

            {/* Theme Toggle */}
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              aria-label="切換主題"
              className="text-slate-500 hover:text-slate-300 w-8 h-8"
            >
              <Sun className="w-4 h-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
              <Moon className="absolute w-4 h-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
            </Button>
          </div>

          {/* Mobile Menu */}
          <div className="md:hidden">
            <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
              <SheetTrigger
                render={<Button variant="ghost" size="icon" className="text-slate-400 w-8 h-8" />}
              >
                <Menu className="w-5 h-5" />
              </SheetTrigger>
              <SheetContent side="right" className="w-64 bg-slate-950 border-slate-800">
                <SheetHeader>
                  <SheetTitle className="flex items-center gap-2 text-sky-400">
                    <TrendingUp className="w-5 h-5" />
                    選股神器
                  </SheetTitle>
                </SheetHeader>
                <nav className="flex flex-col gap-1 mt-4 px-2">
                  {PRIMARY_NAV.map(({ href, label, icon: Icon }) => (
                    <Link
                      key={href}
                      href={href}
                      onClick={() => setMobileOpen(false)}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                        isActive(href)
                          ? 'bg-sky-500/15 text-sky-400'
                          : 'text-slate-400 hover:text-white hover:bg-slate-800',
                      )}
                    >
                      <Icon className="w-4 h-4" />
                      {label}
                    </Link>
                  ))}

                  <div className="h-px bg-slate-800 my-2" />

                  {SECONDARY_NAV.map(({ href, label, icon: Icon }) => (
                    <Link
                      key={href}
                      href={href}
                      onClick={() => setMobileOpen(false)}
                      className={cn(
                        'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                        isActive(href)
                          ? 'bg-sky-500/15 text-sky-400'
                          : 'text-slate-400 hover:text-white hover:bg-slate-800',
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
      <main className={cn('flex-1', fullViewport && 'overflow-hidden', className)}>
        {children}
      </main>
    </div>
  );
}
