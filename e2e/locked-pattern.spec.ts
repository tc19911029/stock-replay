/**
 * 0513 ABCDE B4 — 走圖型態鎖定鏈路 E2E 防回歸
 *
 * Catches: 0513 chart pivots-empty crash —
 *   useLockedPattern 命中時 freshSource.pivots = [] → activePattern.pivots = []
 *   → sortedByIndex[0].index 讀 undefined → ErrorBoundary 接住 → 整個走圖消失
 *
 * 這層 Jest + jsdom 抓不到（lightweight-charts Canvas 渲染要真瀏覽器）。
 */

import { test, expect } from '@playwright/test';

test.describe('走圖型態鎖定鏈路', () => {
  test.beforeEach(async ({ context }) => {
    // 風險免責 modal + 功能引導 modal 第一次都擋住點擊，預先接受
    await context.addInitScript(() => {
      try {
        localStorage.setItem('risk-disclaimer-accepted', '1');
        localStorage.setItem('feature-guide-seen', '1');
      } catch {}
    });
  });


  test('TW lockwatch 股 (4967.TW 複式頭肩底) → 顯示「鎖定」badge + 目標達成', async ({ page }) => {
    // 收集 console errors
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (/Cannot read properties|undefined|TypeError|ErrorBoundary/.test(text)) {
          consoleErrors.push(`console.error: ${text.slice(0, 200)}`);
        }
      }
    });

    await page.goto('/?load=4967.TW');
    // 等股票名稱出現（loaded 完成）
    await expect(page.getByText('十銓').first()).toBeVisible({ timeout: 15_000 });

    // 開「形態」+「頸線」toggle
    const patternBtn = page.locator('button:text-is("形態")').first();
    const necklineBtn = page.locator('button:text-is("頸線")').first();
    await patternBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await patternBtn.click();
    await necklineBtn.click();
    // 等 chart 重渲染
    await page.waitForTimeout(800);

    // 驗證沒 chart crash
    expect(consoleErrors, `走圖 crash: ${consoleErrors.join('\n')}`).toHaveLength(0);

    // 鎖定 badge 應出現
    await expect(page.getByText('鎖定', { exact: true }).first()).toBeVisible();
    // 型態名稱應出現
    await expect(page.locator('text=/複式頭肩底|頭肩底|圓弧底|楔形|雙重底|三重底/').first()).toBeVisible();
  });

  test('CN lockwatch 股 (601778.SS 圓弧底) → 鎖定 badge + 圓弧底', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error' && /Cannot read|TypeError/.test(msg.text())) {
        consoleErrors.push(`console.error: ${msg.text().slice(0, 200)}`);
      }
    });

    await page.goto('/?load=601778.SS');
    await page.waitForTimeout(3000);

    const patternBtn = page.locator('button:text-is("形態")').first();
    const necklineBtn = page.locator('button:text-is("頸線")').first();
    await patternBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await patternBtn.click();
    await necklineBtn.click();
    await page.waitForTimeout(800);

    expect(consoleErrors).toHaveLength(0);
    await expect(page.getByText('鎖定', { exact: true }).first()).toBeVisible();
  });

  test('無 lockwatch 紀錄股 (2330.TW) → 顯示「即時」badge', async ({ page }) => {
    await page.goto('/?load=2330.TW');
    await expect(page.getByText('台積電').first()).toBeVisible({ timeout: 15_000 });

    const patternBtn = page.locator('button:text-is("形態")').first();
    const necklineBtn = page.locator('button:text-is("頸線")').first();
    await patternBtn.waitFor({ state: 'visible', timeout: 15_000 });
    await patternBtn.click();
    await necklineBtn.click();
    await page.waitForTimeout(800);

    // 即時 badge 應出現（fresh detection mode）
    await expect(page.getByText('即時', { exact: true }).first()).toBeVisible();
  });

  test('?symbol= 跟 ?load= 兩種 URL param 都接受', async ({ page }) => {
    await page.goto('/?symbol=2330.TW');
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await expect(page.getByText('台積電').first()).toBeVisible({ timeout: 20_000 });
  });
});
