#!/usr/bin/env node
// 決済1件の所要時間を、2つの入口で同じ手順で1回ずつ測り、data/latency/YYYY-MM-DD.jsonl（JST）に追記する。
//   node scripts/probe-latency.mjs [--item series] [--only usdc|card]
// 必要な環境変数: PROBE_SOLANA_SECRET_KEY（USDC 直接）。無ければ skipped として記録する。
// カード払いの所要時間は実証1ゲートウェイのログの latencyMs をそのまま使うので、既定では測らない（--only card のときだけ測る）。
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ROOT } from '../lib/config.js';
import { localDate } from '../lib/dates.js';
import { makeUsdcClient, measureUsdc, measureCard } from '../lib/probe.js';

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const { site, period } = loadConfig();
const item = site.items.find((i) => i.id === (opt('--item') || 'series'));
if (!item) throw new Error('unknown item');
const only = opt('--only');
const env = process.env;
const recs = [];

if (only !== 'card') {
  if (!env.PROBE_SOLANA_SECRET_KEY) recs.push({ entry: 'usdc', item: item.id, ts: new Date().toISOString(), skipped: 'PROBE_SOLANA_SECRET_KEY 未設定' });
  else {
    const { http, address } = await makeUsdcClient({ secret: env.PROBE_SOLANA_SECRET_KEY, rpcUrl: env.SOLANA_RPC_URL, network: site.usdc.network });
    recs.push({ ...(await measureUsdc({ http, item, usdc: site.usdc })), payer: address });
  }
}
if (only === 'card') {
  const base = site.card.gateway_base_url;
  if (!env.PROBE_NVM_ACCESS_TOKEN || !base || base.startsWith('TODO')) {
    recs.push({ entry: 'card', item: item.id, ts: new Date().toISOString(), skipped: 'PROBE_NVM_ACCESS_TOKEN またはゲートウェイ URL が未設定' });
  } else {
    recs.push(await measureCard({ baseUrl: base, item, token: env.PROBE_NVM_ACCESS_TOKEN }));
  }
}

const date = localDate(Math.floor(Date.now() / 1000), period.utc_offset);
mkdirSync(join(ROOT, 'data/latency'), { recursive: true });
const file = join(ROOT, 'data/latency', `${date}.jsonl`);
for (const r of recs) appendFileSync(file, JSON.stringify(r) + '\n');
console.log(recs);
