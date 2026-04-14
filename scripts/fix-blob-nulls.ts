import { put, del } from '@vercel/blob';
import * as fs from 'fs';
import * as https from 'https';
import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const TARGET_DATE = '2026-04-13';
const DATA_DIR = 'data/candles/CN';
const agent = new https.Agent({ rejectUnauthorized: false });

const STALE = `000003.SZ 000015.SZ 000024.SZ 000406.SZ 000418.SZ 000508.SZ 000515.SZ 000522.SZ 000527.SZ 000542.SZ 000549.SZ 000556.SZ 000562.SZ 000569.SZ 000578.SZ 000588.SZ 000602.SZ 000618.SZ 000666.SZ 000748.SZ 000763.SZ 000817.SZ 000866.SZ 000916.SZ 000956.SZ 001312.SZ 002013.SZ 600001.SS 600002.SS 600005.SS 600068.SS 600102.SS 600205.SS 600253.SS 600263.SS 600270.SS 600296.SS 600317.SS 600357.SS 600472.SS 600553.SS 600607.SS 600625.SS 600627.SS 600631.SS 600632.SS 600723.SS 600786.SS 600832.SS 600840.SS 600842.SS 600849.SS 600991.SS 601299.SS 603293.SS 600837.SS 601028.SS 600705.SS 601989.SS 603056.SS`.split(' ');

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent, headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh)' }, timeout: 12000 }, (res) => {
      if (res.statusCode && res.statusCode >= 400) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume(); return; }
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

type Candle = { date: string; open: number; high: number; low: number; close: number; volume: number };

async function fetchTencent(symbol: string): Promise<Candle[]> {
  const [code, sfx] = symbol.split('.');
  const prefix = sfx === 'SS' ? 'sh' : 'sz';
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${prefix}${code},day,,2024-01-01,${TARGET_DATE},800&_var=kline_day`;
  const raw = await httpGet(url);
  const jsonStr = raw.replace(/^var kline_day=/, '');
  const data = JSON.parse(jsonStr);
  const klines: any[] = data?.data?.[`${prefix}${code}`]?.day ?? data?.data?.[`${prefix}${code}`]?.qfqday ?? [];
  return klines.map(k => ({ date: k[0], open: +k[1], close: +k[2], high: +k[3], low: +k[4], volume: +k[5] }))
    .filter(c => c.date <= TARGET_DATE && c.close > 0);
}

async function fetchYahoo(symbol: string): Promise<Candle[]> {
  const [code, sfx] = symbol.split('.');
  const ySymbol = sfx === 'SS' ? `${code}.SS` : `${code}.SZ`;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ySymbol}?interval=1d&range=2y`;
  const raw = await httpGet(url);
  const data = JSON.parse(raw);
  const result = data?.chart?.result?.[0];
  if (!result) return [];
  const timestamps: number[] = result.timestamp ?? [];
  const ohlcv = result.indicators?.quote?.[0] ?? {};
  return timestamps.map((ts, i) => ({
    date: new Date(ts * 1000).toISOString().slice(0, 10),
    open: +(ohlcv.open?.[i] ?? 0).toFixed(2), high: +(ohlcv.high?.[i] ?? 0).toFixed(2),
    low: +(ohlcv.low?.[i] ?? 0).toFixed(2), close: +(ohlcv.close?.[i] ?? 0).toFixed(2),
    volume: ohlcv.volume?.[i] ?? 0,
  })).filter(c => c.close > 0 && c.date <= TARGET_DATE);
}

async function fetchSina(symbol: string): Promise<Candle[]> {
  const [code, sfx] = symbol.split('.');
  const prefix = sfx === 'SS' ? 'sh' : 'sz';
  const url = `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${prefix}${code}&scale=240&datalen=500&ma=no`;
  const raw = await httpGet(url);
  const data = JSON.parse(raw);
  if (!Array.isArray(data)) return [];
  return data.map((k: any) => ({ date: k.d, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v }))
    .filter(c => c.date <= TARGET_DATE && c.close > 0);
}

async function main() {
  let repaired = 0, deleted = 0;
  
  for (const symbol of STALE) {
    let candles: Candle[] = [];
    
    // Try all providers
    for (const fn of [fetchTencent, fetchYahoo, fetchSina]) {
      try {
        const c = await fn(symbol);
        if (c.length > 10) { candles = c; break; }
      } catch {}
      await sleep(200);
    }
    
    if (candles.length > 0) {
      const sorted = candles.sort((a, b) => a.date.localeCompare(b.date));
      const lastDate = sorted[sorted.length - 1].date;
      const data = { symbol, lastDate, updatedAt: new Date().toISOString(), candles: sorted, sealedDate: lastDate };
      const json = JSON.stringify(data);
      
      // Save locally
      fs.writeFileSync(`${DATA_DIR}/${symbol}.json`, json, 'utf-8');
      
      // Upload to Blob
      await put(`candles/CN/${symbol}.json`, json, {
        access: 'private', addRandomSuffix: false, allowOverwrite: true,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      repaired++;
      console.log(`✅ ${symbol} → lastDate=${lastDate} (${candles.length} candles)`);
    } else {
      // Can't get data → delete from Blob
      try {
        await del(`candles/CN/${symbol}.json`, { token: process.env.BLOB_READ_WRITE_TOKEN });
        deleted++;
        console.log(`🗑️  ${symbol} — no data, deleted from Blob`);
      } catch {
        console.log(`⚠️  ${symbol} — no data, delete failed`);
      }
    }
    await sleep(400);
  }
  
  console.log(`\n完成: repaired=${repaired}, deleted=${deleted}`);
}

main().catch(console.error);
