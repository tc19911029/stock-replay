import { getSessionCost } from '@/lib/ai/costTracker';
import { apiOk } from '@/lib/api/response';

/** GET /api/ai/cost — return current session cost summary */
export async function GET() {
  const cost = getSessionCost();
  return apiOk({
    totalCostUsd: cost.totalCostUsd,
    totalInputTokens: cost.totalInputTokens,
    totalOutputTokens: cost.totalOutputTokens,
    callCount: cost.records.length,
    byRole: cost.byRole,
    recentCalls: cost.records.slice(-10).reverse(),
  });
}
