'use client';

import { useReplayStore } from '@/store/replayStore';
import { RuleSignal } from '@/types';

function getFirstReasonLine(reason: string): string {
  const lines = reason.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('【'));
  return lines[0] ?? '';
}

function getActionLabel(sig: RuleSignal): string {
  if (sig.type === 'SELL' || sig.type === 'REDUCE') return '→ 考慮出場';
  if (sig.type === 'ADD') return '→ 可加碼';
  const entryKeywords = ['買進', '買點', '進場', '突破', '回後買', '缺口', '攻擊', '買上漲'];
  const isEntry = entryKeywords.some(k => sig.label.includes(k) || sig.description.includes(k));
  return isEntry ? '→ 可進場' : '→ 持股';
}

type ActionAdvice = { text: string; basis: string; color: string };

function getActionAdvice(signals: RuleSignal[], ma5: number | null | undefined): ActionAdvice {
  const buySignals  = signals.filter(s => s.type === 'BUY');
  const addSignals  = signals.filter(s => s.type === 'ADD');
  const sellSignals = signals.filter(s => s.type === 'SELL' || s.type === 'REDUCE');
  const actionCount = buySignals.length + addSignals.length + sellSignals.length;

  if (actionCount === 0) {
    return { text: '暫無明確訊號，持股觀察', basis: '', color: 'text-muted-foreground' };
  }
  if (sellSignals.length > 0 && (buySignals.length + addSignals.length) > 0) {
    const sellLabel = sellSignals[0].label;
    const buyLabel  = (buySignals[0] ?? addSignals[0]).label;
    return { text: '訊號矛盾，建議觀望', basis: `${sellLabel} 與 ${buyLabel} 同時觸發`, color: 'text-yellow-400' };
  }
  if (sellSignals.length > 0) {
    return { text: '出場警示觸發，評估減碼或出場', basis: sellSignals.map(s => s.label).join('、'), color: 'text-green-400' };
  }
  const entryKeywords = ['買進', '買點', '進場', '突破', '回後買', '缺口', '攻擊', '買上漲'];
  const entrySignals  = buySignals.filter(s =>
    entryKeywords.some(k => s.label.includes(k) || s.description.includes(k))
  );
  if (entrySignals.length > 0) {
    const ma5Str = ma5 ? `，停損守MA5(${ma5.toFixed(0)})` : '';
    return { text: `進場訊號成立${ma5Str}`, basis: entrySignals.map(s => s.label).join('、'), color: 'text-red-400' };
  }
  if (buySignals.length > 0 || addSignals.length > 0) {
    const ma5Str = ma5 ? `，守MA5(${ma5.toFixed(0)})` : '';
    return { text: `多頭持續，可繼續持有${ma5Str}`, basis: '', color: 'text-red-300' };
  }
  return { text: '暫無明確訊號，持股觀察', basis: '', color: 'text-muted-foreground' };
}

type Direction = { label: string; icon: string; color: string; detail: string };

function getDirection(signals: RuleSignal[]): Direction {
  const buyCount  = signals.filter(s => s.type === 'BUY'  || s.type === 'ADD').length;
  const sellCount = signals.filter(s => s.type === 'SELL' || s.type === 'REDUCE').length;

  if (buyCount === 0 && sellCount === 0) {
    return { label: '無明確方向', icon: '◇', color: 'text-muted-foreground', detail: '暫無觸發訊號' };
  }
  if (buyCount > 0 && sellCount === 0) {
    return { label: '偏多', icon: '▲', color: 'text-red-400', detail: `${buyCount} 個看多訊號` };
  }
  if (sellCount > 0 && buyCount === 0) {
    return { label: '偏空', icon: '▼', color: 'text-green-400', detail: `${sellCount} 個看空訊號` };
  }
  if (buyCount >= sellCount * 2) {
    return { label: '偏多', icon: '▲', color: 'text-red-400', detail: `${buyCount} 個看多 / ${sellCount} 個看空` };
  }
  if (sellCount >= buyCount * 2) {
    return { label: '偏空', icon: '▼', color: 'text-green-400', detail: `${buyCount} 個看多 / ${sellCount} 個看空` };
  }
  return { label: '多空分歧', icon: '◆', color: 'text-yellow-400', detail: `${buyCount} 個看多 / ${sellCount} 個看空` };
}

