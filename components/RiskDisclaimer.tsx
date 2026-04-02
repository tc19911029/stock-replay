'use client';
import { useState, useEffect } from 'react';

/**
 * 風險提示 / 免責聲明元件
 * - 首次使用時彈窗提醒
 * - 每頁底部顯示精簡版
 */

const DISCLAIMER_KEY = 'risk-disclaimer-accepted';

export function RiskDisclaimerModal() {
  const [show, setShow] = useState(false);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    try {
      if (!localStorage.getItem(DISCLAIMER_KEY)) setShow(true);
    } catch {}
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  const accept = () => {
    try { localStorage.setItem(DISCLAIMER_KEY, '1'); } catch {}
    setShow(false);
  };

  if (!show) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-xl p-6 max-w-lg mx-4 shadow-2xl">
        <h2 className="text-lg font-bold text-amber-400 flex items-center gap-2 mb-4">
          <span>⚠️</span> 風險提示與免責聲明
        </h2>
        <div className="text-sm text-foreground/80 space-y-3 max-h-[50vh] overflow-y-auto">
          <p>
            本軟體僅供<strong className="text-foreground">投資研究與學習</strong>使用，
            <strong className="text-red-400">不構成任何投資建議</strong>。
          </p>
          <p>
            所有掃描結果、訊號提示、回測數據均基於歷史技術分析，
            <strong className="text-red-400">過去績效不代表未來表現</strong>。
          </p>
          <ul className="list-disc list-inside text-xs text-muted-foreground space-y-1">
            <li>股票投資具有風險，可能導致本金損失</li>
            <li>當沖交易風險更高，不適合所有投資人</li>
            <li>回測結果可能存在倖存者偏差、滑價差異等誤差</li>
            <li>系統提示僅供參考，最終決策由使用者自行負責</li>
            <li>本軟體開發者不對任何投資損失承擔責任</li>
          </ul>
          <p className="text-xs text-muted-foreground">
            使用本軟體即表示您已理解上述風險，並同意自行承擔所有投資決策的後果。
          </p>
        </div>
        <button onClick={accept}
          className="mt-4 w-full bg-amber-600 hover:bg-amber-500 text-foreground font-bold py-2.5 rounded-lg transition">
          我已閱讀並理解風險
        </button>
      </div>
    </div>
  );
}

/** 首次使用功能導覽（風險聲明接受後顯示） */
const GUIDE_KEY = 'feature-guide-seen';

export function FeatureGuideModal() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      // 只在已接受風險聲明且尚未看過導覽時顯示
      if (localStorage.getItem(DISCLAIMER_KEY) && !localStorage.getItem(GUIDE_KEY)) {
        const timer = setTimeout(() => setShow(true), 800);
        return () => clearTimeout(timer);
      }
    } catch {}
  }, []);

  const dismiss = () => {
    try { localStorage.setItem(GUIDE_KEY, '1'); } catch {}
    setShow(false);
  };

  if (!show) return null;

  const features = [
    { icon: '📈', title: 'K線走圖練習', desc: '逐根播放歷史走勢，模擬操盤節奏，練習進出場判斷', path: '/' },
    { icon: '🔍', title: '掃描選股', desc: '一鍵掃描台股/陸股，找出符合六大條件的個股', path: '/scanner' },
    { icon: '🔬', title: '策略回測', desc: '驗證策略在歷史數據上的表現，含完整成本模型', path: '/scanner?mode=full' },
    { icon: '⭐', title: '自選監控', desc: '追蹤感興趣的個股，即時查看六大條件評分', path: '/watchlist' },
    { icon: '💼', title: '持股管理', desc: '記錄持股，即時追蹤損益與停損提醒', path: '/portfolio' },
    { icon: '⚡', title: '當沖提示', desc: '多時間框架即時訊號，適合短線交易者（Beta）', path: '/live-daytrade' },
  ];

  return (
    <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-card border border-border rounded-xl p-6 max-w-2xl mx-4 shadow-2xl">
        <h2 className="text-lg font-bold text-sky-400 flex items-center gap-2 mb-1">
          歡迎使用 K線走圖練習器
        </h2>
        <p className="text-xs text-muted-foreground mb-4">以下是主要功能，點擊任一卡片可直接前往</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {features.map(f => (
            <a key={f.title} href={f.path} onClick={dismiss}
              className="flex flex-col gap-1.5 p-3 rounded-lg bg-secondary/60 border border-border/50 hover:border-sky-600/50 hover:bg-secondary transition-colors cursor-pointer">
              <div className="text-xl">{f.icon}</div>
              <div className="text-sm font-semibold text-foreground">{f.title}</div>
              <div className="text-[11px] text-muted-foreground leading-relaxed">{f.desc}</div>
            </a>
          ))}
        </div>
        <button onClick={dismiss}
          className="mt-4 w-full bg-secondary hover:bg-muted text-foreground/80 font-medium py-2 rounded-lg transition text-sm">
          我知道了，開始使用
        </button>
      </div>
    </div>
  );
}

/** 精簡版底部風險提示 */
export function RiskFooter() {
  return (
    <div className="text-[10px] text-muted-foreground/60 text-center py-1 border-t border-border/50">
      ⚠ 本軟體僅供研究學習，不構成投資建議。過去績效不代表未來表現，投資有風險。
    </div>
  );
}
