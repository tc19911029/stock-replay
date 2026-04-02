'use client';
import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="min-h-screen bg-background text-foreground/90 flex flex-col items-center justify-center gap-6">
      <div className="text-8xl font-bold text-muted">404</div>
      <div className="text-xl text-muted-foreground">找不到這個頁面</div>
      <Link href="/" className="px-6 py-2.5 bg-sky-600 hover:bg-sky-500 rounded-lg text-foreground font-medium transition-colors">
        回到主頁
      </Link>
    </div>
  );
}
