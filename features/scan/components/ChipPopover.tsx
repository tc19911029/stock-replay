'use client';

import { useState, type ReactNode } from 'react';
import type { ChipData } from '@/app/api/chip/route';

function Val({ v, unit = '張' }: { v: number; unit?: string }) {
  const color = v > 0 ? 'text-bull' : v < 0 ? 'text-bear' : 'text-muted-foreground';
  return <span className={`font-mono ${color}`}>{v > 0 ? '+' : ''}{v.toLocaleString()} {unit}</span>;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between items-center py-0.5">
      <span className="text-muted-foreground w-16 shrink-0">{label}</span>
      <span className="text-right">{children}</span>
    </div>
  );
}

export function ChipPopover({ data, children }: { data: ChipData | undefined; children: ReactNode }) {
  const [show, setShow] = useState(false);

  if (!data) return <>{children}</>;

  const gradeDesc = data.chipGrade === 'S' ? '主力強力買超'
    : data.chipGrade === 'A' ? '法人偏多'
    : data.chipGrade === 'B' ? '中性'
    : data.chipGrade === 'C' ? '法人偏空'
    : '主力出貨';

  return (
    <div className="relative inline-block"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}>
      {children}
      {show && (
        <div className="absolute z-50 left-1/2 -translate-x-1/2 top-full mt-1.5 w-72 bg-secondary border border-border rounded-lg shadow-xl p-3 text-[11px] text-foreground/80 pointer-events-none"
          onClick={e => e.stopPropagation()}>
          {/* Header */}
          <div className="flex items-center gap-2 mb-2 pb-1.5 border-b border-border">
            <span className="font-bold text-foreground text-xs">籌碼總覽</span>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
              data.chipScore >= 70 ? 'bg-green-900/60 text-green-300'
              : data.chipScore >= 50 ? 'bg-yellow-900/60 text-yellow-300'
              : 'bg-red-900/60 text-red-300'
            }`}>{data.chipGrade} {data.chipScore}分</span>
            <span className="text-muted-foreground">{gradeDesc}</span>
          </div>

          {/* 三大法人 */}
          <div className="mb-2">
            <div className="text-muted-foreground font-medium mb-0.5">三大法人</div>
            <Row label="外資"><Val v={data.foreignBuy} /></Row>
            <Row label="投信"><Val v={data.trustBuy} /></Row>
            <Row label="自營"><Val v={data.dealerBuy} /></Row>
            <Row label="合計">
              <span className="font-bold"><Val v={data.totalInstitutional} /></span>
            </Row>
          </div>

          {/* 融資融券 */}
          <div className="mb-2 pt-1.5 border-t border-border/60">
            <div className="text-muted-foreground font-medium mb-0.5">融資融券</div>
            <Row label="融資餘額">
              <span className="font-mono text-foreground/80">{data.marginBalance.toLocaleString()}</span>
              <span className="text-muted-foreground/60 mx-1">|</span>
              <span className="text-muted-foreground">增減</span> <Val v={data.marginNet} />
            </Row>
            <Row label="融券餘額">
              <span className="font-mono text-foreground/80">{data.shortBalance.toLocaleString()}</span>
              <span className="text-muted-foreground/60 mx-1">|</span>
              <span className="text-muted-foreground">增減</span> <Val v={data.shortNet} />
            </Row>
            <Row label="使用率">
              <span className="font-mono text-foreground/80">{data.marginUtilRate}%</span>
            </Row>
          </div>

          {/* 大額交易人 */}
          <div className="mb-2 pt-1.5 border-t border-border/60">
            <div className="text-muted-foreground font-medium mb-0.5">大額交易人</div>
            <div className="flex justify-between py-0.5">
              <span><span className="text-muted-foreground">買</span> <span className="font-mono text-bull">{data.largeTraderBuy.toLocaleString()}</span></span>
              <span><span className="text-muted-foreground">賣</span> <span className="font-mono text-bear">{data.largeTraderSell.toLocaleString()}</span></span>
              <span><span className="text-muted-foreground">淨</span> <Val v={data.largeTraderNet} /></span>
            </div>
          </div>

          {/* 當沖 */}
          <div className="pt-1.5 border-t border-border/60">
            <div className="text-muted-foreground font-medium mb-0.5">當沖</div>
            <div className="flex justify-between py-0.5">
              <span><span className="text-muted-foreground">成交量</span> <span className="font-mono text-foreground/80">{data.dayTradeVolume.toLocaleString()}</span></span>
              <span><span className="text-muted-foreground">當沖比</span> <span className={`font-mono ${data.dayTradeRatio > 40 ? 'text-amber-400' : 'text-foreground/80'}`}>{data.dayTradeRatio}%</span></span>
            </div>
          </div>

          {/* 信號 */}
          {data.chipSignal && (
            <div className="mt-2 pt-1.5 border-t border-border/60 text-[10px] text-muted-foreground">
              {data.chipDetail}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
