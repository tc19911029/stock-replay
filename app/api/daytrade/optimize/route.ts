/**
 * 策略優化 API
 *
 * GET  /api/daytrade/optimize?action=run&symbol=2330&days=30&timeframe=5m&version=v1.0
 * GET  /api/daytrade/optimize?action=versions
 * GET  /api/daytrade/optimize?action=diagnostics&version=v1.0
 * GET  /api/daytrade/optimize?action=apply&version=v1.0  (應用最佳建議建立新版本)
 * GET  /api/daytrade/optimize?action=iterate&symbol=2330&days=30&rounds=3
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  getAllVersions, getVersion, initBaselineVersion,
  getExperiments, getDiagnostics, compareVersions,
} from '@/lib/optimizer/StrategyRegistry';
import { runIteration, applyTopSuggestion } from '@/lib/optimizer/OptimizationRunner';

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const action = sp.get('action') || 'versions';
  // Build base URL for server-side fetch
  const baseUrl = `${req.nextUrl.protocol}//${req.nextUrl.host}`;

  try {
    switch (action) {
      case 'versions': {
        initBaselineVersion();
        return NextResponse.json({
          versions: getAllVersions(),
          experiments: getExperiments(),
        });
      }

      case 'run': {
        const symbol = sp.get('symbol') || '2330';
        const days = parseInt(sp.get('days') || '30');
        const timeframe = sp.get('timeframe') || '5m';
        const versionId = sp.get('version') || undefined;

        const result = await runIteration(symbol, days, timeframe, versionId, baseUrl);

        return NextResponse.json({
          version: result.version,
          experiment: result.experiment,
          diagnostics: result.diagnostics,
        });
      }

      case 'diagnostics': {
        const vId = sp.get('version') || 'v1.0';
        const diag = getDiagnostics(vId);
        if (!diag) return NextResponse.json({ error: '尚未有診斷報告，請先跑 action=run' }, { status: 404 });
        return NextResponse.json(diag);
      }

      case 'apply': {
        const vId = sp.get('version') || 'v1.0';
        const diag = getDiagnostics(vId);
        const version = getVersion(vId);
        if (!diag || !version) return NextResponse.json({ error: '找不到版本或診斷' }, { status: 404 });

        const newVersion = applyTopSuggestion(diag, version);
        if (!newVersion) return NextResponse.json({ error: '沒有可用的優化建議' }, { status: 400 });

        return NextResponse.json({ newVersion, appliedSuggestion: diag.suggestions[0] });
      }

      case 'iterate': {
        const symbol = sp.get('symbol') || '2330';
        const days = parseInt(sp.get('days') || '30');
        const timeframe = sp.get('timeframe') || '5m';
        const rounds = Math.min(parseInt(sp.get('rounds') || '3'), 10);

        initBaselineVersion();
        const iterations: any[] = [];
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

        return NextResponse.json({
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
        const v1 = sp.get('v1') || '';
        const v2 = sp.get('v2') || '';
        const comparison = compareVersions(v1, v2);
        if (!comparison) return NextResponse.json({ error: '版本不存在' }, { status: 404 });

        const exp1 = getExperiments(v1).find(e => e.status === 'completed');
        const exp2 = getExperiments(v2).find(e => e.status === 'completed');

        return NextResponse.json({
          ...comparison,
          metrics1: exp1?.metrics ?? null,
          metrics2: exp2?.metrics ?? null,
        });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
