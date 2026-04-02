import { NextRequest } from 'next/server';
import { aggregateNews } from '@/lib/news/aggregator';
import { analyzeNewsSentiment } from '@/lib/news/sentiment';
import { getTWChineseName } from '@/lib/datasource/TWSENames';
import { apiOk, apiError } from '@/lib/api/response';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { ticker } = await params;

  if (!ticker || !/^\d{4,6}$/.test(ticker)) {
    return apiError('Invalid ticker format. Expected 4–6 digit Taiwan stock code.', 400);
  }

  // Optional company name from query, or auto-lookup from TWSE name table
  let companyName = request.nextUrl.searchParams.get('name') ?? undefined;
  if (!companyName) {
    companyName = (await getTWChineseName(ticker)) ?? undefined;
  }

  try {
    const items = await aggregateNews(ticker, companyName);
    const result = await analyzeNewsSentiment(ticker, items);
    return apiOk(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return apiError(message, 503);
  }
}
