/**
 * E2E Smoke Tests — 基本頁面載入與導航
 *
 * 前置：npm install -D @playwright/test && npx playwright install
 * 執行：npx playwright test
 */
import { test, expect } from '@playwright/test';

test.describe('Smoke Tests', () => {
  test('首頁載入成功', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/Stock/i);
  });

  test('掃描頁面載入', async ({ page }) => {
    await page.goto('/scan');
    // 確認掃描按鈕存在
    await expect(page.getByRole('button', { name: /掃描|scan/i })).toBeVisible();
  });

  test('當沖頁面載入', async ({ page }) => {
    await page.goto('/live-daytrade');
    // 確認有股票輸入框
    await expect(page.locator('input')).toBeVisible();
  });

  test('API health check — stock endpoint', async ({ request }) => {
    const res = await request.get('/api/stock?symbol=2330&interval=1d&period=5d');
    expect(res.status()).toBe(200);
    const json = await res.json();
    expect(json.candles).toBeDefined();
  });

  test('API rate limiting 回傳 429', async ({ request }) => {
    // 快速連續打超過限額
    const promises = Array.from({ length: 65 }, () =>
      request.get('/api/stock?symbol=2330&interval=1d&period=5d')
    );
    const results = await Promise.all(promises);
    const statuses = results.map(r => r.status());
    // 至少有一個應被 rate limit
    expect(statuses).toContain(429);
  });
});
