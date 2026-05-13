/**
 * Known data anomalies registry — 載入 + 規則匹配 API
 *
 * 用途：當 audit 偵測到「不正常」資料時，先查 registry。若已有規則 / case 對應，
 *      不算 bug、不告警，回傳 reason 紀錄。剩下未匹配的才是真 bug。
 *
 * 使用：
 *   import { matchAnomaly, getRule } from '@/lib/datasource/knownAnomalies';
 *
 *   const match = matchAnomaly('sandwich-vol-zero', {
 *     symbol: '1101.TW', date: '2025-08-13',
 *     current: { volume: 0, open: 24.75, high: 24.75, low: 24.75, close: 24.75 },
 *     prev: { close: 24.75 },
 *     next: { open: 23, close: 23.8 },
 *   });
 *   if (match) {
 *     // 已知合法異常，跳過 alert
 *   }
 */
import { existsSync, readFileSync } from 'fs';
import path from 'path';

export type AnomalyType =
  | 'sandwich-vol-zero'
  | 'l1-ohlc-invariant-violation'
  | 'l2-symbol-without-l1'
  | 'limit-up-not-in-scan'
  | 'l1-last-day-stale'
  | 'mis-twse-locked-day';

interface AnomalyRule {
  id: string;
  name: string;
  description: string;
  verifiedBy: string[];
  verifiedAt: string;
  applies: { type: AnomalyType; pattern: Record<string, unknown> };
  evidence: string;
  remediation: string;
  estimatedCount?: number;
  lastConfirmed: string;
}

interface AnomalyCase {
  symbol: string;
  date: string;
  type: string;
  verifiedBy: string[];
  verifiedAt: string;
  note: string;
}

interface AnomaliesRegistry {
  version: number;
  description: string;
  lastUpdated: string;
  rules: AnomalyRule[];
  cases: AnomalyCase[];
}

let cached: AnomaliesRegistry | null = null;

export function loadRegistry(): AnomaliesRegistry {
  if (cached) return cached;
  const f = path.join(process.cwd(), 'data', 'known-anomalies.json');
  if (!existsSync(f)) {
    cached = { version: 0, description: '', lastUpdated: '', rules: [], cases: [] };
    return cached;
  }
  try {
    cached = JSON.parse(readFileSync(f, 'utf8')) as AnomaliesRegistry;
  } catch {
    cached = { version: 0, description: '', lastUpdated: '', rules: [], cases: [] };
  }
  return cached;
}

export interface MatchContext {
  symbol: string;
  date: string;
  current?: { volume?: number; open?: number; high?: number; low?: number; close?: number };
  prev?: { close?: number };
  next?: { open?: number; close?: number };
  vendor?: { close?: number; volume?: number };
}

export interface MatchResult {
  ruleId: string;
  ruleName: string;
  reason: string;
  remediation: string;
  evidence: string;
}

/** 檢查某筆 anomaly 是否能對應到 registry 中已認證的規則或 case */
export function matchAnomaly(type: AnomalyType, ctx: MatchContext): MatchResult | null {
  const reg = loadRegistry();

  // 1. 先查 individual case
  for (const c of reg.cases) {
    if (c.symbol === ctx.symbol && c.date === ctx.date) {
      const rule = reg.rules.find(r => r.id === c.type);
      return {
        ruleId: c.type,
        ruleName: rule?.name ?? c.type,
        reason: c.note,
        remediation: rule?.remediation ?? 'individual case',
        evidence: c.note,
      };
    }
  }

  // 2. 規則式匹配
  for (const rule of reg.rules) {
    if (rule.applies.type !== type) continue;
    const p = rule.applies.pattern as Record<string, unknown>;
    let match = true;

    if (type === 'sandwich-vol-zero') {
      const c = ctx.current ?? {};
      if (p.volume === 0 && c.volume !== 0) match = false;
      if (p.ohlc_all_equal === true && !(c.open === c.high && c.high === c.low && c.low === c.close)) match = false;
      if (p.h_eq_l === true && !(c.high != null && c.low != null && c.close != null && c.high === c.low && c.low === c.close)) match = false;
      if (p.ohlc_has_range === true && !(c.high != null && c.low != null && c.high > c.low)) match = false;
      if (p.ohlc_equals_prev_close === true && ctx.prev?.close != null && c.close !== ctx.prev.close) match = false;
      const jumpGte = p.next_day_open_gap_pct_gte as number | undefined;
      if (jumpGte != null && ctx.next?.open != null && c.close != null) {
        const gap = Math.abs(ctx.next.open - c.close) / c.close;
        if (gap < jumpGte) match = false;
      }
    } else if (type === 'l1-ohlc-invariant-violation') {
      const diffGte = p.vendor_close_vs_l1_close_diff_pct_gte as number | undefined;
      if (diffGte != null) {
        if (ctx.vendor?.close == null || ctx.current?.close == null) match = false;
        else {
          const diff = Math.abs(ctx.vendor.close - ctx.current.close) / Math.max(ctx.vendor.close, ctx.current.close);
          if (diff < diffGte) match = false;
        }
      }
    } else if (type === 'l2-symbol-without-l1') {
      const prefix = p.symbol_prefix as string | undefined;
      const len = p.symbol_length as number | undefined;
      if (prefix && !ctx.symbol.startsWith(prefix)) match = false;
      if (len && ctx.symbol.length !== len) match = false;
    } else {
      // 其他類別暫不細匹配
      match = false;
    }

    if (match) {
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        reason: rule.description,
        remediation: rule.remediation,
        evidence: rule.evidence,
      };
    }
  }

  return null;
}

export function getRule(id: string): AnomalyRule | null {
  return loadRegistry().rules.find(r => r.id === id) ?? null;
}

export function listRules(): AnomalyRule[] {
  return loadRegistry().rules;
}

export function listCases(): AnomalyCase[] {
  return loadRegistry().cases;
}
