/**
 * 策略版本登錄與管理
 */

import type { StrategyVersion, StrategyParams, Experiment, DiagnosticsReport } from './types';
import { DEFAULT_STRATEGY_PARAMS } from './types';

// In-memory registry (persists via API later)
const versions: Map<string, StrategyVersion> = new Map();
const experiments: Map<string, Experiment> = new Map();
const diagnostics: Map<string, DiagnosticsReport> = new Map();

/** 取得所有版本 */
export function getAllVersions(): StrategyVersion[] {
  return Array.from(versions.values()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 取得特定版本 */
export function getVersion(id: string): StrategyVersion | undefined {
  return versions.get(id);
}

/** 取得最新版本 */
export function getLatestVersion(): StrategyVersion | undefined {
  const all = getAllVersions();
  return all[all.length - 1];
}

/** 建立新版本 */
export function createVersion(
  name: string,
  description: string,
  params: Partial<StrategyParams>,
  changelog: string[],
  parentId?: string,
): StrategyVersion {
  const parent = parentId ? versions.get(parentId) : getLatestVersion();
  const baseParams = parent?.params ?? DEFAULT_STRATEGY_PARAMS;

  // Auto-increment version ID
  const allIds = getAllVersions().map(v => v.id);
  let nextId: string;
  if (allIds.length === 0) {
    nextId = 'v1.0';
  } else {
    const lastId = allIds[allIds.length - 1];
    const [major, minor] = lastId.replace('v', '').split('.').map(Number);
    nextId = `v${major}.${minor + 1}`;
  }

  const version: StrategyVersion = {
    id: nextId,
    name,
    description,
    createdAt: new Date().toISOString(),
    parentId: parent?.id ?? null,
    params: { ...baseParams, ...params },
    changelog,
  };

  versions.set(nextId, version);
  return version;
}

/** 建立基線版本 (v1.0) */
export function initBaselineVersion(): StrategyVersion {
  if (versions.has('v1.0')) return versions.get('v1.0')!;

  const v = createVersion(
    '基線版',
    '原始策略，未做任何優化',
    DEFAULT_STRATEGY_PARAMS,
    ['初始版本'],
  );
  // Force ID to v1.0
  versions.delete(v.id);
  v.id = 'v1.0';
  versions.set('v1.0', v);
  return v;
}

/** 記錄實驗 */
export function recordExperiment(exp: Experiment): void {
  experiments.set(exp.id, exp);
}

/** 取得版本的所有實驗 */
export function getExperiments(versionId?: string): Experiment[] {
  const all = Array.from(experiments.values());
  if (versionId) return all.filter(e => e.versionId === versionId);
  return all.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** 存入診斷報告 */
export function saveDiagnostics(report: DiagnosticsReport): void {
  diagnostics.set(report.versionId, report);
}

/** 取得診斷報告 */
export function getDiagnostics(versionId: string): DiagnosticsReport | undefined {
  return diagnostics.get(versionId);
}

/** 比較兩個版本 */
type ParamValue = string | number | boolean | string[] | Record<string, string | number | boolean>;

export function compareVersions(v1Id: string, v2Id: string): {
  v1: StrategyVersion; v2: StrategyVersion;
  paramDiffs: Array<{ param: string; v1Value: ParamValue; v2Value: ParamValue }>;
} | null {
  const v1 = versions.get(v1Id);
  const v2 = versions.get(v2Id);
  if (!v1 || !v2) return null;

  const paramDiffs: Array<{ param: string; v1Value: ParamValue; v2Value: ParamValue }> = [];
  const allKeys = new Set([...Object.keys(v1.params), ...Object.keys(v2.params)]);

  for (const key of allKeys) {
    const val1 = v1.params[key as keyof StrategyParams] as ParamValue;
    const val2 = v2.params[key as keyof StrategyParams] as ParamValue;
    if (JSON.stringify(val1) !== JSON.stringify(val2)) {
      paramDiffs.push({ param: key, v1Value: val1, v2Value: val2 });
    }
  }

  return { v1, v2, paramDiffs };
}
