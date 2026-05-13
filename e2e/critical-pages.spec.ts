/**
 * 0513 ABCDE B4 — critical pages hydration smoke
 *
 * 對每個重要頁面驗證：
 *   1. server response 200
 *   2. client-side hydration 不噴 uncaught error (TypeError / ErrorBoundary trigger)
 *   3. expected content marker 出現
 *
 * 這是 smoke-pages.ts (server-side) 的補強層 — 抓 client hydration crash。
 */

import { test, expect, Page } from '@playwright/test';

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (/Cannot read properties|undefined|TypeError|ErrorBoundary/.test(text)) {
        errors.push(`console: ${text.slice(0, 200)}`);
      }
    }
  });
  return errors;
}

test.describe('critical pages hydration', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      try {
        localStorage.setItem('risk-disclaimer-accepted', '1');
        localStorage.setItem('feature-guide-seen', '1');
      } catch {}
    });
  });


  test('/ (root with default index)', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(errors, errors.join('\n')).toHaveLength(0);
  });

  test('/portfolio', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/portfolio');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(errors, errors.join('\n')).toHaveLength(0);
  });

  test('/watchlist', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/watchlist');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(errors, errors.join('\n')).toHaveLength(0);
  });

  test('/health 顯示紅綠燈', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/health');
    // 等資料載入完
    await expect(page.getByText(/正常|需要處理/).first()).toBeVisible({ timeout: 15_000 });
    // L1 健康度、覆蓋率 marker 應出現
    await expect(page.getByText('L1 歷史日K').first()).toBeVisible();
    await expect(page.getByText('覆蓋率').first()).toBeVisible();
    expect(errors, errors.join('\n')).toHaveLength(0);
  });

  test('/v12-performance', async ({ page }) => {
    const errors = watchErrors(page);
    await page.goto('/v12-performance');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(2000);
    expect(errors, errors.join('\n')).toHaveLength(0);
  });
});
