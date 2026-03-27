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

        <div className="border-t border-slate-800 pt-4 mt-8 text-xs text-slate-500">
          <p>最後更新：2026 年 3 月</p>
          <p>使用本軟體即表示您已閱讀並同意上述條款。</p>
        </div>
      </div>
    </div>
  );
}
