/**
 * letterSOP 單一事實表 unit test — 0513 建立
 *
 * 14 字母（v12: A B C D E F J K L M N O P Q + v11 alias G/H/I）
 * 每個字母都驗：
 * - sopFor 不丟錯
 * - 必有 name / bookRef / operatingMA / stopHint / takeProfitHint
 * - inapplicableSellSignals 是 Set
 * - enhancedDiscipline 是 boolean
 *
 * 也驗一致性：
 * - sopFor('G') 等同 sopFor('J')（v11 alias）
 * - operatingMA / inapplicableSellSignals 之間語意一致（守 MA5 的字母不該過濾 BREAK_MA5）
 */

import { describe, it, expect } from '@jest/globals';
import { LETTER_SOP, sopFor } from '../lib/portfolio/letterSOP';
import { SIGNAL_TO_TRAILING_MA } from '../lib/sell/v12StopLoss';
import { getOperationMA } from '../lib/sell/v12Operation';
import { LETTER_NAMES } from '../lib/scanner/buyMethodTracks';

const V12_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q'] as const;
const V11_ALIAS = { G: 'J', H: 'L', I: 'K' } as const;

describe('letterSOP', () => {
  describe('14 字母完整性', () => {
    it.each(V12_LETTERS)('字母 %s 必有完整 SOP', (letter) => {
      const sop = sopFor(letter);
      expect(sop).toBeDefined();
      expect(sop.name).toBeTruthy();
      expect(sop.bookRef).toBeTruthy();
      expect(['MA3', 'MA5', 'MA10', 'MA20', 'MA60']).toContain(sop.operatingMA);
      expect(sop.stopHint).toBeTruthy();
      expect(sop.takeProfitHint).toBeTruthy();
      expect(typeof sop.enhancedDiscipline).toBe('boolean');
      expect(sop.inapplicableSellSignals).toBeInstanceOf(Set);
    });
  });

  describe('v11 字母 alias 對應 v12', () => {
    it.each(Object.entries(V11_ALIAS))('%s → %s (sopFor 一致)', (v11, v12) => {
      const sopV11 = sopFor(v11);
      const sopV12 = LETTER_SOP[v12 as keyof typeof LETTER_SOP];
      expect(sopV11).toBe(sopV12);
    });
  });

  describe('進階紀律字母（書本對齊）', () => {
    it('只有 B/P 兩字母 enhancedDiscipline=true（寶典 #5/#6）', () => {
      const enabled = V12_LETTERS.filter((l) => sopFor(l).enhancedDiscipline);
      expect(enabled.sort()).toEqual(['B', 'P']);
    });
  });

  describe('inapplicableSellSignals 跟 operatingMA 語意一致', () => {
    // 強約束：守 MA5 的字母（B/P）BREAK_MA5 一定要納入 verdict，不可過濾
    it.each(V12_LETTERS)('%s：守 MA5 的字母不可過濾 BREAK_MA5（B/P 強約束）', (letter) => {
      const sop = sopFor(letter);
      if (sop.operatingMA === 'MA5') {
        expect(sop.inapplicableSellSignals.has('BREAK_MA5')).toBe(false);
      }
    });

    // BREAK_MA20 永遠是大警訊（多頭保護線），任何字母都不該過濾
    it.each(V12_LETTERS)('%s：BREAK_MA20 永遠不可過濾（多頭保護線）', (letter) => {
      const sop = sopFor(letter);
      expect(sop.inapplicableSellSignals.has('BREAK_MA20')).toBe(false);
    });

    // TREND_BEARISH 也永遠保留 — 趨勢翻空對所有字母都是出場訊號
    it.each(V12_LETTERS)('%s：TREND_BEARISH 永遠不可過濾', (letter) => {
      const sop = sopFor(letter);
      expect(sop.inapplicableSellSignals.has('TREND_BEARISH')).toBe(false);
    });
  });

  describe('特定字母書本對齊', () => {
    it('N 型態確認：守頸線 + 跟 MA10、過濾 BREAK_MA5/MA10', () => {
      const sop = sopFor('N');
      expect(sop.name).toBe('型態確認');
      expect(sop.operatingMA).toBe('MA10');
      expect(sop.stopHint).toContain('頸線');
      expect(sop.takeProfitHint).toContain('目標');
      expect(sop.inapplicableSellSignals.has('BREAK_MA5')).toBe(true);
      expect(sop.inapplicableSellSignals.has('BREAK_MA10')).toBe(true);
    });

    it('F V 反轉：跟 MA3、過濾 BREAK_MA5/MA10', () => {
      const sop = sopFor('F');
      expect(sop.name).toBe('V 型反轉');
      expect(sop.operatingMA).toBe('MA3');
      expect(sop.stopHint).toContain('V 底');
      expect(sop.inapplicableSellSignals.has('BREAK_MA5')).toBe(true);
      expect(sop.inapplicableSellSignals.has('BREAK_MA10')).toBe(true);
    });

    it('Q 三條均線戰法：跟 MA10、過濾 BREAK_MA5', () => {
      const sop = sopFor('Q');
      expect(sop.operatingMA).toBe('MA10');
      expect(sop.stopHint).toContain('MA10');
      expect(sop.inapplicableSellSignals.has('BREAK_MA5')).toBe(true);
      expect(sop.inapplicableSellSignals.has('BREAK_MA10')).toBe(false);  // MA10 是操作均線、不可過濾
    });

    it('B 回後買上漲：跟 MA5、enhancedDiscipline=true', () => {
      const sop = sopFor('B');
      expect(sop.name).toBe('回後買上漲');
      expect(sop.operatingMA).toBe('MA5');
      expect(sop.enhancedDiscipline).toBe(true);
    });

    it('P 高檔拉回：跟 MA5、enhancedDiscipline=true', () => {
      const sop = sopFor('P');
      expect(sop.operatingMA).toBe('MA5');
      expect(sop.enhancedDiscipline).toBe(true);
    });

    it('D 一字底 / O 打底完成：跟 MA20、過濾 BREAK_MA5/MA10', () => {
      for (const letter of ['D', 'O']) {
        const sop = sopFor(letter);
        expect(sop.operatingMA).toBe('MA20');
        expect(sop.inapplicableSellSignals.has('BREAK_MA5')).toBe(true);
        expect(sop.inapplicableSellSignals.has('BREAK_MA10')).toBe(true);
      }
    });
  });

  /**
   * 0513 ABCDE C3：cross-source consistency
   * letterSOP 跟 v12StopLoss / v12Operation / LETTER_NAMES 三處字母 map 必須對齊。
   * 改 letterSOP 但忘改另一處（或反過來）會在這裡 fail，不會等用戶 UI 看到才發現。
   */
  describe('cross-source 一致性（C3 鎖死）', () => {
    it.each(V12_LETTERS)('%s: letterSOP.operatingMA 必須等於 SIGNAL_TO_TRAILING_MA[letter]', (letter) => {
      const sop = sopFor(letter);
      const v12Stop = SIGNAL_TO_TRAILING_MA[letter as keyof typeof SIGNAL_TO_TRAILING_MA];
      expect(sop.operatingMA).toBe(v12Stop);
    });

    it.each(V12_LETTERS)('%s: letterSOP.operatingMA 必須等於 getOperationMA(letter, "short")', (letter) => {
      const sop = sopFor(letter);
      const opMA = getOperationMA(letter as Parameters<typeof getOperationMA>[0], 'short');
      expect(sop.operatingMA).toBe(opMA);
    });

    it.each(V12_LETTERS)('%s: letterSOP.name 必須等於 LETTER_NAMES[letter]', (letter) => {
      const sop = sopFor(letter);
      expect(sop.name).toBe(LETTER_NAMES[letter]);
    });
  });

  describe('sopFor 邊界 case', () => {
    it('未知字母 fallback 到 B', () => {
      const sop = sopFor('Z');
      expect(sop).toBe(LETTER_SOP.B);
    });

    it('空字串 fallback 到 B', () => {
      const sop = sopFor('');
      expect(sop).toBe(LETTER_SOP.B);
    });
  });
});
