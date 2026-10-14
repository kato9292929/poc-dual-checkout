#!/usr/bin/env node
// 日次集計（区切りは JST の 00:00〜24:00）
//   node scripts/collect-daily.mjs                 JST の前日分を取り込み、data/YYYY-MM-DD.json に保存
//   node scripts/collect-daily.mjs --date D        指定日を取り込み直す
//   node scripts/collect-daily.mjs --resummarize D1..D2
//                                                  保存済みの明細に、今の分類リストを当てて数え直す。
//                                                  ゲートウェイのログが欠損していた日は、口がつながっていれば取りに行って埋める
// 毎回、直近 45 日分のカード決済について Stripe の着金（payout）を確認し、着金日が分かったものを書き足す。
// 取れなかったソースは 0 で埋めず、sources に理由を残す。
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ROOT } from '../lib/config.js';
import { addDays, dayBounds, stamp, yesterday } from '../lib/dates.js';
import { fetchPayments, DEFAULT_RPC } from '../lib/solana.js';
import { fetchSales, matchesPlan, toSale, fetchPayoutArrivals, withPayout } from '../lib/stripe.js';
import { csvSalesForDate } from '../lib/stripe-csv.js';
import { fetchGatewayLog, toCalls, parseJsonl } from '../lib/gateway.js';
import { NVM_API, reconcile } from '../lib/nevermined.js';
import { solUsd } from '../lib/price.js';
import { anonymize } from '../lib/anon.js';
import { buildDaily } from '../lib/aggregate.js';

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const env = process.env;
const config = loadConfig();
const offset = config.period.utc_offset;
const dataFile = (d) => join(ROOT, 'data', `${d}.json`);
const save = (daily) => {
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  writeFileSync(dataFile(daily.date), JSON.stringify(daily, null, 2) + '\n');
};
const rebuild = (d, detail, sources) => save(buildDaily({ date: d, config, detail, sources }));

// 実証1ゲートウェイのログの口（GET /logs/:date、Bearer は LOG_READ_TOKEN）
const gw = (() => {
  const base = config.site.card.gateway_base_url;
  const url = env.GATEWAY_LOG_URL || (base && !base.startsWith('TODO') ? `${base.replace(/\/$/, '')}${config.site.card.gateway_log_path}` : null);
  return { url, dir: env.GATEWAY_LOG_DIR, token: env.LOG_READ_TOKEN, ready: !!((url && env.LOG_READ_TOKEN) || env.GATEWAY_LOG_DIR) };
})();
const loadGateway = async (s, e) => toCalls(await fetchGatewayLog(gw, s, e), offset);

if (opt('--resummarize')) {
  const [a, b = a] = opt('--resummarize').split('..');
  for (let d = a; d <= b; d = addDays(d, 1)) {
    if (!existsSync(dataFile(d))) continue;
    const old = JSON.parse(readFileSync(dataFile(d), 'utf8'));
    if (old.schema !== 3) throw new Error(`${d}: schema ${old.schema} は数え直せない。--date ${d} で取り込み直す`);
    // ゲートウェイのログが欠損していた日は、口がつながっていれば取りに行って埋める
    if (old.sources.gateway_log === 'not_configured') old.sources.gateway_log = 'missing';
    if (old.sources.gateway_log !== 'ok' && gw.ready) {
      const b = dayBounds(d, offset);
      try {
        old.detail.card.calls = await loadGateway(b.start, b.end);
        old.sources.gateway_log = 'ok';
        old.sources.gateway_log_backfilled_at = new Date().toISOString();
      } catch (e) {
        old.sources.gateway_log = `error: ${e.message}`;
      }
    }
    rebuild(d, old.detail, old.sources);
    console.log(`resummarized ${d}（gateway_log: ${old.sources.gateway_log}）`);
  }
  process.exit(0);
}

const date = opt('--date') || yesterday(offset);
const { start, end } = dayBounds(date, offset);
const iso = (t) => new Date(t * 1000).toISOString();
const sources = {};

async function attempt(name, enabled, fn, { missing = 'not_configured' } = {}) {
  if (!enabled) return (sources[name] = missing), null;
  try {
    const v = await fn();
    sources[name] = 'ok';
    return v;
  } catch (e) {
    sources[name] = `error: ${e.message}`;
    console.error(`[${name}]`, e.message);
    return null;
  }
}

const card = config.site.card;