function SignalRow({ sig }: { sig: RuleSignal }) {
  const isBuy   = sig.type === 'BUY' || sig.type === 'ADD';
  const action  = getActionLabel(sig);
  const firstLine = getFirstReasonLine(sig.reason);

  return (
    <div className={`rounded px-2.5 py-2 ${isBuy ? 'bg-red-900/20' : 'bg-green-900/20'}`}>
      <div className="flex items-start gap-2">
        <span className={`text-xs font-bold px-1.5 py-0.5 rounded shrink-0 mt-0.5 ${
          isBuy ? 'bg-red-700 text-white' : 'bg-green-800 text-white'
        }`}>{sig.label}</span>
        <div className="flex-1 min-w-0">
          <p className={`text-xs font-semibold mb-0.5 ${isBuy ? 'text-red-300' : 'text-green-300'}`}>{action}</p>
          <p className="text-xs text-foreground/80 leading-tight">{sig.description}</p>
          {firstLine && (
            <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">{firstLine}</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function RuleAlerts() {
  const { currentSignals, allCandles, currentIndex } = useReplayStore();
  const candle      = allCandles[currentIndex];
  const currentDate = candle?.date;
  const ma5         = candle?.ma5;

  const buySignals  = currentSignals.filter(s => s.type === 'BUY'  || s.type === 'ADD').slice(0, 3);
  const exitSignals = currentSignals.filter(s => s.type === 'SELL' || s.type === 'REDUCE').slice(0, 3);
  const direction   = getDirection(currentSignals);
  const advice      = getActionAdvice(currentSignals, ma5);
  const hasActionSignals = buySignals.length > 0 || exitSignals.length > 0;

  return (
    <div className="bg-secondary rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-foreground/80">今日操作建議</h2>
        {currentDate && (
          <span className="text-xs text-muted-foreground">{currentDate}</span>
        )}
      </div>

      {/* 📋 操作建議 — 結論優先 */}
      <div className="bg-card border border-border/50 rounded px-3 py-2.5 mb-3">
        <p className="text-xs text-muted-foreground mb-0.5">📋 操作建議</p>
        <p className={`text-sm font-bold leading-snug ${advice.color}`}>{advice.text}</p>
        {advice.basis && (
          <p className="text-xs text-muted-foreground mt-0.5">根據：{advice.basis}</p>
        )}
      </div>

      {/* 整體偏向（降為輔助資訊） */}
      <div className="flex items-center gap-1.5 px-0.5 mb-3 flex-wrap">
        <span className="text-xs text-muted-foreground">整體偏向</span>
        <span className={`text-xs font-bold ${direction.color}`}>{direction.icon} {direction.label}</span>
        <span className="text-xs text-muted-foreground">— {direction.detail}</span>
      </div>

      {!hasActionSignals ? (
        <p className="text-xs text-muted-foreground text-center py-2">本根K線無觸發規則</p>
      ) : (
        <div className="space-y-3">
          {buySignals.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-red-400/80 mb-1.5">📈 做多理由</p>
              <div className="space-y-1.5">
                {buySignals.map((sig, i) => (
                  <SignalRow key={`${sig.ruleId}-${i}`} sig={sig} />
                ))}
              </div>
            </div>
          )}

          {exitSignals.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-green-400/80 mb-1.5">⚠️ 注意事項</p>
              <div className="space-y-1.5">
                {exitSignals.map((sig, i) => (
                  <SignalRow key={`${sig.ruleId}-${i}`} sig={sig} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground/50 mt-3 text-center">
        僅供練習參考，實際交易需自行判斷
      </p>
    </div>
  );
}
