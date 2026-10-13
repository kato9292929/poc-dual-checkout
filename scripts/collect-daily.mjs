#!/usr/bin/env node
// 日次集計
//   node scripts/collect-daily.mjs                 JST の前日分を取り込み、data/YYYY-MM-DD.json に保存
//   node scripts/collect-daily.mjs --date D        指定日を取り込み直す
//   node scripts/collect-daily.mjs --resummarize D1..D2
//                                                  保存済みの明細に、今の除外リストを当てて数え直す（外部には取りに行かない）
// 毎回、直近 45 日分のカード決済について Stripe の入金（payout）を確認し、着金日が分かったものを書き足す。
// 取れなかったソースは 0 で埋めず、sources に理由を残す。
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ROOT } from '../lib/config.js';
import { addDays, dayBounds, yesterday } from '../lib/dates.js';
import { fetchPayments, DEFAULT_RPC } from '../lib/solana.js';
import { fetchSales, matchesPlan, toSale, fetchPayoutArrivals } from '../lib/stripe.js';
import { fetchGatewayLog, summarizeGatewayLog, parseJsonl } from '../lib/gateway.js';
import { NVM_API, listActivity, analytics, purchasesFromEvents, totalsFromAnalytics } from '../lib/nevermined.js';
import { manualSales } from '../lib/manual.js';
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

function rebuild(d) {
  const old = JSON.parse(readFileSync(dataFile(d), 'utf8'));
  if (old.schema !== 2) throw new Error(`${d}: schema ${old.schema} は数え直せない`);
  save(buildDaily({ date: d, config, detail: old.detail, sources: old.sources }));
}

if (opt('--resummarize')) {
  const [a, b = a] = opt('--resummarize').split('..');
  for (let d = a; d <= b; d = addDays(d, 1)) if (existsSync(dataFile(d))) (rebuild(d), console.log(`resummarized ${d}`));
  process.exit(0);
}

const date = opt('--date') || yesterday(offset);
const { start, end } = dayBounds(date, offset);
const iso = (t) => new Date(t * 1000).toISOString();
const sources = {};

async function attempt(name, enabled, fn) {
  if (!enabled) return (sources[name] = 'not_configured'), null;
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
const nvm = { base: NVM_API[card.nvm_environment], key: env.NVM_API_KEY, orgId: env.NVM_ORG_ID };

const page = await attempt('page', env.STATS_URL && env.STATS_TOKEN, async () => {
  const u = new URL(env.STATS_URL);
  u.searchParams.set('date', date);
  const res = await fetch(u, { headers: { authorization: `Bearer ${env.STATS_TOKEN}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
});

const payments = await attempt('usdc_chain', true, () =>
  fetchPayments(env.SOLANA_RPC_URL || DEFAULT_RPC, { payTo: config.site.usdc.pay_to, mint: config.site.usdc.asset, start, end }),
);
const sol = await attempt('sol_usd', true, async () => {
  const r = await solUsd(date);
  if (r.usd == null) throw new Error('SOL/USD を取得できない');
  return r;
});

const purchasesNvm = await attempt('nevermined_events', !!(nvm.key && nvm.orgId), async () =>
  purchasesFromEvents(await listActivity(nvm, { from: iso(start), to: iso(end), eventType: 'plan.purchased' }), {
    planId: card.nvm_plan_id,
    anonymize,
  }),
);
const nvmTotals = await attempt('nevermined_analytics', !!(nvm.key && nvm.orgId), async () =>
  totalsFromAnalytics(await analytics(nvm, { from: iso(start), to: iso(end - 1) }), card.nvm_plan_id),
);
const salesStripe = await attempt('stripe', !!env.STRIPE_API_KEY, async () =>
  (await fetchSales(env.STRIPE_API_KEY, start, end)).filter((bt) => matchesPlan(bt, card.stripe_match)).map((bt) => toSale(bt, anonymize)),
);
const salesManual = salesStripe ? null : manualSales(date, offset);
if (!salesStripe) sources.manual_card_payments = salesManual ? 'ok' : 'not_found';
const gateway = await attempt('gateway_log', !!(env.GATEWAY_LOG_DIR || env.GATEWAY_LOG_URL), async () =>
  summarizeGatewayLog(await fetchGatewayLog({ dir: env.GATEWAY_LOG_DIR, url: env.GATEWAY_LOG_URL, token: env.GATEWAY_LOG_TOKEN }, start, end)),
);
const latFile = join(ROOT, 'data/latency', `${date}.jsonl`);
const latency = existsSync(latFile) ? parseJsonl(readFileSync(latFile, 'utf8')) : [];
sources.latency_probe = latency.length ? 'ok' : 'not_found';

const detail = {
  page,
  usdc: payments ? { payments, sol_usd: sol } : null,
  card: {
    mode: card.mode,
    purchases_nvm: purchasesNvm,
    sales_stripe: salesStripe,
    sales_manual: salesManual,
    gateway,
    nvm_totals: nvmTotals,
  },
  latency,
};
const daily = buildDaily({ date, config, detail, sources });
save(daily);
console.log(`wrote data/${date}.json`);

// Stripe の入金（着金日）を、まだ分かっていない過去の日に書き足す
if (env.STRIPE_API_KEY) {
  try {
    const since = start - 45 * 86400;
    const arrivals = await fetchPayoutArrivals(env.STRIPE_API_KEY, since, anonymize);
    for (const f of readdirSync(join(ROOT, 'data')).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))) {
      const d = f.slice(0, 10);
      if (d < addDays(date, -45)) continue;
      const old = JSON.parse(readFileSync(dataFile(d), 'utf8'));
      const list = old.detail?.card?.sales_stripe;
      if (!list) continue;
      let changed = false;
      for (const s of list) {
        const at = arrivals[s.txn_hash];
        if (at && s.payout_arrival == null) {
          s.payout_arrival = at;
          s.days_to_payout = Math.round(((at - s.ts) / 86400) * 10) / 10;
          changed = true;
        }
      }
      if (changed) (save(buildDaily({ date: d, config, detail: old.detail, sources: old.sources })), console.log(`payout updated: ${d}`));
    }
  } catch (e) {
    console.error('[stripe payouts]', e.message);
  }
}

console.log(JSON.stringify({ sources, price_check: daily.price_check, external: daily.external, latency: daily.latency }, null, 2));
