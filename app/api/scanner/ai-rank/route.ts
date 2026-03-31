import Anthropic from '@anthropic-ai/sdk';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const maxDuration = 60;

const aiRankSchema = z.object({
  stocks: z.array(z.unknown()).default([]),
  market: z.string().optional(),
});

interface StockForAI {
  symbol: string;
  name: string;
  price: number;
  changePercent: number;
  surgeScore: number;
  surgeGrade: string;
  surgeFlags: string[];
  sixConditionsScore: number;
  trendState: string;
  trendPosition: string;
  components: Record<string, { score: number; detail: string }>;
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: '未設定 ANTHROPIC_API_KEY' }, { status: 500 });
  }

  const body = await req.json().catch(() => ({}));
  const parsed = aiRankSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const stocks = (parsed.data.stocks ?? []) as StockForAI[];
  const market = parsed.data.market;
  if (stocks.length === 0) {
    return NextResponse.json({ rankings: [], marketComment: '' });
  }

  const stockSummary = stocks.map((s, i) => {
    const comps = Object.entries(s.components)
      .map(([k, v]) => `${k}:${v.score}`)
      .join(', ');
    return `${i + 1}. ${s.symbol} ${s.name} | 價${s.price} 漲跌${s.changePercent > 0 ? '+' : ''}${s.changePercent}% | 飆股分${s.surgeScore}(${s.surgeGrade}) | 六大條件${s.sixConditionsScore}/6 | ${s.trendState}/${s.trendPosition} | flags:[${s.surgeFlags.join(',')}] | 子項:{${comps}}`;
  }).join('\n');

  const systemPrompt = `你是台灣股市飆股分析專家。你的任務是從掃描結果中挑出最有可能在未來1-4週大漲(30%+)的股票。

判斷標準（重要性由高到低）：
1. 突破型態：整理區間突破、均線糾結後發散、創新高 = 最強信號
2. 量能爆發：連續增量、今日爆量配合突破 = 主力進場
3. 動能加速：RSI上升、ROC加速、MACD柱放大 = 趨勢啟動
4. 位置優勢：起漲段 > 主升段前段 > 主升段後段
5. 波動擴張：BB壓縮後突破 = 即將爆發

回覆格式（嚴格 JSON）：
{
  "rankings": [
    { "symbol": "...", "rank": 1, "confidence": "high|medium|low", "reason": "一句話中文理由(20字內)" }
  ],
  "marketComment": "一句話市場觀察(20字內)"
}

只回覆 JSON，不要其他文字。最多排名前 10 名。confidence=high 表示你非常有信心這支會飆。`;

  try {
    const client = new Anthropic({ apiKey });
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: `以下是今日${market === 'CN' ? '中國A股' : '台灣股市'}掃描結果，請排名飆股潛力：\n\n${stockSummary}` }],
    });

    const text = msg.content[0].type === 'text' ? msg.content[0].text : '';
    // Extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json({ rankings: [], marketComment: 'AI 回應格式異常' });
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      rankings: Array<{ symbol: string; rank: number; confidence: string; reason: string }>;
      marketComment: string;
    };

    return NextResponse.json(parsed);
  } catch (err) {
    console.error('[ai-rank] error:', err);
    return NextResponse.json({ error: 'AI 排名服務暫時無法使用' }, { status: 500 });
  }
}
