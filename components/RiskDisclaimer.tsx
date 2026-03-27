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

  useEffect(() => {
    try {
      if (!localStorage.getItem(DISCLAIMER_KEY)) setShow(true);
    } catch {}
  }, []);

  const accept = () => {
    try { localStorage.setItem(DISCLAIMER_KEY, '1'); } catch {}
    setShow(false);
  };

  if (!show) return null;

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 max-w-lg mx-4 shadow-2xl">
        <h2 className="text-lg font-bold text-amber-400 flex items-center gap-2 mb-4">
          <span>⚠️</span> 風險提示與免責聲明
        </h2>
        <div className="text-sm text-slate-300 space-y-3 max-h-[50vh] overflow-y-auto">
          <p>
            本軟體僅供<strong className="text-white">投資研究與學習</strong>使用，
            <strong className="text-red-400">不構成任何投資建議</strong>。
          </p>
          <p>
            所有掃描結果、訊號提示、回測數據均基於歷史技術分析，
            <strong className="text-red-400">過去績效不代表未來表現</strong>。
          </p>
          <ul className="list-disc list-inside text-xs text-slate-400 space-y-1">
            <li>股票投資具有風險，可能導致本金損失</li>
            <li>當沖交易風險更高，不適合所有投資人</li>
            <li>回測結果可能存在倖存者偏差、滑價差異等誤差</li>
            <li>系統提示僅供參考，最終決策由使用者自行負責</li>
            <li>本軟體開發者不對任何投資損失承擔責任</li>
          </ul>
          <p className="text-xs text-slate-500">
            使用本軟體即表示您已理解上述風險，並同意自行承擔所有投資決策的後果。
          </p>
        </div>
        <button onClick={accept}
          className="mt-4 w-full bg-amber-600 hover:bg-amber-500 text-white font-bold py-2.5 rounded-lg transition">
          我已閱讀並理解風險
        </button>
      </div>
    </div>
  );
}

/** 精簡版底部風險提示 */
export function RiskFooter() {
  return (
    <div className="text-[10px] text-slate-600 text-center py-1 border-t border-slate-800/50">
      ⚠ 本軟體僅供研究學習，不構成投資建議。過去績效不代表未來表現，投資有風險。
    </div>
  );
}
