/**
 * Default Rules — 向後相容的規則列表
 *
 * 委託給 RuleRegistry，確保所有 import DEFAULT_RULES 的地方行為不變。
 * 新的消費端應直接使用 RuleRegistry 來取得分組後的規則。
 */

import { TradingRule } from '@/types';
import { DEFAULT_REGISTRY } from './ruleRegistry';

/** 所有規則的 flat array（向後相容） */
export const DEFAULT_RULES: TradingRule[] = DEFAULT_REGISTRY.getRules();
