import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { StockScanResult } from '@/lib/scanner/types';

const emailBodySchema = z.object({
  to: z.string().email().optional(),
  subject: z.string().optional(),
  results: z.array(z.unknown()).default([]),
  market: z.string().default('TW'),
});

function generateEmailHtml(results: StockScanResult[], market: string): string {
  const marketName = market === 'TW' ? '台灣股市' : '中國A股';
  const top5 = results.slice(0, 5);

  const rows = top5.map((r, i) => {
    const medals = ['🥇', '🥈', '🥉', '', ''];
    const medal = medals[i] ?? '';
    const changeColor = r.changePercent >= 0 ? '#ef4444' : '#22c55e';
    const changeSign = r.changePercent >= 0 ? '+' : '';
    const sym = r.symbol.replace(/\.(TW|TWO|SS|SZ)$/i, '');
    const condDots = Array.from({ length: 6 }, (_, j) =>
      j < r.sixConditionsScore
        ? '<span style="color:#22c55e">●</span>'
        : '<span style="color:#475569">○</span>'
    ).join('');

    return `
      <tr style="border-bottom:1px solid #1e293b;">
        <td style="padding:12px 8px;font-weight:bold;color:#f8fafc;">${medal} ${sym}</td>
        <td style="padding:12px 8px;color:#94a3b8;">${r.name}</td>
        <td style="padding:12px 8px;font-family:monospace;color:#f8fafc;">${r.price.toFixed(2)}</td>
        <td style="padding:12px 8px;font-weight:bold;color:${changeColor};">${changeSign}${r.changePercent.toFixed(2)}%</td>
        <td style="padding:12px 8px;font-size:14px;">${condDots} <span style="color:#94a3b8;font-size:11px;">${r.sixConditionsScore}/6</span></td>
        <td style="padding:12px 8px;color:#64748b;font-size:11px;">${r.trendState}</td>
      </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0b1120;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:24px 16px;">

    <!-- Header -->
    <div style="background:#1e293b;border:1px solid #334155;border-radius:12px;padding:20px 24px;margin-bottom:16px;">
      <h1 style="margin:0 0 4px;font-size:18px;color:#f8fafc;">📈 K線走圖 — 每日掃描報告</h1>
      <p style="margin:0;font-size:12px;color:#64748b;">${marketName} · ${new Date().toLocaleDateString('zh-TW', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}</p>
    </div>

    <!-- Summary -->
    <div style="background:#0f172a;border:1px solid #1e3a5f;border-radius:12px;padding:16px 24px;margin-bottom:16px;">
      <p style="margin:0;font-size:13px;color:#93c5fd;">
        今日共找到 <strong style="color:#60a5fa;font-size:16px;">${results.length}</strong> 檔符合朱老師六大條件的股票
      </p>
    </div>

    <!-- Top stocks table -->
    ${top5.length > 0 ? `
    <div style="background:#1e293b;border:1px solid #334155;border-radius:12px;overflow:hidden;margin-bottom:16px;">
      <div style="padding:12px 16px;border-bottom:1px solid #334155;">
        <h2 style="margin:0;font-size:13px;color:#94a3b8;font-weight:600;">Top ${top5.length} 精選股票（按六大條件得分）</h2>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="background:#0f172a;">
            <th style="padding:8px;text-align:left;color:#64748b;font-weight:500;">代號</th>
            <th style="padding:8px;text-align:left;color:#64748b;font-weight:500;">名稱</th>
            <th style="padding:8px;text-align:left;color:#64748b;font-weight:500;">收盤</th>
            <th style="padding:8px;text-align:left;color:#64748b;font-weight:500;">漲跌</th>
            <th style="padding:8px;text-align:left;color:#64748b;font-weight:500;">六大條件</th>
            <th style="padding:8px;text-align:left;color:#64748b;font-weight:500;">趨勢</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>` : ''}

    <!-- CTA -->
    <div style="text-align:center;margin-bottom:16px;">
      <a href="${process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'}/scanner"
        style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:bold;">
        查看完整掃描結果 →
      </a>
    </div>

    <!-- Footer -->
    <p style="text-align:center;font-size:10px;color:#334155;margin:0;">
      本郵件由 K線走圖練習系統自動發送 · 僅供學習參考，非投資建議
    </p>
  </div>
</body>
</html>`;
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.json().catch(() => ({}));
    const parsed = emailBodySchema.safeParse(raw);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
    const { to, subject, market } = parsed.data;
    const results = parsed.data.results as StockScanResult[];

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'RESEND_API_KEY not configured' }, { status: 500 });
    }

    const recipient = to ?? process.env.NOTIFY_EMAIL;
    if (!recipient) {
      return NextResponse.json({ error: 'No recipient email configured' }, { status: 400 });
    }

    const marketName = market === 'TW' ? '台灣股市' : '中國A股';
    const emailSubject = subject ?? `📈 ${marketName} 掃描報告 — ${results.length} 檔符合條件`;
    const html = generateEmailHtml(results, market);

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM ?? 'onboarding@resend.dev',
        to: [recipient],
        subject: emailSubject,
        html,
      }),
    });

    const json = await res.json() as { id?: string; error?: string };

    if (!res.ok) {
      return NextResponse.json({ error: json.error ?? 'Resend API error' }, { status: res.status });
    }

    return NextResponse.json({ ok: true, id: json.id });
  } catch (err) {
    console.error('[notify/email] error:', err);
    return NextResponse.json({ error: '通知發送失敗' }, { status: 500 });
  }
}
