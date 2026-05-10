import { CandleWithIndicators } from '@/types';
import { ruleEngine } from '@/lib/rules/ruleEngine';
import { evaluateSixConditions, detectTrend, detectTrendPosition, TrendState } from '@/lib/analysis/trendAnalysis';
import { checkLongProhibitions, checkShortProhibitions } from '@/lib/rules/entryProhibitions';
import { evaluateShortSixConditions } from '@/lib/analysis/shortAnalysis';
import { StockScanResult, MarketConfig, TriggeredRule, ScanDiagnostics, createEmptyDiagnostics } from './types';
import type { StrategyThresholds } from '@/lib/strategy/StrategyConfig';
import { BASE_THRESHOLDS } from '@/lib/strategy/StrategyConfig';
import { evaluateHighWinRateEntry } from '@/lib/analysis/highWinRateEntry';
import { evaluateElimination } from '@/lib/scanner/eliminationFilter';
import { evaluateWinnerPatterns } from '@/lib/rules/winnerPatternRules';
import { evaluateMultiTimeframe, MultiTimeframeResult } from '@/lib/analysis/multiTimeframeFilter';
import { getScannerCache, setScannerCache, getScannerCacheStats } from '@/lib/datasource/ScannerCache';
import { loadLocalCandlesWithTolerance, saveLocalCandles, batchCheckFreshness } from '@/lib/datasource/LocalCandleStore';

// 掃描以本地檔案為主（L1 記憶體 + L2 本地），L3 API 嚴格限制
// 降低並發避免 API 限流（歷史掃描為 pure-local，今日掃描最多 20 次 API）
const CONCURRENCY = 30;
const BATCH_DELAY_MS = 0;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export type StockEntry = { symbol: string; name: string; industry?: string };

/** fetchCandlesForScan 回傳的帶新鮮度資訊結果 */
interface CandleFetchResult {
  candles: CandleWithIndicators[];
  staleDays: number;
  lastCandleDate: string;
  source: 'memory' | 'local' | 'api';
}

/** Session 層級數據新鮮度摘要 */
export interface SessionFreshness {
  avgStaleDays: number;
  maxStaleDays: number;
  staleCount: number;
  totalScanned: number;
  coverageRate: number;
  dataStatus: 'complete' | 'partial' | 'insufficient';
}

/** 即時報價（批量拿全市場後傳入 scanner） */
export interface RealtimeQuoteForScan {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** 報價資料日期 YYYY-MM-DD（用於判斷是否為今日數據，避免盤前用昨日數據假造今日 K 棒） */
  date?: string;
}

export abstract class MarketScanner {
  abstract getMarketConfig(): MarketConfig;
  abstract getStockList(): Promise<StockEntry[]>;
  abstract fetchCandles(symbol: string, asOfDate?: string): Promise<CandleWithIndicators[]>;
  /**
   * 大盤「真實」趨勢（純 detectTrend），給 UI banner / 條件面板 / 走圖一致顯示。
   * 不含「乖離過大降級為盤整」「短期走弱降級為盤整」這種掃描專用副作用。
   */
  abstract getMarketTrend(asOfDate?: string): Promise<TrendState>;
  /**
   * 大盤「掃描體質」（含降級規則），影響掃描 minScore。
   * 過熱 / 短期走弱時可能把多頭降為盤整 → 提高進場門檻。
   * 預設用 raw trend，子類可 override 加降級。
   */
  async getMarketScanRegime(asOfDate?: string): Promise<TrendState> {
    return this.getMarketTrend(asOfDate);
  }

  /** 即時報價 Map（code → quote），由 chunk route 在今日掃描前設置 */
  protected _realtimeQuotes: Map<string, RealtimeQuoteForScan> | null = null;

  /** L3 API fallback 預算（Vercel 用，每次 API 呼叫扣 1） */
  protected _l3Budget = 0;

  /** 設置全市場即時報價（今日掃描用） */
  setRealtimeQuotes(quotes: Map<string, RealtimeQuoteForScan>): void {
    this._realtimeQuotes = quotes;
  }

  /**
   * 粗掃：L2 快照夠健康時（>= 80% 預期），把沒報價的股票先 drop，避免逐檔讀 L1 的時間爆炸。
   * 鐵律 #3：全市場掃描必須使用快照粗掃。
   * L2 不健康時（剛啟動、來源掛）原樣返回，避免漏訊號。
   */
  protected prefilterByL2(stocks: StockEntry[], tag: string): StockEntry[] {
    const L2_PREFILTER_MIN_RATIO = 0.8;
    const market = this.getMarketConfig().marketId;
    const expectedCount = market === 'CN' ? 3062 : 1956;
    const l2Map = this._realtimeQuotes;
    if (!l2Map || l2Map.size < expectedCount * L2_PREFILTER_MIN_RATIO) {
      console.info(
        `[${tag}] ${market} 跳過粗掃 (L2 size=${l2Map?.size ?? 0})`
      );
      return stocks;
    }
    let noQuote = 0;
    let zeroVol = 0;
    const filtered = stocks.filter(({ symbol }) => {
      const code = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
      const q = l2Map.get(code);
      if (!q || q.close <= 0) { noQuote++; return false; }
      if (q.volume <= 0) { zeroVol++; return false; }
      return true;
    });

    // 2026-05-08：candidate cap by 成交額 top N
    // 修完 L2 partial bug 後 CN snapshot 從 2262 變 3062，scanBuyMethod 候選 ~2900 支跑超過
    // Vercel maxDuration 120s 大量 504。對成交額 top N 篩選保證 cron 在 budget 內完成。
    // CN 800 / TW 500：對齊書本「主流股 + 大量股」聚焦原則，剔除冷門股不影響選股質量。
    const TOP_N = market === 'CN' ? 800 : 500;
    let out = filtered;
    let cappedNote = '';
    if (filtered.length > TOP_N) {
      const ranked = filtered
        .map(s => {
          const code = s.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
          const q = l2Map.get(code)!;
          return { entry: s, turnover: q.close * q.volume };
        })
        .sort((a, b) => b.turnover - a.turnover)
        .slice(0, TOP_N);
      out = ranked.map(r => r.entry);
      cappedNote = `, top${TOP_N} 成交額`;
    }

    console.info(
      `[${tag}] ${market} 粗掃: ${stocks.length} → ${out.length} ` +
      `(L2 無報價 ${noQuote}, 零量 ${zeroVol}, L2 size=${l2Map.size}${cappedNote})`
    );
    return out;
  }

  /** 設置 L3 API fallback 預算上限（Vercel 環境用） */
  setL3Budget(n: number): void {
    this._l3Budget = n;
  }

