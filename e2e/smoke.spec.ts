/**
 * E2E Smoke Tests — 基本頁面載入與 API 健康度
 *
 * 前置：npm install -D @playwright/test && npx playwright install chromium
 * 執行：npm run test:e2e
 */
import { test, expect } from '@playwright/test';

test.describe('Smoke Tests', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      try {
        localStorage.setItem('risk-disclaimer-accepted', '1');
        localStorage.setItem('feature-guide-seen', '1');
      } catch {}
    });
  });

  test('首頁載入成功', async ({ page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).toBeVisible();
  });

  test('掃描功能在首頁顯示', async ({ page }) => {
    // rockstock 把掃描嵌在 /，不是獨立 /scan 頁
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    // 掃描 panel 或「掃描」chip/按鈕應出現
    await expect(page.locator('text=/掃描|Step 1/').first()).toBeVisible({ timeout: 10_000 });
  });

  test('持倉頁載入', async ({ page }) => {
    await page.goto('/portfolio');
    await page.waitForLoadState('domcontentloaded');
    await expect(page.locator('body')).toBeVisible();
  });

  test('API health check — stock endpoint', async ({ request }) => {
    const res = await request.get('/api/stock?symbol=2330.TW&interval=1d&period=5d');
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.candles).toBeDefined();
    expect(Array.isArray(json.candles)).toBe(true);
  });

  test('API lockwatch 兩市場都有資料', async ({ request }) => {
    for (const market of ['TW', 'CN']) {
      const res = await request.get(`/api/lockwatch?market=${market}`);
      expect(res.status()).toBe(200);
      const json = await res.json();
      expect(json.snapshot?.records?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
