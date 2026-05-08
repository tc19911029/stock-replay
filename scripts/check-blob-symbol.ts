import { config } from 'dotenv';
import { existsSync } from 'fs';
if (existsSync('.env.local')) config({ path: '.env.local' });
config();
import { get } from '@vercel/blob';

async function main() {
  const TOKEN = process.env.BLOB_READ_WRITE_TOKEN!;
  const sym = process.argv[2] ?? '8476.TW';
  const market = process.argv[3] ?? 'TW';
  const date = process.argv[4];

  const r = await get(`candles/${market}/${sym}.json`, { access: 'private', token: TOKEN });
  if (!r) { console.log('not found'); return; }
  const chunks: Uint8Array[] = [];
  const reader = r.stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  const data = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  console.log(`Blob ${market}/${sym}: ${data.candles.length} candles, lastDate=${data.lastDate}`);
  if (date) {
    const t = data.candles.find((c: { date: string }) => c.date === date);
    console.log(`${date}:`, JSON.stringify(t));
  } else {
    console.log('Last 3 candles:', JSON.stringify(data.candles.slice(-3)));
  }
}
main();
