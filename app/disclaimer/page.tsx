'use client';

import Link from 'next/link';

export default function DisclaimerPage() {
  return (
    <div className="min-h-screen bg-slate-950 text-white p-6 max-w-3xl mx-auto">
      <Link href="/" className="text-sm text-slate-400 hover:text-white mb-6 inline-block">&larr; 返回主頁</Link>

      <h1 className="text-2xl font-bold mb-6">免責聲明與使用條款</h1>

      <div className="space-y-6 text-sm text-slate-300 leading-relaxed">
        <section>
          <h2 className="text-lg font-bold text-white mb-2">投資風險警告</h2>
          <p>本軟體僅供<strong className="text-amber-400">教育與研究用途</strong>，不構成任何投資建議、買賣推薦或財務諮詢。</p>
          <p className="mt-2">股票投資具有風險，過去的表現不代表未來的結果。回測結果基於歷史數據模擬，實際交易可能因市場流動性、漲跌停限制、滑點、手續費等因素而產生顯著差異。</p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white mb-2">回測結果限制</h2>
          <ul className="list-disc list-inside space-y-1">
            <li>回測使用歷史數據，存在<strong>倖存者偏差</strong>（survivorship bias）的可能</li>
            <li>隔日開盤價進場假設可能因<strong>漲停板</strong>而無法實際執行</li>
            <li>成本模型為近似值，實際手續費可能因券商而異</li>
            <li>系統不處理股票停牌、除權除息、公司下市等特殊事件</li>
            <li>數據來源為第三方（Yahoo Finance），可能存在延遲或錯誤</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white mb-2">如何正確解讀回測數據</h2>
          <div className="bg-slate-900/80 border border-slate-700 rounded-lg p-4 space-y-2">
            <p className="text-amber-300 font-medium">請注意以下量化指標的參考門檻：</p>
            <ul className="list-disc list-inside space-y-1.5 text-slate-300">
              <li><strong>樣本數量</strong>：單次回測至少需要 <strong className="text-white">30 筆以上</strong>的交易才具有統計參考價值，少於此數的勝率和期望值偏差可能很大</li>
              <li><strong>Sharpe Ratio</strong>：&ge; 1.0 為良好，0.5-1.0 為普通，&lt; 0.5 表示風險報酬比偏低</li>
              <li><strong>Walk-Forward 穩健度</strong>：若低於 <strong className="text-white">70%</strong>，表示策略可能<strong>過度擬合</strong>歷史數據，實際交易表現可能大幅不如回測</li>
              <li><strong>覆蓋率</strong>：低於 90% 表示部分股票資料缺失，回測結果存在<strong>倖存者偏差</strong>，實際報酬可能比顯示的低 10-20%</li>
              <li><strong>實際 vs 回測差距</strong>：一般而言，實際交易績效會比回測結果差 <strong className="text-white">20-30%</strong>，主要來自滑點、流動性、心理因素等</li>
            </ul>
            <p className="text-xs text-slate-500 mt-2">建議：先以小資金紙上模擬交易至少 1-3 個月，確認策略在實盤環境中可行後，再逐步投入資金。</p>
          </div>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white mb-2">當沖提示功能</h2>
          <p>當沖提示功能目前處於 <strong className="text-amber-400">Beta 測試階段</strong>，訊號品質尚在優化中。</p>
          <p className="mt-2">任何買賣提示均不構成交易建議。使用者應自行判斷並承擔全部交易風險。</p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white mb-2">責任限制</h2>
          <p>本軟體的開發者與營運者不對任何因使用本軟體而產生的直接或間接損失負責，包括但不限於：</p>
          <ul className="list-disc list-inside space-y-1 mt-2">
            <li>因依據本軟體訊號進行交易而產生的投資損失</li>
            <li>因數據錯誤或系統故障導致的損失</li>
            <li>因第三方數據源中斷或延遲造成的損失</li>
          </ul>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white mb-2">隱私政策</h2>
          <p>本軟體不收集個人身份資訊。所有設定與資料儲存在使用者本地瀏覽器中（localStorage）。</p>
          <p className="mt-2">若使用 AI 分析功能，您的股票數據可能會傳送至 Anthropic API 進行處理。</p>
          <p className="mt-2">若使用電子郵件通知功能，您的電子郵件地址僅用於發送掃描結果通知。</p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white mb-2">智慧財產權</h2>
          <p>本軟體參考朱家泓老師的技術分析方法論作為教學基礎，但軟體本身及其程式碼為獨立開發。</p>
        </section>

        <section>
          <h2 className="text-lg font-bold text-white mb-3">常見問題 FAQ</h2>
          <div className="space-y-3">
            {[
              { q: '掃描出來的股票一定會漲嗎？', a: '不會。掃描只是找出符合技術條件的股票，不保證獲利。歷史回測勝率 50-60% 代表仍有 40-50% 的交易是虧損的。' },
              { q: '回測勝率 60% 很高了，可以直接照著買嗎？', a: '不建議。回測是在理想條件下的歷史模擬，實際交易受滑點、情緒、流動性影響，績效通常比回測差 20-30%。建議先紙上模擬交易 1-3 個月。' },
              { q: '六大條件的評分有什麼意義？', a: '評分代表該股票在趨勢、位置、K棒、均線、量能、指標六個面向的技術分析得分。分數越高表示技術面越強，但不代表一定會漲。' },
              { q: '飆股潛力分數 S 級的股票就是飆股嗎？', a: '不一定。S 級表示該股票具有多種飆股技術特徵（動能強、突破、量能配合等），但飆股的判斷還需要基本面、籌碼面配合，技術面只是其中一環。' },
              { q: '數據來源是什麼？準確嗎？', a: '數據來自 Yahoo Finance，是免費公開數據。可能有少許延遲或缺漏，但對日線級別的技術分析影響不大。若需要更精確的即時數據，建議搭配券商軟體使用。' },
              { q: '這個工具適合新手嗎？', a: '適合。K線走圖練習功能可以幫助新手理解股票走勢的規律，掃描功能可以節省選股時間。但建議新手先用紙上模擬交易功能，不要急著用真金白銀操作。' },
            ].map((faq, i) => (
              <details key={i} className="bg-slate-900/60 border border-slate-800 rounded-lg">
                <summary className="px-4 py-2.5 cursor-pointer text-sm text-slate-200 font-medium hover:text-white transition">
                  {faq.q}
                </summary>
                <div className="px-4 pb-3 text-sm text-slate-400">{faq.a}</div>
              </details>
            ))}
          </div>
        </section>

        <div className="border-t border-slate-800 pt-4 mt-8 text-xs text-slate-500">
          <p>最後更新：2026 年 3 月</p>
          <p>使用本軟體即表示您已閱讀並同意上述條款。</p>
        </div>
      </div>
    </div>
  );
}
