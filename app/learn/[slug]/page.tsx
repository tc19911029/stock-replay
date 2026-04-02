import fs from 'fs';
import path from 'path';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { LearnContent } from './LearnContent';

const DOCS_DIR = path.join(process.cwd(), 'docs', 'technical-analysis');

// All valid slugs
const CHAPTERS = [
  '00-overview',
  '01-dow-theory',
  '02-elliott-wave',
  '03-volume-price-analysis',
  '04-moving-averages',
  '05-macd',
  '06-bollinger-bands',
  '07-rsi',
  '08-stochastic-kd',
  '09-candlestick-patterns',
  '10-combining-indicators',
];

export function generateStaticParams() {
  return CHAPTERS.map(slug => ({ slug }));
}

interface Props {
  params: Promise<{ slug: string }>;
}

export default async function LearnArticlePage({ params }: Props) {
  const { slug } = await params;

  if (!CHAPTERS.includes(slug)) {
    notFound();
  }

  const filePath = path.join(DOCS_DIR, `${slug}.md`);
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    notFound();
  }

  // Determine prev/next chapters for navigation
  const currentIdx = CHAPTERS.indexOf(slug);
  const prevSlug = currentIdx > 0 ? CHAPTERS[currentIdx - 1] : null;
  const nextSlug = currentIdx < CHAPTERS.length - 1 ? CHAPTERS[currentIdx + 1] : null;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Top bar */}
      <div className="sticky top-0 z-50 border-b border-border bg-background px-4">
        <div className="max-w-4xl mx-auto h-12 flex items-center gap-3">
          <Link
            href="/learn"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            &larr; 目錄
          </Link>
          <span className="text-muted-foreground/60">|</span>
          <span className="text-sm text-foreground/80 truncate">
            技術分析學習手冊
          </span>
        </div>
      </div>

      {/* Article content */}
      <main className="max-w-4xl mx-auto px-4 py-8">
        <LearnContent content={content} />

        {/* Prev / Next navigation */}
        <nav className="mt-12 pt-6 border-t border-border flex justify-between">
          {prevSlug ? (
            <Link
              href={`/learn/${prevSlug}`}
              className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
            >
              &larr; 上一章
            </Link>
          ) : (
            <span />
          )}
          {nextSlug ? (
            <Link
              href={`/learn/${nextSlug}`}
              className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
            >
              下一章 &rarr;
            </Link>
          ) : (
            <Link
              href="/learn"
              className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
            >
              回到目錄
            </Link>
          )}
        </nav>
      </main>
    </div>
  );
}
