/**
 * 0513 ABCDE B4 — LockWatch panel + 進場 → /portfolio prefill 鏈路防回歸
 *
 * 對齊用戶最初 4 大問題之一：「型態確認 panel 設計搞不懂」+「持倉訊號面板問題」。
 * 鎖死 F/N 訊號紀錄 rename + 進場按鈕帶 4 欄入 portfolio form 整條鏈路。
 */

import { test, expect } from '@playwright/test';

test.describe('LockWatch → /portfolio prefill 鏈路', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      try {
        localStorage.setItem('risk-disclaimer-accepted', '1');
        localStorage.setItem('feature-guide-seen', '1');
      } catch {}
    });
  });


  test('掃描頁有 F/N 訊號紀錄 panel + 進場按鈕（lockwatch promoted）', async ({ page }) => {
    await page.goto('/?load=4967.TW');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // panel 標題已 rename
    await expect(page.getByText('F/N 訊號紀錄').first()).toBeVisible();

    // 進場按鈕在 panel 內，先確認 panel 展開（store persist 可能 collapsed）
    const headerBtn = page.locator('button').filter({ hasText: 'F/N 訊號紀錄' }).first();
    const entryBtns = page.locator('button:text-is("進場")');
    if ((await entryBtns.count()) === 0) {
      await headerBtn.click();
      await page.waitForTimeout(800);
    }
    expect(await entryBtns.count()).toBeGreaterThan(0);
  });

  test('點進場按鈕 → /portfolio 自動填入 symbol/cost/triggerSignal', async ({ page }) => {
    await page.goto('/?load=4967.TW');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);

    // 用 locator 等進場按鈕；展開狀態因 store persist 可能跨 session 變動 — 一律保險展開
    const headerBtn = page.locator('button').filter({ hasText: 'F/N 訊號紀錄' }).first();
    const entryBtns = page.locator('button:text-is("進場")');
    if ((await entryBtns.count()) === 0) {
      await headerBtn.click();
      await page.waitForTimeout(800);
    }

    expect(await entryBtns.count()).toBeGreaterThan(0);

    // 點第一個進場按鈕，title 應含 N or F + 觸發價
    const firstBtn = entryBtns.first();
    const title = await firstBtn.getAttribute('title');
    expect(title).toMatch(/進場.*[NF].*觸發價/);

    await firstBtn.click();
    await page.waitForURL(/\/portfolio/, { timeout: 5000 });

    // form 應已填 symbol（非空）+ cost（非空）+ triggerSignal（N or F）
    const symbolInput = page.locator('input[placeholder*="2330"]').first();
    const costInput = page.locator('input[placeholder*="150"]').first();
    const triggerSelect = page.locator('select').first();

    await expect(symbolInput).not.toHaveValue('');
    await expect(costInput).not.toHaveValue('');
    const triggerVal = await triggerSelect.inputValue();
    expect(['N', 'F']).toContain(triggerVal);
  });
});
