/**
 * 策略優化 API
 *
 * GET  /api/daytrade/optimize?action=run&symbol=2330&days=30&timeframe=5m&version=v1.0
 * GET  /api/daytrade/optimize?action=versions
 * GET  /api/daytrade/optimize?action=diagnostics&version=v1.0
 * GET  /api/daytrade/optimize?action=apply&version=v1.0  (應用最佳建議建立新版本)
 * GET  /api/daytrade/optimize?action=iterate&symbol=2330&days=30&rounds=3
 */

import { NextRequest } from 'next/server';
import { z } from 'zod';
import { apiOk, apiError, apiValidationError } from '@/lib/api/response';
import {
  getAllVersions, getVersion, initBaselineVersion,
  getExperiments, getDiagnostics, compareVersions,
} from '@/lib/optimizer/StrategyRegistry';
import { runIteration, applyTopSuggestion } from '@/lib/optimizer/OptimizationRunner';

const querySchema = z.object({
  action: z.enum(['versions', 'run', 'diagnostics', 'apply', 'iterate', 'compare']).default('versions'),
  symbol: z.string().default('2330'),
  days: z.string().default('30'),
  timeframe: z.string().default('5m'),
  version: z.string().optional(),
  rounds: z.string().default('3'),
  v1: z.string().optional(),
  v2: z.string().optional(),
});

export async function GET(req: NextRequest) {
  const parsed = querySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return apiValidationError(parsed.error);
  const { action } = parsed.data;
  // Build base URL for server-side fetch
  const baseUrl = `${req.nextUrl.protocol}//${req.nextUrl.host}`;

  try {
    switch (action) {
      case 'versions': {
        initBaselineVersion();
        return apiOk({
          versions: getAllVersions(),
          experiments: getExperiments(),
        });
      }

      case 'run': {
        const symbol = parsed.data.symbol;
        const days = parseInt(parsed.data.days);
        const timeframe = parsed.data.timeframe;
        const versionId = parsed.data.version;

        const result = await runIteration(symbol, days, timeframe, versionId, baseUrl);

        return apiOk({
          version: result.version,
          experiment: result.experiment,
          diagnostics: result.diagnostics,
        });
      }

      case 'diagnostics': {
        const vId = parsed.data.version || 'v1.0';
        const diag = getDiagnostics(vId);
        if (!diag) return apiError('尚未有診斷報告，請先跑 action=run', 404);
        return apiOk(diag);
      }

      case 'apply': {
        const vId = parsed.data.version || 'v1.0';
        const diag = getDiagnostics(vId);
        const version = getVersion(vId);
        if (!diag || !version) return apiError('找不到版本或診斷', 404);

        const newVersion = applyTopSuggestion(diag, version);
        if (!newVersion) return apiError('沒有可用的優化建議', 400);

        return apiOk({ newVersion, appliedSuggestion: diag.suggestions[0] });
      }

      case 'iterate': {
        const symbol = parsed.data.symbol;
        const days = parseInt(parsed.data.days);
        const timeframe = parsed.data.timeframe;
        const rounds = Math.min(parseInt(parsed.data.rounds), 10);

        initBaselineVersion();
        const iterations: Array<{
          round: number;
          version: unknown;
          metrics: unknown;
          issues: number;
          topSuggestion: string;
          nextVersion: string | null;
        }> = [];
        let currentVersionId: string | undefined;

        for (let i = 0; i < rounds; i++) {
          // 跑當前版本
          const result = await runIteration(symbol, days, timeframe, currentVersionId, baseUrl);

          // 應用最佳建議建立新版本
          const newVersion = applyTopSuggestion(result.diagnostics, result.version);

          iterations.push({
            round: i + 1,
            version: result.version,
            metrics: result.experiment.metrics,
            issues: result.diagnostics.issues.length,
            topSuggestion: result.diagnostics.suggestions[0]?.description ?? '無',
            nextVersion: newVersion?.id ?? null,
          });

          if (newVersion) {
            currentVersionId = newVersion.id;
          } else {
            break; // 沒有更多建議
          }
        }

        return apiOk({
          symbol,
          timeframe,
          days,
          totalRounds: iterations.length,
          iterations,
          allVersions: getAllVersions(),
          finalVersion: currentVersionId ?? 'v1.0',
        });
      }

      case 'compare': {
        const v1 = parsed.data.v1 || '';
        const v2 = parsed.data.v2 || '';
        const comparison = compareVersions(v1, v2);
        if (!comparison) return apiError('版本不存在', 404);

        const exp1 = getExperiments(v1).find(e => e.status === 'completed');
        const exp2 = getExperiments(v2).find(e => e.status === 'completed');

        return apiOk({
          ...comparison,
          metrics1: exp1?.metrics ?? null,
          metrics2: exp2?.metrics ?? null,
        });
      }

      default:
        return apiError(`Unknown action: ${action}`, 400);
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return apiError(msg);
  }
}