const page = await attempt('page', env.STATS_URL && env.STATS_TOKEN, async () => {
  const u = new URL(env.STATS_URL);
  u.searchParams.set('date', date);
  const res = await fetch(u, { headers: { authorization: `Bearer ${env.STATS_TOKEN}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
});

// USDC 直接
const sol = await attempt('sol_usd', true, async () => {
  const r = await solUsd(date);
  if (r.usd == null) throw new Error('SOL/USD を取得できない');
  return r;
});
const payments = await attempt('usdc_chain', true, async () =>
  (await fetchPayments(env.SOLANA_RPC_URL || DEFAULT_RPC, { payTo: config.site.usdc.pay_to, mint: config.site.usdc.asset, start, end })).map(
    (p) => ({ ...stamp(p.block_time, offset), ...p, sol_usd: sol?.usd ?? null }),
  ),
);

// カード払い：利用件数・消費クレジット・購入者は実証1ゲートウェイのログで数える
// 口がまだ無い・トークンが無い日は欠損（missing）。つながったあと --resummarize で埋める
const calls = await attempt('gateway_log', gw.ready, () => loadGateway(start, end), { missing: 'missing' });

// カード払い：手数料と着金日は Stripe（API と、手で書き出した CSV）
let sales = await attempt(
  'stripe',
  !!env.STRIPE_RESTRICTED_KEY,
  async () =>
    (await fetchSales(env.STRIPE_RESTRICTED_KEY, start, end)).filter((bt) => matchesPlan(bt, card.stripe_match)).map((bt) => toSale(bt, anonymize, offset)),
  { missing: 'missing' },
);
let csv = null;
try {
  csv = csvSalesForDate(date, { anonymize, offset });
  sources.stripe_csv = csv ? 'ok' : 'not_found';
} catch (e) {
  sources.stripe_csv = `error: ${e.message}`;
  console.error('[stripe_csv]', e.message);
}
if (csv) {
  // API で取れたものを優先し、CSV にしか無い取引を足す（取引 ID の匿名値で突き合わせる）
  const have = new Set((sales || []).map((s) => s.txn_hash));
  sales = [...(sales || []), ...csv.filter((s) => !have.has(s.txn_hash))];
}

// 照合用：Nevermined の Events & Analytics。403 などで取れなくても止めない
let nvm = null;
let nvmPurchases = null;
if (!env.NVM_API_KEY || !env.NVM_ORG_ID) sources.nvm_api = 'not_configured';
else {
  try {
    const r = await reconcile(
      { base: NVM_API[card.nvm_environment], key: env.NVM_API_KEY, orgId: env.NVM_ORG_ID },
      { from: iso(start), to: iso(end - 1), planId: card.nvm_plan_id, anonymize, offset },
    );
    nvm = r.totals;
    nvmPurchases = r.purchases;
    sources.nvm_api = 'ok';
  } catch (e) {
    sources.nvm_api = 'unavailable';
    sources.nvm_api_reason = e.message;
    console.error('[nvm_api]', e.message);
  }
}

const latFile = join(ROOT, 'data/latency', `${date}.jsonl`);
const latency = existsSync(latFile) ? parseJsonl(readFileSync(latFile, 'utf8')) : [];
sources.latency_probe = latency.length ? 'ok' : 'not_found';

const detail = {
  window_utc: [iso(start), iso(end)],
  page,
  usdc: payments ? { payments, sol_usd: sol } : null,
  card: { calls, sales, nvm_purchases: nvmPurchases, nvm },
  latency,
};
const daily = buildDaily({ date, config, detail, sources });
save(daily);
console.log(`wrote data/${date}.json`);

// Stripe の着金日を、まだ分かっていない過去の日に書き足す
if (env.STRIPE_RESTRICTED_KEY) {
  try {
    const arrivals = await fetchPayoutArrivals(env.STRIPE_RESTRICTED_KEY, start - 45 * 86400, anonymize);
    for (const f of readdirSync(join(ROOT, 'data')).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))) {
      const d = f.slice(0, 10);
      if (d < addDays(date, -45)) continue;
      const old = JSON.parse(readFileSync(dataFile(d), 'utf8'));
      const list = old.detail?.card?.sales;
      if (old.schema !== 3 || !list) continue;
      let changed = false;
      old.detail.card.sales = list.map((s) => {
        if (s.payout_arrival_utc != null || arrivals[s.txn_hash] == null) return s;
        changed = true;
        return withPayout(s, arrivals[s.txn_hash], offset);
      });
      if (changed) (rebuild(d, old.detail, old.sources), console.log(`payout updated: ${d}`));
    }
  } catch (e) {
    console.error('[stripe payouts]', e.message);
  }
}

console.log(JSON.stringify({ sources, price_check: daily.price_check, by_class: daily.by_class, latency: daily.latency }, null, 2));
