'use client';

import Link from 'next/link';
import { PageShell } from '@/components/shared/PageShell';
import { BookOpen, TrendingUp, BarChart2, Activity, CandlestickChart, Layers } from 'lucide-react';

const CHAPTERS = [
  {
    slug: '00-overview',
    title: '總覽與學習路線圖',
    subtitle: '技術分析全景圖、指標分類、推薦學習順序',
    icon: BookOpen,
    category: '導覽',
  },
  {
    slug: '01-dow-theory',
    title: '道氏理論',
    subtitle: '六大信條、趨勢判定的根本邏輯',
    icon: TrendingUp,
    category: '經典理論',
  },
  {
    slug: '02-elliott-wave',
    title: '波浪理論',
    subtitle: '5+3 結構、費波那契比率、數浪規則',
    icon: Activity,
    category: '經典理論',
  },
  {
    slug: '03-volume-price-analysis',
    title: '量價關係',
    subtitle: 'Wyckoff 週期、法人動向偵測、真假突破',
    icon: BarChart2,
    category: '經典理論',
  },
  {
    slug: '04-moving-averages',
    title: '移動平均線 (MA)',
    subtitle: 'SMA/EMA、黃金/死亡交叉、葛蘭碧八法',
    icon: TrendingUp,
    category: '技術指標',
  },
  {
    slug: '05-macd',
    title: 'MACD 指標',
    subtitle: 'DIF/DEA/柱狀圖、零軸、背離訊號',
    icon: BarChart2,
    category: '技術指標',
  },
  {
    slug: '06-bollinger-bands',
    title: '布林通道',
    subtitle: '擠壓形態、Band Walk、%B 指標',
    icon: Layers,
    category: '技術指標',
  },
  {
    slug: '07-rsi',
    title: 'RSI 相對強弱指標',
    subtitle: '超買超賣、背離、Failure Swing',
    icon: Activity,
    category: '技術指標',
  },
  {
    slug: '08-stochastic-kd',
    title: 'KD 隨機震盪指標',
    subtitle: '交叉訊號、鈍化現象、與 RSI 比較',
    icon: Activity,
    category: '技術指標',
  },
  {
    slug: '09-candlestick-patterns',
    title: 'K 線戰法',
    subtitle: '錘子/吞噬/晨星暮星/三白兵等型態',
    icon: CandlestickChart,
    category: '技術指標',
  },
  {
    slug: '10-combining-indicators',
    title: '多指標組合策略',
    subtitle: '指標共振、趨勢先行、實戰交易系統',
    icon: Layers,
    category: '實戰應用',
  },
] as const;

const CATEGORIES = ['導覽', '經典理論', '技術指標', '實戰應用'] as const;

const CATEGORY_COLORS: Record<string, string> = {
  '導覽': 'border-blue-500/30 bg-blue-500/5',
  '經典理論': 'border-amber-500/30 bg-amber-500/5',
  '技術指標': 'border-emerald-500/30 bg-emerald-500/5',
  '實戰應用': 'border-purple-500/30 bg-purple-500/5',
};

const CATEGORY_BADGE: Record<string, string> = {
  '導覽': 'bg-blue-500/20 text-blue-400',
  '經典理論': 'bg-amber-500/20 text-amber-400',
  '技術指標': 'bg-emerald-500/20 text-emerald-400',
  '實戰應用': 'bg-purple-500/20 text-purple-400',
};

export default function LearnPage() {
  return (
    <PageShell>
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-2xl font-bold mb-2">技術分析學習手冊</h1>
          <p className="text-muted-foreground">
            從基礎理論到實戰應用，系統性學習股票技術分析
          </p>
        </div>

        {CATEGORIES.map(cat => {
          const chapters = CHAPTERS.filter(ch => ch.category === cat);
          return (
            <div key={cat} className="mb-8">
              <h2 className="text-lg font-semibold mb-3 text-foreground/80">{cat}</h2>
              <div className="grid gap-3">
                {chapters.map((ch) => {
                  const Icon = ch.icon;
                  return (
                    <Link
                      key={ch.slug}
                      href={`/learn/${ch.slug}`}
                      className={`block border rounded-lg p-4 transition-colors hover:bg-secondary/50 ${CATEGORY_COLORS[ch.category]}`}
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 text-muted-foreground">
                          <Icon size={20} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <h3 className="font-medium text-foreground">{ch.title}</h3>
                            <span className={`text-xs px-2 py-0.5 rounded-full ${CATEGORY_BADGE[ch.category]}`}>
                              {ch.category}
                            </span>
                          </div>
                          <p className="text-sm text-muted-foreground">{ch.subtitle}</p>
                        </div>
                        <span className="text-muted-foreground/60 text-sm shrink-0">&rarr;</span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </PageShell>
  );
}