  /**
   * 掃描前批次確保 K 線數據是最新的。
   * 檢查所有股票的本地 K 線，過期的自動下載更新。
   * @param symbols  股票代碼列表
   * @param asOfDate 掃描目標日期（undefined = 今天）
   * @param budget   最多下載幾支（避免超時），預設 100
   */
  protected async ensureFreshCandles(
    symbols: string[],
    asOfDate?: string,
    budget = 100,
  ): Promise<{ updated: number; failed: number; skipped: number }> {
    // 確保 .env.local 已載入（Next.js 環境自動載入，但 tsx/node 直接執行時不會）
    if (!process.env.__DOTENV_LOADED) {
      try {
        const fs = await import('fs');
        const path = await import('path');
        const envPath = path.join(process.cwd(), '.env.local');
        if (fs.existsSync(envPath)) {
          const content = fs.readFileSync(envPath, 'utf-8');
          for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx === -1) continue;
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
            if (!process.env[key]) process.env[key] = val;
          }
        }
        process.env.__DOTENV_LOADED = '1';
      } catch { /* 無 .env.local 或讀取失敗 */ }
    }

    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
    const targetDate = asOfDate ?? today;
    const market = this.getMarketConfig().marketId as 'TW' | 'CN';

    // 歷史掃描不需要更新（容忍舊數據）
    if (asOfDate && asOfDate < today) {
      return { updated: 0, failed: 0, skipped: symbols.length };
    }

    const { stale, missing } = await batchCheckFreshness(symbols, market, targetDate, 1);
    // 動態 budget：確保一次能覆蓋所有 missing，不被固定 budget=100 卡住
    const needed = stale.length + missing.length;
    const effectiveBudget = Math.min(Math.max(budget, needed), 500); // 最多 500，防止一次打太多 API
    const toUpdate = [...stale, ...missing].slice(0, effectiveBudget);

    if (toUpdate.length === 0) {
      return { updated: 0, failed: 0, skipped: 0 };
    }

    console.info(`[ensureFreshCandles] ${market} ${targetDate}: ${stale.length} stale + ${missing.length} missing，更新前 ${toUpdate.length} 支 (budget=${effectiveBudget})...`);

    let updated = 0;
    let failed = 0;

    // 分批下載（每批 10 支並行）
    for (let i = 0; i < toUpdate.length; i += 10) {
      const batch = toUpdate.slice(i, i + 10);
      const settled = await Promise.allSettled(
        batch.map(async (sym) => {
          const candles = await this.fetchCandles(sym, targetDate);
          if (candles.length >= 30) {
            const raw = candles.map(c => ({
              date: c.date, open: c.open, high: c.high,
              low: c.low, close: c.close, volume: c.volume,
            }));
            await saveLocalCandles(sym, market, raw);
            return true;
          }
          return false;
        })
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) updated++;
        else failed++;
      }
    }

    console.info(`[ensureFreshCandles] 完成：更新 ${updated}，失敗 ${failed}，略過 ${toUpdate.length - updated - failed}`);
    return { updated, failed, skipped: symbols.length - toUpdate.length };
  }

  /**
   * 掃描專用 fetchCandles — 三層快取：記憶體 → 本地檔案 → API
   * 走圖（單股即時）不經過這裡，直接用 fetchCandles()
   */
  protected async fetchCandlesForScan(
    symbol: string,
    asOfDate?: string,
    diag?: ScanDiagnostics,
  ): Promise<CandleFetchResult> {
    const tz = this.getMarketConfig().marketId === 'CN' ? 'Asia/Shanghai' : 'Asia/Taipei';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    // 有 L2 報價且日期匹配 asOfDate 時，視為「今日掃描」而非純歷史
    // 2026-05-07 修：原 `values().next().value` 只看 Map 第一筆，若昨日殘留 + 今日新值
    // 並存（例：cron 啟動時 partial refresh），第一筆若是昨日就誤判 isHistorical=true
    // 整批走歷史路徑，當日 L2 全被忽略 → 漏訊號。
    // 改抽樣前 20 筆，多數匹配才算「今日 L2」。
    const hasL2ForDate = this._realtimeQuotes && this._realtimeQuotes.size > 0 &&
      asOfDate && (() => {
        let total = 0;
        let matched = 0;
        for (const q of this._realtimeQuotes!.values()) {
          total++;
          if (q?.date === asOfDate) matched++;
          if (total >= 20) break;
        }
        return total > 0 && matched / total >= 0.5;
      })();
    const isHistorical = !!asOfDate && asOfDate < today && !hasL2ForDate;
    const market = this.getMarketConfig().marketId as 'TW' | 'CN';

    if (isHistorical) {
      // L1: 記憶體快取
      const memCached = getScannerCache(symbol, asOfDate);
      if (memCached) {
        if (diag) diag.memoryCacheHits++;
        const lastDate = memCached.length > 0 ? memCached[memCached.length - 1].date : '';
        return { candles: memCached, staleDays: 0, lastCandleDate: lastDate, source: 'memory' };
      }

      // L2: 本地檔案（容忍 5 個交易日差距）
      try {
        const local = await loadLocalCandlesWithTolerance(symbol, market, asOfDate, 5);
        if (local && local.candles.length > 0) {
          setScannerCache(symbol, asOfDate, local.candles);
          if (diag) {
            diag.localCacheHits++;
            if (local.staleDays > 0) diag.localCacheStale++;
          }
          const lastDate = local.candles[local.candles.length - 1].date;
          return { candles: local.candles, staleDays: local.staleDays, lastCandleDate: lastDate, source: 'local' };
        }
      } catch { /* 本地讀取失敗，fallback 到 API */ }
    } else {
      // 今日掃描（含 L2 補掃過去日期）：本地歷史 + 即時報價合併 K 棒
      // targetDate: L2 補掃用 asOfDate（如 0414），真正盤中用 today（0415）
      const targetDate = hasL2ForDate ? asOfDate! : today;
      // 容忍 5 個交易日（與歷史掃描一致），因為 K 棒會由即時報價合併補上
      try {
        const local = await loadLocalCandlesWithTolerance(symbol, market, targetDate, 5);
        if (local && local.candles.length > 0) {
          if (diag) {
            diag.localCacheHits++;
            if (local.staleDays > 0) diag.localCacheStale++;
          }

          // 如果有即時報價，合併 K 棒
          if (this._realtimeQuotes) {
            const code = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
            const quote = this._realtimeQuotes.get(code);
            // L2 miss 很常見（股票停牌/今日未交易），改由 caller 做前置粗掃再決定是否進來，
            // 這裡靜默不再逐檔 WARN log（以前一次掃會堆 11000+ 條，佔滿 log）。
            if (quote && quote.close > 0) {
              // 盤前防護：如果報價日期不是目標日，表示市場未開盤，不建立假的 K 棒
              const quoteIsTarget = quote.date
                ? quote.date === targetDate
                : true; // EastMoney 無日期，依賴開盤時間判斷（已在 API 層處理）

              const rawCandles = local.candles.map(c => ({
                date: c.date, open: c.open, high: c.high,
                low: c.low, close: c.close, volume: c.volume,
              }));
              const last = rawCandles[rawCandles.length - 1];

              if (last.date === targetDate) {
                // 更新目標日已有的 K 棒
                last.close = quote.close;
                last.high = Math.max(quote.high, last.high);
                last.low = Math.min(quote.low, last.low);
                last.volume = quote.volume || last.volume;
                if (quote.open > 0) last.open = quote.open; // L2 開盤價優先（修正從昨日收盤繼承的 open）
              } else if (quoteIsTarget && last.date < targetDate) {
                // Append 即時 K 棒（僅在確認報價是目標日數據時）
                rawCandles.push({
                  date: targetDate,
                  open: quote.open,
                  high: quote.high,
                  low: quote.low,
                  close: quote.close,
                  volume: quote.volume,
                });
              }
              // else: 報價非目標日 → 不 append，直接用本地歷史數據掃描

              const { computeIndicators } = await import('@/lib/indicators');
              const merged = computeIndicators(rawCandles);
              const mergedLast = merged[merged.length - 1];

              // 如果 L2 報價有日期欄位但不是目標日，代表 L2 是昨日舊數據。
              // 此時 mergedLast.date 仍會是昨日，標記極高 staleDays 讓 staleDays > 5 跳過檢查，
              // 避免用昨日 K 棒假冒今日掃描結果（例如 04/14 漲停被誤判為 04/15 進場訊號）。
              const isQuoteStaleForToday = !!(quote.date && quote.date !== targetDate);
              const effectiveStaleDays = mergedLast.date === targetDate
                ? 0
                : (isQuoteStaleForToday ? local.staleDays + 999 : local.staleDays);

              return { candles: merged, staleDays: effectiveStaleDays, lastCandleDate: mergedLast.date, source: 'local' };
            }
          }

          const lastDate = local.candles[local.candles.length - 1].date;
          return { candles: local.candles, staleDays: local.staleDays, lastCandleDate: lastDate, source: 'local' };
        }
      } catch { /* 本地讀取失敗，fallback */ }
    }

    // L3: 有預算時透過 API 取得（Vercel 無本地檔案時的 fallback）
    if (this._l3Budget > 0) {
      this._l3Budget--;
      try {
        const candles = await Promise.race([
          this.fetchCandles(symbol, asOfDate),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('L3 timeout')), 5000)),
        ]);
        if (candles.length >= 30) {
          // 持久化到本地（下次不用再 API 取）
          const raw = candles.map(c => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));
          saveLocalCandles(symbol, market, raw).catch(() => {});
          if (diag) diag.localCacheHits++; // 算作成功取得
          const lastDate = candles[candles.length - 1].date;
          return { candles, staleDays: 0, lastCandleDate: lastDate, source: 'api' };
        }
      } catch {
        // L3 timeout or API error — fallthrough to missing
      }
    }

    // 無法取得數據 — 記錄缺失
    if (diag) {
      diag.dataMissing++;
      if (diag.missingSymbols.length < 20) {
        diag.missingSymbols.push(symbol);
      }
    }
    return { candles: [], staleDays: -1, lastCandleDate: '', source: 'local' };
  }

  /**
   * 根據大盤趨勢動態計算個股最低分數門檻
   * 使用策略設定的 bullMinScore / sidewaysMinScore / bearMinScore
   */
  private marketTrendToMinScore(marketTrend: TrendState, thresholds: StrategyThresholds): number {
    if (marketTrend === '多頭') return thresholds.bullMinScore;
    if (marketTrend === '盤整') return thresholds.sidewaysMinScore;
    return thresholds.bearMinScore; // 空頭
  }

  private async scanOne(
    symbol: string,
    rawName: string,
    config: MarketConfig,
    minScore: number,
    thresholds: StrategyThresholds,
    asOfDate?: string,
    industry?: string,
    diag?: ScanDiagnostics,
    institutionalMap?: Map<string, Array<{ date: string; netShares: number }>>,
  ): Promise<StockScanResult | null> {
    try {
      let name = rawName;
      if (/\.(SZ|SS)$/i.test(symbol)) {
        try {
          const m = symbol.match(/^(\d+)\.(SS|SZ)$/i);
          const code = m?.[1] ?? symbol.replace(/\.(SZ|SS)$/i, '');
          const cnSuffix = (m?.[2]?.toUpperCase() === 'SS' ? 'SS' : 'SZ') as 'SS' | 'SZ';
          const { getCNChineseName } = await import('@/lib/datasource/TWSENames');
          const cnName = await getCNChineseName(code, cnSuffix);
          if (cnName) name = cnName;
        } catch { /* 查不到就用東方財富的名字 */ }
      }

      const fetchResult = await this.fetchCandlesForScan(symbol, asOfDate, diag);
      if (fetchResult.candles.length < 30) {
        if (diag) diag.tooFewCandles++;
        return null;
      }

      // Fail-closed：掃描目標日 = 今日時，L1 末根必須 === 今日，否則跳過
      // 過去曾放寬到 staleDays > 5 才擋，結果 2026-04-17 因 L2 被 quarantine
      // 導致 1928/1957 支 TW L1 末根停在 04-16，仍全部放行，跑出用 04-16 bar
      // 冒充 04-17 結果的 L4。寧可當天結果變少，也不要偽造一天差的分析。
      // 歷史回測（asOfDate !== today）不受影響：歷史資料本來就完整，末根匹配率應該近 100%。
      if (asOfDate && fetchResult.lastCandleDate !== asOfDate) {
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
        if (asOfDate === today) {
          if (diag) {
            diag.filteredOut++;
            diag.skippedStaleL1 = (diag.skippedStaleL1 ?? 0) + 1;
          }
          return null;
        }
      }

      const candles = fetchResult.candles;

      const lastIdx = candles.length - 1;
      const last = candles[lastIdx];

      // ══════════════════════════════════════════════════════════════════
      // 第零層：長線保護短線（多時間框架前置過濾）
      // ══════════════════════════════════════════════════════════════════

      // ALWAYS 計算 MTF 分數（支援前端 client-side toggle），
      // 但只在 multiTimeframeFilter=true 時才做前置過濾
      let mtfResult: MultiTimeframeResult | undefined;
      try {
        mtfResult = evaluateMultiTimeframe(candles, thresholds);
      } catch { /* MTF 計算失敗不影響主流程 */ }
      if (thresholds.multiTimeframeFilter && mtfResult && !mtfResult.pass) {
        if (diag) diag.filteredOut++;
        return null;
      }

      // ══════════════════════════════════════════════════════════════════
      // 第一層：選股（純朱家泓書本體系）
      // ══════════════════════════════════════════════════════════════════

      // ── 1. 六大條件（前5個=核心門檻，第6個 KD/MACD=候補加分）──────────
      const sixConds = evaluateSixConditions(candles, lastIdx, thresholds);
      if (!sixConds.isCoreReady) { if (diag) diag.filteredOut++; return null; }

      // ── 1b. minScore 門檻（盤整/空頭市場可能要求 6/6 含指標條件）────────
      if (sixConds.totalScore < minScore) { if (diag) diag.filteredOut++; return null; }

      // ── 2. 短線第9條：KD值向下時不買（可由 kdDecliningFilter 關閉）────
      if (thresholds.kdDecliningFilter !== false && last.kdK != null && lastIdx > 0) {
        const prevKdK = candles[lastIdx - 1]?.kdK;
        if (prevKdK != null && last.kdK < prevKdK) { if (diag) diag.filteredOut++; return null; }
      }

      // 短線第10條（上影線>50%不買）已由六條件⑤覆蓋（upperShadowMax 預設20%），不再重複檢查

      // ── 3. 10大戒律：硬性禁忌過濾（朱老師 p.54）─────────────────────
      // 戒律 8「主力連續淨賣出」：TW=三大法人買賣超（單位股）、CN=主力資金（單位元）
      const instSymbol = symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
      const prohibCtx = institutionalMap
        ? {
            institutionalHistory: institutionalMap.get(instSymbol),
            minMeaningfulOutflow: config.marketId === 'CN' ? -5_000_000 : -50_000,
          }
        : undefined;
      const prohib = checkLongProhibitions(candles, lastIdx, prohibCtx);
      if (prohib.prohibited) { if (diag) diag.filteredOut++; return null; }

      // ── 5. 淘汰法 R1-R11（寶典）─────────────────────────────────────
      const elimination = evaluateElimination(candles, lastIdx);
      if (elimination.eliminated) { if (diag) diag.filteredOut++; return null; }

      // ══════════════════════════════════════════════════════════════════
      // 第二層：排序資料收集（共振 + 高勝率進場）
      // ══════════════════════════════════════════════════════════════════

      const trend = detectTrend(candles, lastIdx);
      const position = detectTrendPosition(candles, lastIdx);
      const signals = ruleEngine.evaluate(candles, lastIdx);

      const triggeredRules: TriggeredRule[] = signals.map(s => ({
        ruleId: s.ruleId, ruleName: s.label, signalType: s.type, reason: s.description,
      }));

      // ── 高勝率進場位置（朱老師《活用技術分析寶典》Part 12）─────────────
      let highWinRateEntry: ReturnType<typeof evaluateHighWinRateEntry> = {
        matched: false, types: [], score: 0, details: [],
      };
      try {
        highWinRateEntry = evaluateHighWinRateEntry(candles, lastIdx);
      } catch { /* non-critical */ }

      // ── 33 種贏家圖像（朱家泓《活用技術分析寶典》Part 12, P771-825）──────
      let winnerBullishPatterns: string[] = [];
      let winnerBearishPatterns: string[] = [];
      try {
        const winner = evaluateWinnerPatterns(candles, lastIdx);
        winnerBullishPatterns = winner.bullishPatterns.map(p => p.name);
        winnerBearishPatterns = winner.bearishPatterns.map(p => p.name);
      } catch { /* non-critical */ }

      const changePercent = lastIdx > 0 && candles[lastIdx - 1]?.close > 0
        ? +((last.close - candles[lastIdx - 1].close) / candles[lastIdx - 1].close * 100).toFixed(2)
        : 0;

      // ── 並列買法標記（Phase 5 接進 cron，2026-04-20）─────────────────────
      // 2026-04-21 rename: B=回後買上漲、C=盤整突破、D=一字底、E=缺口、F=V形反轉
      // 通過 A 六條件 isCoreReady → A 成立；其他偵測器獨立判定，疊加標記
      const matchedMethods: string[] = ['A'];
      try {
        const { detectBreakoutEntry } = await import('@/lib/analysis/breakoutEntry');
        if (detectBreakoutEntry(candles, lastIdx)) matchedMethods.push('B');
      } catch { /* non-critical */ }
      try {
        const { detectConsolidationBreakout } = await import('@/lib/analysis/breakoutEntry');
        if (detectConsolidationBreakout(candles, lastIdx)) matchedMethods.push('C');
      } catch { /* non-critical */ }
      try {
        const { detectStrategyE } = await import('@/lib/analysis/highWinRateEntry');
        if (detectStrategyE(candles, lastIdx)) matchedMethods.push('D');
      } catch { /* non-critical */ }
      try {
        const { detectStrategyD } = await import('@/lib/analysis/gapEntry');
        if (detectStrategyD(candles, lastIdx)) matchedMethods.push('E');
      } catch { /* non-critical */ }
      try {
        const { detectVReversal } = await import('@/lib/analysis/vReversalDetector');
        if (detectVReversal(candles, lastIdx)) matchedMethods.push('F');
      } catch { /* non-critical */ }
      try {
        const { detectABCBreakout } = await import('@/lib/analysis/abcBreakoutEntry');
        if (detectABCBreakout(candles, lastIdx)?.isABCBreakout) matchedMethods.push('G');
      } catch { /* non-critical */ }
      try {
        const { detectBlackKBreakout } = await import('@/lib/analysis/blackKBreakoutEntry');
        if (detectBlackKBreakout(candles, lastIdx)?.isBlackKBreakout) matchedMethods.push('H');
      } catch { /* non-critical */ }
      try {
        const { detectKlineConsolidationBreakout } = await import('@/lib/analysis/klineConsolidationBreakout');
        if (detectKlineConsolidationBreakout(candles, lastIdx)?.isBreakout) matchedMethods.push('I');
      } catch { /* non-critical */ }
      // v12 後補字母 M/N/O/P/Q（J/K/L 是 G/H/I 的 alias，UI 端 dedupe 處理 → 不重複算）
      try {
        const { detectLetterM } = await import('@/lib/analysis/v12LetterM');
        if (detectLetterM(candles, lastIdx, config.marketId, symbol).triggered) matchedMethods.push('M');
      } catch { /* non-critical */ }
      try {
        const { detectLetterN } = await import('@/lib/analysis/v12LetterN');
        if (detectLetterN(candles, lastIdx, config.marketId, symbol).triggered) matchedMethods.push('N');
      } catch { /* non-critical */ }
      try {
        const { detectLetterO } = await import('@/lib/analysis/v12LetterO');
        if (detectLetterO(candles, lastIdx, config.marketId, symbol).triggered) matchedMethods.push('O');
      } catch { /* non-critical */ }
      try {
        const { detectLetterP } = await import('@/lib/analysis/v12LetterP');
        if (detectLetterP(candles, lastIdx, config.marketId, symbol).triggered) matchedMethods.push('P');
      } catch { /* non-critical */ }
      try {
        const { detectLetterQ } = await import('@/lib/analysis/v12LetterQ');
        if (detectLetterQ(candles, lastIdx, config.marketId, symbol).triggered) matchedMethods.push('Q');
      } catch { /* non-critical */ }

      return {
        symbol,
        name,
        market: config.marketId,
        industry,
        price: last.close,
        changePercent,
        volume: last.volume,
        triggeredRules,
        matchedMethods,
        sixConditionsScore: sixConds.totalScore,
        sixConditionsBreakdown: {
          trend:     sixConds.trend.pass,
          position:  sixConds.position.pass,
          kbar:      sixConds.kbar.pass,
          ma:        sixConds.ma.pass,
          volume:    sixConds.volume.pass,
          indicator: sixConds.indicator.pass,
        },
        trendState: trend,
        trendPosition: position,
        scanTime: asOfDate ? `${asOfDate}T00:00:00.000Z` : new Date().toISOString(),
        // ── 排序因子 ─────────────────────────────────────────────────────
        highWinRateTypes: highWinRateEntry.types,
        highWinRateScore: highWinRateEntry.score,
        highWinRateDetails: highWinRateEntry.details,
        // ── 淘汰法（資訊保留，供 UI 顯示）──────────────────────────────
        eliminationReasons: elimination.reasons,
        eliminationPenalty: elimination.penalty,
        // ── 33 種贏家圖像（寶典 Part 12）─────────────────────────────────
        winnerBullishPatterns,
        winnerBearishPatterns,
        // ── 長線保護短線（多時間框架）──────────────────────────────────
        ...(mtfResult ? {
          mtfScore: mtfResult.totalScore,
          mtfWeeklyTrend: mtfResult.weekly.trend,
          mtfWeeklyPass: mtfResult.weekly.pass,
          mtfWeeklyDetail: mtfResult.weekly.detail,
          mtfMonthlyTrend: mtfResult.monthly.trend,
          mtfMonthlyPass: mtfResult.monthly.pass,
          mtfMonthlyDetail: mtfResult.monthly.detail,
          mtfWeeklyNearResistance: mtfResult.weeklyNearResistance,
          mtfWeeklyChecks: mtfResult.weeklyChecks,
        } : {}),
        // ── 數據新鮮度 ──────────────────────────────────────────────────
        dataFreshness: {
          lastCandleDate: fetchResult.lastCandleDate,
          daysStale: fetchResult.staleDays,
          source: fetchResult.source,
        },
      };
    } catch (err) {
      if (diag && diag.errorSamples.length < 5) {
        diag.errorSamples.push(`${symbol}: ${err instanceof Error ? err.message : String(err)}`);
      }
      return null;
    }
  }

  /**
   * 純朱老師 SOP 掃描（minScore=0 一律輸出，由 caller 自行過濾）
   * 內部簡寫呼叫 scanOne() 的常用組合
   */
  private scanOnePure(
    symbol: string,
    rawName: string,
    config: MarketConfig,
    minScore: number,
    thresholds: StrategyThresholds,
    asOfDate?: string,
    industry?: string,
  ): Promise<StockScanResult | null> {
    return this.scanOne(symbol, rawName, config, minScore, thresholds, asOfDate, industry);
  }

  /**
   * 純朱家泓掃描：用 scanOnePure，按六大條件排序
   */
  async scanPure(
    thresholds?: StrategyThresholds,
    asOfDate?: string,
  ): Promise<{ results: StockScanResult[]; marketTrend?: TrendState }> {
    const config = this.getMarketConfig();
    const th = thresholds ?? BASE_THRESHOLDS;
    // marketTrend = 純 detectTrend（給 UI banner 顯示用，三邊統一）
    // regime = 含降級邏輯（給 minScore 計算用，書本「乖離過大不追高」精神）
    const marketTrend = await this.getMarketTrend(asOfDate);
    const regime = await this.getMarketScanRegime(asOfDate);
    const minScore = this.marketTrendToMinScore(regime, th);

    const stockList = await this.getStockList();
    const results: StockScanResult[] = [];

    const chunks: StockEntry[][] = [];
    for (let i = 0; i < stockList.length; i += CONCURRENCY) {
      chunks.push(stockList.slice(i, i + CONCURRENCY));
    }

    for (let ci = 0; ci < chunks.length; ci++) {
      const promises = chunks[ci].map(s =>
        this.scanOnePure(s.symbol, s.name, config, minScore, th, asOfDate, s.industry)
      );
      const settled = await Promise.allSettled(promises);
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      }
      if (ci < chunks.length - 1) await sleep(BATCH_DELAY_MS);
    }

    results.sort((a, b) => b.sixConditionsScore - a.sixConditionsScore);

    // ── 寫 Step 1 池子 cache（書本五步法 Step 1 → Step 2 銜接）──────
    // results = 過「六條件 + 戒律 + 淘汰法」的合格股票池
    // 多頭軌 8 個 detector（B/C/E/J/K/L/M/P）讀這個 cache 當候選來源
    // 反轉軌 + 戰法軌 不過 Step 1，全市場掃描（不用這個 cache）
    // 概念：今日的池子今日用，明天會重新算
    const poolDate = asOfDate
      ?? new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
    try {
      const { saveStep1Pool } = await import('./step1Pool');
      await saveStep1Pool({
        market: config.marketId,
        date: poolDate,
        symbols: results.map(r => r.symbol),
        generatedAt: new Date().toISOString(),
        stats: {
          total: stockList.length,
          passSixCond: results.length,
          passProhib: results.length,
          passElim: results.length,
        },
      });
    } catch (err) {
      console.warn('[scanPure] saveStep1Pool failed (non-critical):', err);
    }

    return { results, marketTrend };
  }

  /**
   * Compute full scan data for a single ticker WITHOUT any entry filters.
   * Used by the AI analysis engine to get accurate technical context.
   */
  async fetchStockScanData(symbol: string, name: string): Promise<StockScanResult | null> {
    try {
      const candles = await this.fetchCandles(symbol);
      if (candles.length < 30) return null;

      const lastIdx = candles.length - 1;
      const last    = candles[lastIdx];
      const prev    = candles[lastIdx - 1];

      const config = this.getMarketConfig();
      const thresholds = BASE_THRESHOLDS;
      const signals  = ruleEngine.evaluate(candles, lastIdx);
      const sixConds = evaluateSixConditions(candles, lastIdx, thresholds);
      const trend    = detectTrend(candles, lastIdx);
      const position = detectTrendPosition(candles, lastIdx);

      const changePercent = prev?.close > 0
        ? +((last.close - prev.close) / prev.close * 100).toFixed(2) : 0;

      const triggeredRules: TriggeredRule[] = signals.map(s => ({
        ruleId: s.ruleId, ruleName: s.label, signalType: s.type, reason: s.description,
      }));

      return {
        symbol,
        name,
        market: config.marketId,
        price: last.close,
        changePercent,
        volume: last.volume,
        triggeredRules,
        sixConditionsScore: sixConds.totalScore,
        sixConditionsBreakdown: {
          trend:     sixConds.trend.pass,
          position:  sixConds.position.pass,
          kbar:      sixConds.kbar.pass,
          ma:        sixConds.ma.pass,
          volume:    sixConds.volume.pass,
          indicator: sixConds.indicator.pass,
        },
        trendState: trend,
        trendPosition: position,
        scanTime: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  /** Scan a provided sub-list of stocks (used by chunked parallel scanning) */
  async scanList(
    stocks: StockEntry[],
    thresholds?: StrategyThresholds,
  ): Promise<{ results: StockScanResult[]; marketTrend: TrendState; diagnostics: ScanDiagnostics }> {
    return this._scanChunk(stocks, undefined, thresholds);
  }

  /** Scan a provided sub-list of stocks as of a specific historical date (backtest mode) */
  async scanListAtDate(
    stocks: StockEntry[],
    asOfDate: string,
    thresholds?: StrategyThresholds,
  ): Promise<{ results: StockScanResult[]; marketTrend: TrendState; diagnostics: ScanDiagnostics }> {
    return this._scanChunk(stocks, asOfDate, thresholds);
  }

  /**
   * 純朱家泓掃描（歷史日期版）：只用六大條件核心篩選
   */
  async scanListAtDatePure(
    stocks: StockEntry[],
    asOfDate: string,
    thresholds?: StrategyThresholds,
  ): Promise<{ results: StockScanResult[]; marketTrend: TrendState }> {
    const config = this.getMarketConfig();
    const th = thresholds ?? BASE_THRESHOLDS;
    const results: StockScanResult[] = [];

    let minScore = th.minScore;
    let marketTrend: TrendState = '多頭';
    try {
      // raw trend 給 session/UI 顯示，scan regime（含降級）給 minScore
      marketTrend = await this.getMarketTrend(asOfDate);
      if (th.marketTrendFilter) {
        const regime = await this.getMarketScanRegime(asOfDate);
        minScore = this.marketTrendToMinScore(regime, th);
      }
    } catch { /* fallback */ }

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(({ symbol, name, industry }) =>
          this.scanOnePure(symbol, name, config, minScore, th, asOfDate, industry)
        )
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      }
      if (i + CONCURRENCY < stocks.length) await sleep(BATCH_DELAY_MS);
    }

    results.sort((a, b) => b.sixConditionsScore - a.sixConditionsScore);
    return { results, marketTrend };
  }

  /**
   * 做空版單股掃描：純朱家泓書本體系（空頭六條件 + 做空戒律）
   */
  private async scanOneShort(
    symbol: string,
    rawName: string,
    config: MarketConfig,
    thresholds: StrategyThresholds,
    asOfDate?: string,
    industry?: string,
    diag?: ScanDiagnostics,
  ): Promise<StockScanResult | null> {
    try {
      let name = rawName;
      if (/\.(SZ|SS)$/i.test(symbol)) {
        try {
          const m = symbol.match(/^(\d+)\.(SS|SZ)$/i);
          const code = m?.[1] ?? symbol.replace(/\.(SZ|SS)$/i, '');
          const cnSuffix = (m?.[2]?.toUpperCase() === 'SS' ? 'SS' : 'SZ') as 'SS' | 'SZ';
          const { getCNChineseName } = await import('@/lib/datasource/TWSENames');
          const cnName = await getCNChineseName(code, cnSuffix);
          if (cnName) name = cnName;
        } catch { /* fallback */ }
      }

      const fetchResult = await this.fetchCandlesForScan(symbol, asOfDate, diag);
      if (fetchResult.candles.length < 30) { if (diag) diag.tooFewCandles++; return null; }
      const candles = fetchResult.candles;

      const lastIdx = candles.length - 1;
      const last = candles[lastIdx];

      // ══════════════════════════════════════════════════════════════════
      // 第零層：長線保護短線（多時間框架前置過濾）
      // ══════════════════════════════════════════════════════════════════

      // ALWAYS 計算 MTF 分數（支援前端 client-side toggle）
      let mtfResult: MultiTimeframeResult | undefined;
      try {
        mtfResult = evaluateMultiTimeframe(candles, thresholds);
      } catch { /* MTF 計算失敗不影響主流程 */ }
      if (thresholds.multiTimeframeFilter && mtfResult && !mtfResult.pass) {
        if (diag) diag.filteredOut++;
        return null;
      }

      // ══════════════════════════════════════════════════════════════════
      // 第一層：選股（純朱家泓書本體系 — 做空版）
      // ══════════════════════════════════════════════════════════════════

      // ── 1. 空頭六條件（前5個=核心門檻）─────────────────────────────
      const shortConds = evaluateShortSixConditions(candles, lastIdx);
      if (!shortConds.isCoreReady) return null;

      // ── 2. 做空戒律 ────────────────────────────────────────────────
      const prohib = checkShortProhibitions(candles, lastIdx);
      if (prohib.prohibited) return null;

      // 書裡沒有做空淘汰法則，不加

      // ══════════════════════════════════════════════════════════════════
      // 第二層：排序資料收集（共振 + 高勝率進場）
      // ══════════════════════════════════════════════════════════════════

      const signals = ruleEngine.evaluate(candles, lastIdx);
      const triggeredRules: TriggeredRule[] = signals.map(s => ({
        ruleId: s.ruleId, ruleName: s.label, signalType: s.type, reason: s.description,
      }));

      const changePercent = lastIdx > 0 && candles[lastIdx - 1]?.close > 0
        ? +((last.close - candles[lastIdx - 1].close) / candles[lastIdx - 1].close * 100).toFixed(2)
        : 0;

      return {
        symbol,
        name,
        market: config.marketId,
        industry,
        price: last.close,
        changePercent,
        volume: last.volume,
        triggeredRules,
        sixConditionsScore: 0,
        sixConditionsBreakdown: {
          trend: false, position: false, kbar: false, ma: false, volume: false, indicator: false,
        },
        shortSixConditionsScore: shortConds.totalScore,
        shortSixConditionsBreakdown: {
          trend:     shortConds.trend.pass,
          ma:        shortConds.ma.pass,
          position:  shortConds.position.pass,
          volume:    shortConds.volume.pass,
          kbar:      shortConds.kbar.pass,
          indicator: shortConds.indicator.pass,
        },
        direction: 'short',
        trendState: '空頭',
        trendPosition: shortConds.position.stage ?? '',
        scanTime: asOfDate ? `${asOfDate}T00:00:00.000Z` : new Date().toISOString(),
        // ── 數據新鮮度 ──────────────────────────────────────────────────
        dataFreshness: {
          lastCandleDate: fetchResult.lastCandleDate,
          daysStale: fetchResult.staleDays,
          source: fetchResult.source,
        },
      };
    } catch {
      return null;
    }
  }

  /**
   * 做空候選股篩選層
   */
  async scanShortCandidates(
    stocks: StockEntry[],
    asOfDate?: string,
    thresholds?: StrategyThresholds,
  ): Promise<{ candidates: StockScanResult[]; marketTrend: TrendState; diagnostics: ScanDiagnostics; sessionFreshness: SessionFreshness }> {
    // P1A: 移除 ensureFreshCandles（避免批次下載打爆 API 配額）

    const config = this.getMarketConfig();
    const th = thresholds ?? BASE_THRESHOLDS;
    const candidates: StockScanResult[] = [];
    const diag = createEmptyDiagnostics();
    diag.totalStocks = stocks.length;

    let marketTrend: TrendState = '空頭';
    try {
      marketTrend = await this.getMarketTrend(asOfDate);
    } catch { /* fallback */ }

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(({ symbol, name, industry }) =>
          this.scanOneShort(symbol, name, config, th, asOfDate, industry, diag)
        )
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) candidates.push(r.value);
      }
      diag.processedCount += batch.length;
      if (i + CONCURRENCY < stocks.length) await sleep(BATCH_DELAY_MS);
    }

    // 計算覆蓋率
    const usable = diag.totalStocks - diag.dataMissing;
    diag.coverageRate = diag.totalStocks > 0 ? Math.round(usable / diag.totalStocks * 100) : 100;
    diag.dataStatus = diag.coverageRate >= 95 ? 'complete' : diag.coverageRate >= 70 ? 'partial' : 'insufficient';

    candidates.sort((a, b) => (b.shortSixConditionsScore ?? 0) - (a.shortSixConditionsScore ?? 0));

    // 聚合 dataFreshness 摘要
    const freshnessItems = candidates.filter(r => r.dataFreshness);
    const sessionFreshness = {
      avgStaleDays: freshnessItems.length > 0
        ? +(freshnessItems.reduce((s, r) => s + (r.dataFreshness?.daysStale ?? 0), 0) / freshnessItems.length).toFixed(1)
        : 0,
      maxStaleDays: Math.max(0, ...freshnessItems.map(r => r.dataFreshness?.daysStale ?? 0)),
      staleCount: freshnessItems.filter(r => (r.dataFreshness?.daysStale ?? 0) > 0).length,
      totalScanned: diag.totalStocks,
      coverageRate: diag.coverageRate,
      dataStatus: diag.dataStatus,
    };

    console.info('[ScanShort Diagnostics]', JSON.stringify(diag));
    return { candidates, marketTrend, diagnostics: diag, sessionFreshness };
  }

  /**
   * 候選股篩選層
   */
  async scanCandidates(
    stocks: StockEntry[],
    asOfDate?: string,
    thresholds?: StrategyThresholds,
  ): Promise<{ candidates: StockScanResult[]; marketTrend: TrendState }> {
    const config = this.getMarketConfig();
    const th = thresholds ?? BASE_THRESHOLDS;
    const candidates: StockScanResult[] = [];

    let marketTrend: TrendState = '多頭';
    try {
      marketTrend = await this.getMarketTrend(asOfDate);
    } catch { /* fallback */ }

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(({ symbol, name, industry }) =>
          this.scanOnePure(symbol, name, config, th.minScore, th, asOfDate, industry)
        )
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) {
          candidates.push(r.value);
        }
      }
      if (i + CONCURRENCY < stocks.length) await sleep(BATCH_DELAY_MS);
    }

    return { candidates, marketTrend };
  }

  /**
   * 候選股排序層 — 六條件總分優先（2025-2026年回測最佳，+236%）
   * 同分時以共振分+高勝率分為次要排序
   */
  rankCandidates(
    candidates: StockScanResult[],
    _rankBy?: string,
  ): StockScanResult[] {
    return [...candidates].sort((a, b) =>
      (b.sixConditionsScore ?? 0) - (a.sixConditionsScore ?? 0) ||
      b.changePercent - a.changePercent
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // V2 簡化版掃描：純朱老師 SOP（六條件+戒律+淘汰法）
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * V2 簡化版掃描入口
   */
  async scanSOP(
    stocks: StockEntry[],
    asOfDate?: string,
    thresholds?: StrategyThresholds,
    rankBy: 'sixConditions' | 'histWinRate' = 'sixConditions',
  ): Promise<{ results: StockScanResult[]; marketTrend: TrendState; diagnostics: ScanDiagnostics; sessionFreshness: SessionFreshness }> {
    // ── P1A: 移除掃描入口的 ensureFreshCandles ──
    // 掃描路徑已有 fetchCandlesForScan() 做 memory → local → API 三層快取，
    // 不需要前置批次下載（會打爆 FinMind/EODHD 配額）。
    // ensureFreshCandles 保留給 cron 批次用。

    const config = this.getMarketConfig();
    const th = thresholds ?? BASE_THRESHOLDS;
    const candidates: StockScanResult[] = [];
    const diag = createEmptyDiagnostics();
    diag.totalStocks = stocks.length;

    let minScore = th.minScore;
    let marketTrend: TrendState = '多頭';
    try {
      // raw trend 給 session/UI 顯示，scan regime（含降級）給 minScore
      marketTrend = await this.getMarketTrend(asOfDate);
      if (th.marketTrendFilter) {
        const regime = await this.getMarketScanRegime(asOfDate);
        minScore = this.marketTrendToMinScore(regime, th);
      }
    } catch { /* fallback */ }

    // pre-load 主力/法人資料（書本淘汰 #8 用）
    //   TW: 三大法人 T86（institutionalStorage）
    //   CN: 主力資金流（capitalFlowStorage，數值單位為元而非股數，但邏輯一致）
    let institutionalMap: Map<string, Array<{ date: string; netShares: number }>> | undefined;
    if (config.marketId === 'TW') {
      try {
        const { buildInstitutionalMapTW } = await import('@/lib/storage/institutionalStorage');
        const refDate = asOfDate ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
        institutionalMap = await buildInstitutionalMapTW(refDate, 5);
        if (institutionalMap.size > 0) {
          console.info(`[ScanSOP] TW 法人資料 pre-loaded: ${institutionalMap.size} 支`);
        }
      } catch (err) {
        console.warn('[ScanSOP] TW 法人資料載入失敗:', err instanceof Error ? err.message : err);
      }
    } else if (config.marketId === 'CN') {
      try {
        const { buildCapitalFlowMapCN } = await import('@/lib/storage/capitalFlowStorage');
        const refDate = asOfDate ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
        institutionalMap = await buildCapitalFlowMapCN(refDate, 5);
        if (institutionalMap.size > 0) {
          console.info(`[ScanSOP] CN 主力資金流 pre-loaded: ${institutionalMap.size} 支`);
        }
      } catch (err) {
        console.warn('[ScanSOP] CN 主力資金流載入失敗:', err instanceof Error ? err.message : err);
      }
    }

    // 粗掃：L2 健康時，先把沒報價的股票 drop
    const stocksAfterPrefilter = this.prefilterByL2(stocks, 'scanSOP');
    diag.totalStocks = stocksAfterPrefilter.length;

    for (let i = 0; i < stocksAfterPrefilter.length; i += CONCURRENCY) {
      const batch = stocksAfterPrefilter.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(({ symbol, name, industry }) =>
          this.scanOne(symbol, name, config, minScore, th, asOfDate, industry, diag, institutionalMap)
        )
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) candidates.push(r.value);
      }
      diag.processedCount += batch.length;
      if (i + CONCURRENCY < stocksAfterPrefilter.length) await sleep(BATCH_DELAY_MS);
    }

    // 計算覆蓋率
    const usable = diag.totalStocks - diag.dataMissing;
    diag.coverageRate = diag.totalStocks > 0 ? Math.round(usable / diag.totalStocks * 100) : 100;
    diag.dataStatus = diag.coverageRate >= 95 ? 'complete' : diag.coverageRate >= 70 ? 'partial' : 'insufficient';

    const sorted = this.rankCandidates(candidates, rankBy);

    // 聚合 dataFreshness 摘要
    const freshnessItems = sorted.filter(r => r.dataFreshness);
    const sessionFreshness = {
      avgStaleDays: freshnessItems.length > 0
        ? +(freshnessItems.reduce((s, r) => s + (r.dataFreshness?.daysStale ?? 0), 0) / freshnessItems.length).toFixed(1)
        : 0,
      maxStaleDays: Math.max(0, ...freshnessItems.map(r => r.dataFreshness?.daysStale ?? 0)),
      staleCount: freshnessItems.filter(r => (r.dataFreshness?.daysStale ?? 0) > 0).length,
      totalScanned: diag.totalStocks,
      coverageRate: diag.coverageRate,
      dataStatus: diag.dataStatus,
    };

    console.info('[ScanSOP Diagnostics]', JSON.stringify(diag));
    if (sessionFreshness.staleCount > 0) {
      console.warn(`[ScanSOP Freshness] ${sessionFreshness.staleCount} 支股票使用過期數據（最大落後 ${sessionFreshness.maxStaleDays} 天）`);
    }

    // ── 寫 Step 1 池子 cache（書本五步法 Step 1 → Step 2 銜接）──
    // sorted 是過「六條件 + 戒律 + 淘汰法」的合格池
    // 多頭軌 8 個 detector（B/C/E/J/K/L/M/P）讀這個 cache 當候選
    // 反轉軌 + 戰法軌 不過 Step 1，全市場掃（不用此 cache）
    // 概念：今日的池子今日用，明天會重新算
    const poolDate = asOfDate
      ?? new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
    try {
      const { saveStep1Pool } = await import('./step1Pool');
      await saveStep1Pool({
        market: config.marketId,
        date: poolDate,
        symbols: sorted.map(r => r.symbol),
        generatedAt: new Date().toISOString(),
        stats: {
          total: stocks.length,
          passSixCond: sorted.length,
          passProhib: sorted.length,
          passElim: sorted.length,
        },
      });
      console.info(`[ScanSOP] step1-pool 寫入：${config.marketId} ${poolDate} ${sorted.length} 支`);
    } catch (err) {
      console.warn('[ScanSOP] saveStep1Pool failed (non-critical):', err);
    }

    return {
      results: sorted,
      marketTrend,
      diagnostics: diag,
      sessionFreshness,
    };
  }

  private async _scanChunk(
    stocks: StockEntry[],
    asOfDate: string | undefined,
    thresholds?: StrategyThresholds,
  ): Promise<{ results: StockScanResult[]; marketTrend: TrendState; diagnostics: ScanDiagnostics }> {
    // P1A: 移除 ensureFreshCandles（避免批次下載打爆 API 配額）

    const config = this.getMarketConfig();
    const th = thresholds ?? BASE_THRESHOLDS;
    const results: StockScanResult[] = [];
    const DEADLINE = Date.now() + 110_000;
    const diag = createEmptyDiagnostics();
    diag.totalStocks = stocks.length;

    let minScore = th.minScore;
    let marketTrend: TrendState = '多頭';
    try {
      // raw trend 給 session/UI 顯示，scan regime（含降級）給 minScore
      marketTrend = await this.getMarketTrend(asOfDate);
      if (th.marketTrendFilter) {
        const regime = await this.getMarketScanRegime(asOfDate);
        minScore = this.marketTrendToMinScore(regime, th);
      }
    } catch { /* fallback */ }

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      if (Date.now() > DEADLINE) break;
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(({ symbol, name, industry }) => this.scanOne(symbol, name, config, minScore, th, asOfDate, industry, diag))
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      }
      diag.processedCount += batch.length;
      if (i + CONCURRENCY < stocks.length) await sleep(BATCH_DELAY_MS);
    }

    const sortedResults = results
      .sort((a, b) =>
        (b.sixConditionsScore ?? 0) - (a.sixConditionsScore ?? 0) ||
        b.changePercent - a.changePercent
      );

    console.info('[ScannerCache]', getScannerCacheStats());
    console.info('[ScanDiagnostics]', JSON.stringify(diag));
    return { results: sortedResults, marketTrend, diagnostics: diag };
  }

  async scan(thresholds?: StrategyThresholds): Promise<{ results: StockScanResult[]; partial: boolean; marketTrend?: TrendState }> {
    const config = this.getMarketConfig();
    const th = thresholds ?? BASE_THRESHOLDS;
    const stocks = await this.getStockList();

    // P1A: 移除 ensureFreshCandles（避免批次下載打爆 API 配額）

    const results: StockScanResult[] = [];
    const DEADLINE = Date.now() + 240_000;

    let minScore = th.minScore;
    let marketTrend: TrendState = '多頭';
    try {
      marketTrend = await this.getMarketTrend();
      if (th.marketTrendFilter) {
        minScore = this.marketTrendToMinScore(marketTrend, th);
      }
    } catch { /* fallback */ }

    for (let i = 0; i < stocks.length; i += CONCURRENCY) {
      if (Date.now() > DEADLINE) {
        const sorted = results.sort((a, b) =>
          (b.sixConditionsScore ?? 0) - (a.sixConditionsScore ?? 0) ||
          b.changePercent - a.changePercent
        );
        return { results: sorted, partial: true, marketTrend };
      }
      const batch = stocks.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        batch.map(({ symbol, name, industry }) => this.scanOne(symbol, name, config, minScore, th, undefined, industry))
      );
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      }
      if (i + CONCURRENCY < stocks.length) await sleep(BATCH_DELAY_MS);
    }

    const sorted = results.sort((a, b) =>
      (b.sixConditionsScore ?? 0) - (a.sixConditionsScore ?? 0) ||
      b.changePercent - a.changePercent
    );

    return {
      results: sorted,
      partial: false,
      marketTrend,
    };
  }

  /**
   * 獨立買法掃描（不過 A 六條件）
   * 全市場依 B/C/D/E/F/G/H/I 偵測器各自篩選，與 scanSOP 完全並列
   *
   * 字母對照：
   *   B=回後買上漲、C=盤整突破、D=一字底、E=缺口、F=V形反轉
   *   G=ABC 突破（寶典 Part 11-1 位置 6，2026-05-04 新增）
   *   H=突破大量黑 K（寶典 Part 11-1 位置 8，2026-05-04 新增）
   *   I=K 線橫盤突破（寶典 Part 11-1 位置 3，2026-05-04 新增）
   */
  async scanBuyMethod(
    method:
      | 'B' | 'C' | 'D' | 'E' | 'F'
      | 'G' | 'H' | 'I'   // v11 字母（v12 釋出但歷史 record 兼容）
      | 'J' | 'K' | 'L'   // v12 新字母（J=ABC（=v11 G）、K=K線橫盤（=v11 I）、L=過大量黑K（=v11 H））
      | 'M' | 'N' | 'O' | 'P' | 'Q',  // v12 新訊號
    stocks: StockEntry[],
    asOfDate?: string,
  ): Promise<StockScanResult[]> {
    const config = this.getMarketConfig();
    const results: StockScanResult[] = [];

    // ══════════════════════════════════════════════════════════════
    // 軌道分類 — 決定要不要過 Step 1 池子 + 戒律檢查（書本對應）
    // ══════════════════════════════════════════════════════════════
    // 多頭軌（B/C/E/J/K/L/M/P 8 個書本進場位置）：
    //   → 必須先過 Step 1（六條件+戒律+淘汰法）才能進場
    //   → 從今日 Step 1 池子挑候選，不全市場掃
    // 反轉軌（D/F/N/O 抓底/反轉）：
    //   → 不過 Step 1（過了就抓不到底部反轉）
    //   → 全市場掃描
    // 戰法軌 Q（朱老師三均線）：
    //   → 不過 Step 1（自含 MA24 趨勢判定）
    //   → 但仍過戒律（書本 p.262 沒說可以無視戒律）
    //   → 全市場掃描
    const BULLISH_TRACK = new Set(['B', 'C', 'E', 'J', 'K', 'L', 'M', 'P']);
    const SYSTEM_TRACK = new Set(['Q']);
    // REVERSAL_TRACK = D/F/N/O — 不過 Step 1 + 不過戒律（隱含：fall-through to default behavior）
    const isBullish = BULLISH_TRACK.has(method);
    const isSystem = SYSTEM_TRACK.has(method);

    // 多頭軌：拿今日 Step 1 池子當候選
    let step1Symbols: Set<string> | null = null;
    if (isBullish) {
      const poolDate = asOfDate
        ?? new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
      const { getStep1Symbols } = await import('./step1Pool');
      step1Symbols = await getStep1Symbols(config.marketId, poolDate);
      if (!step1Symbols) {
        console.warn(`[scanBuyMethod] ${method} ${config.marketId} ${poolDate} Step 1 池子未準備好 — 多頭軌應等 A 預選池跑完再啟動。本輪結果將為空。`);
        return [];  // Step 1 池子不存在 → 多頭軌空結果（保守，避免回退到全市場掃繞過 gate）
      }
    }

    let candidates = this.prefilterByL2(stocks, `scanBuyMethod-${method}`);
    // 多頭軌：從候選中再篩出在 Step 1 池子內的
    if (isBullish && step1Symbols) {
      candidates = candidates.filter(s => step1Symbols!.has(s.symbol));
    }

    for (let i = 0; i < candidates.length; i += CONCURRENCY) {
      const batch = candidates.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(batch.map(async ({ symbol, name, industry }) => {
        try {
          const fetchResult = await this.fetchCandlesForScan(symbol, asOfDate);
          if (!fetchResult || fetchResult.candles.length < 30) return null;
          if (asOfDate && fetchResult.lastCandleDate !== asOfDate) {
            const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date());
            if (asOfDate === today) return null;
          }
          const candles = fetchResult.candles;
          const lastIdx = candles.length - 1;
          const last = candles[lastIdx];

          let matched = false;
          let detail = '';
          let subType: string | undefined;
          // v12 議題 23/65/93：F/N 觸發時填寫，供 scan-bm cron 寫入 LockWatch
          let lockWatchPayload: StockScanResult['lockWatchPayload'];
          // v12 議題 75：K/D 型態訊號的 provisional 三天驗證 state
          let provisional: StockScanResult['provisional'];

          if (method === 'B') {
            // B=回後買上漲
            const { detectBreakoutEntry } = await import('@/lib/analysis/breakoutEntry');
            const r = detectBreakoutEntry(candles, lastIdx);
            if (r?.isBreakout) { matched = true; detail = r.detail; subType = r.subType; }
          } else if (method === 'C') {
            // C=盤整突破
            const { detectConsolidationBreakout } = await import('@/lib/analysis/breakoutEntry');
            const r = detectConsolidationBreakout(candles, lastIdx);
            if (r?.isBreakout) { matched = true; detail = r.detail; subType = r.subType; }
          } else if (method === 'D') {
            // D=一字底
            const { detectStrategyE } = await import('@/lib/analysis/highWinRateEntry');
            const r = detectStrategyE(candles, lastIdx);
            if (r?.isFlatBottom) {
              matched = true;
              detail = r.detail;
              // v12 議題 75：D 型態訊號 provisional 三天驗證
              const { createProvisional } = await import('@/lib/scanner/provisionalManager');
              provisional = createProvisional({
                triggerPrice: last.close,
                triggeredDate: asOfDate ?? last.date,
              });
            }
          } else if (method === 'E') {
            // E=缺口進場
            const { detectStrategyD } = await import('@/lib/analysis/gapEntry');
            const r = detectStrategyD(candles, lastIdx);
            if (r?.isGapEntry) { matched = true; detail = r.detail; }
          } else if (method === 'F') {
            // F=V形反轉
            const { detectVReversal } = await import('@/lib/analysis/vReversalDetector');
            const r = detectVReversal(candles, lastIdx);
            if (r?.isVReversal) {
              matched = true;
              detail = r.detail;
              // v12 議題 23：F 反彈起點 close 鎖定為 LockWatch triggerPrice，
              // vBottom = 變盤線 low（實際 V 底，結構失效判定用）
              lockWatchPayload = { triggerPrice: last.close, vBottom: r.stopBarLow };
            }
          } else if (method === 'G') {
            // G=ABC 突破（寶典 Part 11-1 位置 6，2026-05-04 新增）
            const { detectABCBreakout } = await import('@/lib/analysis/abcBreakoutEntry');
            const r = detectABCBreakout(candles, lastIdx);
            if (r?.isABCBreakout) { matched = true; detail = r.detail; }
          } else if (method === 'H') {
            // H=突破大量黑 K（寶典 Part 11-1 位置 8，2026-05-04 新增）
            const { detectBlackKBreakout } = await import('@/lib/analysis/blackKBreakoutEntry');
            const r = detectBlackKBreakout(candles, lastIdx);
            if (r?.isBlackKBreakout) { matched = true; detail = r.detail; }
          } else if (method === 'I') {
            // I=K 線橫盤突破（寶典 Part 11-1 位置 3，2026-05-04 新增）
            const { detectKlineConsolidationBreakout } = await import('@/lib/analysis/klineConsolidationBreakout');
            const r = detectKlineConsolidationBreakout(candles, lastIdx);
            if (r?.isBreakout) { matched = true; detail = r.detail; }
          }
          // ── v12 新字母（v12 規格 1.4A 字母 mapping，2026-05-09 新增）─────
          else if (method === 'J') {
            // J=ABC 突破（v12 = v11 G 改字母；寶典 Part 11-1 位置 6）
            const { detectABCBreakout } = await import('@/lib/analysis/abcBreakoutEntry');
            const r = detectABCBreakout(candles, lastIdx);
            if (r?.isABCBreakout) { matched = true; detail = `J ${r.detail}`; }
          } else if (method === 'K') {
            // K=K 線橫盤突破（v12 = v11 I 改字母；寶典 Part 11-1 位置 5）
            const { detectKlineConsolidationBreakout } = await import('@/lib/analysis/klineConsolidationBreakout');
            const r = detectKlineConsolidationBreakout(candles, lastIdx);
            if (r?.isBreakout) {
              matched = true;
              detail = `K ${r.detail}`;
              // v12 議題 75：K 型態訊號 provisional 三天驗證
              const { createProvisional } = await import('@/lib/scanner/provisionalManager');
              provisional = createProvisional({
                triggerPrice: last.close,
                triggeredDate: asOfDate ?? last.date,
              });
            }
          } else if (method === 'L') {
            // L=過大量黑 K 高（v12 = v11 H 改字母；寶典 Part 11-1 位置 8）
            const { detectBlackKBreakout } = await import('@/lib/analysis/blackKBreakoutEntry');
            const r = detectBlackKBreakout(candles, lastIdx);
            if (r?.isBlackKBreakout) { matched = true; detail = `L ${r.detail}`; }
          } else if (method === 'M') {
            // M=突破軌道線（v12 新增；寶典 p.387 上升軌道線）
            const { detectLetterM } = await import('@/lib/analysis/v12LetterM');
            const r = detectLetterM(candles, lastIdx, config.marketId, symbol);
            if (r.triggered) { matched = true; detail = r.detail; }
          } else if (method === 'N') {
            // N=型態確認（v12 新增；8 種底部型態）
            // 2026-05-10 Phase C：擴大 LockWatch 寫入條件 — 結構成立但未過 ×3% 真突破也寫入（pending-breakout stage）
            const { detectLetterN, detectLetterNStructure } = await import('@/lib/analysis/v12LetterN');
            const r = detectLetterN(candles, lastIdx, config.marketId, symbol);
            if (r.triggered) {
              matched = true;
              detail = r.detail;
              // v12 議題 65：N 頸線價、型態類型、目標價、達成率全寫入 LockWatch
              if (r.necklinePrice != null && r.patternType) {
                lockWatchPayload = {
                  triggerPrice: r.necklinePrice,
                  patternType: r.patternType,
                  patternTargetPrice: r.patternTargetPrice,
                  patternAchievementRate:
                    typeof r.achievementRate === 'number' ? r.achievementRate / 100 : undefined,
                };
              }
            } else {
              // Phase C：未觸發但結構成立（close 未過 ×3%）→ 寫 LockWatch pending-breakout
              const struct = detectLetterNStructure(candles, lastIdx);
              if (struct.pivots && struct.pivots.length > 0
                  && struct.necklinePrice != null && struct.patternType) {
                lockWatchPayload = {
                  triggerPrice: struct.necklinePrice,
                  patternType: struct.patternType,
                  patternTargetPrice: struct.patternTargetPrice,
                  patternAchievementRate:
                    typeof struct.achievementRate === 'number' ? struct.achievementRate / 100 : undefined,
                };
                // matched 仍為 false — r 將以 lockWatchOnly 身分通過 filter，不污染 ScanSession
              }
            }
          } else if (method === 'O') {
            // O=打底完成（v12 新增；寶典 Part 11-1 位置 1）
            const { detectLetterO } = await import('@/lib/analysis/v12LetterO');
            const r = detectLetterO(candles, lastIdx, config.marketId, symbol);
            if (r.triggered) { matched = true; detail = r.detail; }
          } else if (method === 'P') {
            // P=高檔拉回（v12 新增；寶典 Part 11-1 位置 3 等拉回）
            const { detectLetterP } = await import('@/lib/analysis/v12LetterP');
            const r = detectLetterP(candles, lastIdx, config.marketId, symbol);
            if (r.triggered) { matched = true; detail = r.detail; }
          } else if (method === 'Q') {
            // Q=三條均線戰法（v12 戰法軌獨立；抓線圖 第 4 篇 第 8 章 MA3+10+24）
            const { detectLetterQ } = await import('@/lib/analysis/v12LetterQ');
            const r = detectLetterQ(candles, lastIdx, config.marketId, symbol);
            if (r.triggered) { matched = true; detail = r.detail; }
          }

          // Phase C：matched=false 但 lockWatchPayload!=null（pending-breakout 結構成立）也要 return r，
          // 由下方流程帶 lockWatchPayload 給 cron 寫入 LockWatch。matchedMethods 為空，不污染 ScanSession。
          if (!matched && !lockWatchPayload) return null;

          // ── 戰法軌 Q：套戒律檢查（書本 p.262 沒說可以無視戒律）──────
          // 反轉軌（D/F/N/O）不套戒律，因為戒律 5/8（未站上月線/空頭反彈）會誤
          // 擋掉所有抓底/反轉訊號。書本本意這 4 個就是要在底部抓。
          if (isSystem && matched) {
            const { checkLongProhibitions } = await import('@/lib/rules/entryProhibitions');
            const prohib = checkLongProhibitions(candles, lastIdx);
            if (prohib.prohibited) return null;
          }

          const prev = candles[lastIdx - 1];
          const changePercent = prev?.close > 0
            ? +((last.close - prev.close) / prev.close * 100).toFixed(2)
            : 0;

          const trendState = detectTrend(candles, lastIdx);
          const trendPosition = detectTrendPosition(candles, lastIdx);

          const mtfResult = evaluateMultiTimeframe(candles, BASE_THRESHOLDS);

          // 跨策略命中：A 六條件 + 其他 7 個 detector（B/C/D/E/F/G/H/I 排除 self）
          // 同時計算 sixConditionsScore + breakdown 供 UI 顯示（不用於 gate；反轉軌不過六條件，
          // 但 UI 仍應呈現實際分數，否則 ScanResultsCompact / ScanCoachDigest 會永遠顯示 0/6）
          // Phase C：lockWatchOnly result（matched=false）matchedMethods 為空，不會出現在 ScanSession UI
          const matchedMethods: string[] = matched ? [method] : [];
          let sixCondsResult: ReturnType<typeof evaluateSixConditions> | null = null;
          try {
            const { evaluateSixConditions } = await import('@/lib/analysis/trendAnalysis');
            sixCondsResult = evaluateSixConditions(candles, lastIdx);
            if (sixCondsResult.isCoreReady) matchedMethods.push('A');
          } catch { /* non-critical */ }
          if (method !== 'B') {
            try {
              const { detectBreakoutEntry } = await import('@/lib/analysis/breakoutEntry');
              if (detectBreakoutEntry(candles, lastIdx)?.isBreakout) matchedMethods.push('B');
            } catch { /* */ }
          }
          if (method !== 'C') {
            try {
              const { detectConsolidationBreakout } = await import('@/lib/analysis/breakoutEntry');
              if (detectConsolidationBreakout(candles, lastIdx)?.isBreakout) matchedMethods.push('C');
            } catch { /* */ }
          }
          if (method !== 'D') {
            try {
              const { detectStrategyE } = await import('@/lib/analysis/highWinRateEntry');
              if (detectStrategyE(candles, lastIdx)?.isFlatBottom) matchedMethods.push('D');
            } catch { /* */ }
          }
          if (method !== 'E') {
            try {
              const { detectStrategyD } = await import('@/lib/analysis/gapEntry');
              if (detectStrategyD(candles, lastIdx)?.isGapEntry) matchedMethods.push('E');
            } catch { /* */ }
          }
          if (method !== 'F') {
            try {
              const { detectVReversal } = await import('@/lib/analysis/vReversalDetector');
              if (detectVReversal(candles, lastIdx)?.isVReversal) matchedMethods.push('F');
            } catch { /* */ }
          }
          if (method !== 'G') {
            try {
              const { detectABCBreakout } = await import('@/lib/analysis/abcBreakoutEntry');
              if (detectABCBreakout(candles, lastIdx)?.isABCBreakout) matchedMethods.push('G');
            } catch { /* */ }
          }
          if (method !== 'H') {
            try {
              const { detectBlackKBreakout } = await import('@/lib/analysis/blackKBreakoutEntry');
              if (detectBlackKBreakout(candles, lastIdx)?.isBlackKBreakout) matchedMethods.push('H');
            } catch { /* */ }
          }
          if (method !== 'I') {
            try {
              const { detectKlineConsolidationBreakout } = await import('@/lib/analysis/klineConsolidationBreakout');
              if (detectKlineConsolidationBreakout(candles, lastIdx)?.isBreakout) matchedMethods.push('I');
            } catch { /* */ }
          }
          // v12 新字母 J-Q 跨策略命中（議題 65/93/33）
          // J=ABC alias of G、K=橫盤 alias of I、L=黑K alias of H — 跳過避免重複
          if (method !== 'M') {
            try {
              const { detectLetterM } = await import('@/lib/analysis/v12LetterM');
              if (detectLetterM(candles, lastIdx, config.marketId, symbol).triggered) matchedMethods.push('M');
            } catch { /* */ }
          }
          if (method !== 'N') {
            try {
              const { detectLetterN } = await import('@/lib/analysis/v12LetterN');
              if (detectLetterN(candles, lastIdx, config.marketId, symbol).triggered) matchedMethods.push('N');
            } catch { /* */ }
          }
          if (method !== 'O') {
            try {
              const { detectLetterO } = await import('@/lib/analysis/v12LetterO');
              if (detectLetterO(candles, lastIdx, config.marketId, symbol).triggered) matchedMethods.push('O');
            } catch { /* */ }
          }
          if (method !== 'P') {
            try {
              const { detectLetterP } = await import('@/lib/analysis/v12LetterP');
              if (detectLetterP(candles, lastIdx, config.marketId, symbol).triggered) matchedMethods.push('P');
            } catch { /* */ }
          }
          if (method !== 'Q') {
            try {
              const { detectLetterQ } = await import('@/lib/analysis/v12LetterQ');
              if (detectLetterQ(candles, lastIdx, config.marketId, symbol).triggered) matchedMethods.push('Q');
            } catch { /* */ }
          }
          const sortedMatched = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'].filter(m => matchedMethods.includes(m));

          return {
            symbol,
            name,
            market: config.marketId,
            industry,
            price: last.close,
            changePercent,
            volume: last.volume,
            triggeredRules: [{ ruleId: `buy-method-${method.toLowerCase()}`, ruleName: detail, signalType: 'BUY' as const, reason: detail }],
            matchedMethods: sortedMatched,
            buyMethodSubType: subType,
            sixConditionsScore: sixCondsResult?.totalScore ?? 0,
            sixConditionsBreakdown: sixCondsResult ? {
              trend:     sixCondsResult.trend.pass,
              position:  sixCondsResult.position.pass,
              kbar:      sixCondsResult.kbar.pass,
              ma:        sixCondsResult.ma.pass,
              volume:    sixCondsResult.volume.pass,
              indicator: sixCondsResult.indicator.pass,
            } : { trend: false, position: false, kbar: false, ma: false, volume: false, indicator: false },
            trendState,
            trendPosition,
            scanTime: asOfDate ? `${asOfDate}T00:00:00.000Z` : new Date().toISOString(),
            mtfScore: mtfResult.totalScore,
            mtfWeeklyPass: mtfResult.weekly.pass,
            mtfWeeklyTrend: mtfResult.weekly.trend,
            mtfWeeklyDetail: mtfResult.weekly.detail,
            mtfMonthlyPass: mtfResult.monthly.pass,
            mtfMonthlyDetail: mtfResult.monthly.detail,
            lockWatchPayload,
            provisional,
            dataFreshness: {
              lastCandleDate: fetchResult.lastCandleDate,
              daysStale: fetchResult.staleDays,
              source: fetchResult.source,
            },
          } satisfies StockScanResult;
        } catch {
          return null;
        }
      }));
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) results.push(r.value);
      }
      if (i + CONCURRENCY < candidates.length) await sleep(BATCH_DELAY_MS);
    }

    return results.sort((a, b) => b.changePercent - a.changePercent);
  }
}
