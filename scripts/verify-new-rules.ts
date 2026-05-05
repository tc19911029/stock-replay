/**
 * 驗證腳本：確認 granville/bollinger 註冊 + winnerPatterns 啟用
 * 用法：npx tsx scripts/verify-new-rules.ts
 */

import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();

import { ruleEngine } from '../lib/rules/ruleEngine';
import { DEFAULT_REGISTRY } from '../lib/rules/ruleRegistry';
import { evaluateWinnerPatterns } from '../lib/rules/winnerPatternRules';
import { readCandleFile } from '../lib/datasource/CandleStorageAdapter';
import { computeIndicators } from '../lib/indicators';

const SAMPLE_SYMBOLS = [
  { symbol: '2330.TW', market: 'TW' as const },
  { symbol: '2454.TW', market: 'TW' as const },
  { symbol: '3138.TWO', market: 'TW' as const },
  { symbol: '600519.SS', market: 'CN' as const },
];

async function main() {
  console.log('═══ Step 1: RuleEngine 群組註冊狀態 ═══');
  const groups = DEFAULT_REGISTRY.getGroups();
  console.log(`註冊群組數：${groups.length}`);
  for (const g of groups) {
    console.log(`  ${g.id} (${g.author}) — ${g.rules.length} 條規則`);
  }

  console.log('\n═══ Step 2: 確認葛蘭碧 + 布林通道規則 ID ═══');
  const ruleMap = DEFAULT_REGISTRY.buildRuleToGroupMap();
  const granvileIds = ['granville-buy-1', 'granville-buy-2', 'granville-buy-3', 'granville-buy-4',
                       'granville-sell-5', 'granville-sell-6', 'granville-sell-7', 'granville-sell-8'];
  const bollIds = ['bollinger-squeeze-up', 'bollinger-squeeze-down'];
  for (const id of [...granvileIds, ...bollIds]) {
    const g = ruleMap.get(id);
    console.log(`  ${id}: ${g ? `✅ ${g.groupId}` : '❌ 未註冊'}`);
  }

  console.log('\n═══ Step 3: 樣本股 winnerPatterns + 葛蘭碧/布林觸發 ═══');
  for (const { symbol, market } of SAMPLE_SYMBOLS) {
    try {
      const file = await readCandleFile(symbol, market);
      if (!file || !file.candles || file.candles.length < 100) {
        console.log(`\n${symbol}：資料不足（${file?.candles?.length ?? 0} 根）`);
        continue;
      }
      const candles = computeIndicators(file.candles);
      const lastIdx = candles.length - 1;
      const last = candles[lastIdx];

      const winner = evaluateWinnerPatterns(candles, lastIdx);
      const signals = ruleEngine.evaluate(candles, lastIdx);

      const granvileHits = signals.filter(s => s.ruleId.startsWith('granville-'));
      const bollHits = signals.filter(s => s.ruleId.startsWith('boll-'));

      console.log(`\n${symbol} (${last.date}, close=${last.close}):`);
      console.log(`  總觸發規則: ${signals.length} 條`);
      console.log(`  葛蘭碧命中: ${granvileHits.length} 條 ${granvileHits.map(s => s.ruleId).join(', ')}`);
      console.log(`  布林命中:   ${bollHits.length} 條 ${bollHits.map(s => s.ruleId).join(', ')}`);
      console.log(`  贏家圖像（空轉多）: ${winner.bullishPatterns.length} ${winner.bullishPatterns.map(p => p.name).join('、') || '無'}`);
      console.log(`  贏家圖像（多轉空）: ${winner.bearishPatterns.length} ${winner.bearishPatterns.map(p => p.name).join('、') || '無'}`);
    } catch (err) {
      console.log(`\n${symbol}：錯誤 ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log('\n═══ 驗證完成 ═══');
}

main().catch(err => {
  console.error('腳本失敗:', err);
  process.exit(1);
});
