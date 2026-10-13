#!/usr/bin/env node
// 日次集計: node scripts/collect-daily.mjs [--date YYYY-MM-DD]
// 既定は JST の前日。結果を data/YYYY-MM-DD.json に保存する。
// 取れなかったソースは sources に理由を残し、その項目は空のまま保存する（推測で埋めない）。
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ROOT } from '../lib/config.js';
import { dayBounds, yesterday } from '../lib/dates.js';
import { fetchPayments, DEFAULT_RPC } from '../lib/solana.js';
import { fetchChargeTransactions, matchesPlan, toPurchase } from '../lib/stripe.js';
import { fetchUsage } from '../lib/gateway.js';
import { anonymize } from '../lib/anon.js';
import { buildDaily } from '../lib/aggregate.js';

const args = process.argv.slice(2);
const argDate = args.includes('--date') ? args[args.indexOf('--date') + 1] : null;
const env = process.env;
const config = loadConfig();
const offset = config.period.utc_offset;
const date = argDate || yesterday(offset);
const { start, end } = dayBounds(date, offset);
const sources = {};

async function attempt(name, enabled, fn) {
  if (!enabled) {
    sources[name] = 'not_configured';
    return null;
  }
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

const page = await attempt('page', env.STATS_URL && env.STATS_TOKEN, async () => {
  const u = new URL(env.STATS_URL);
  u.searchParams.set('date', date);
  const res = await fetch(u, { headers: { authorization: `Bearer ${env.STATS_TOKEN}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
});

const x402Payments = await attempt('x402_chain', true, () =>
  fetchPayments(env.SOLANA_RPC_URL || DEFAULT_RPC, {
    payTo: config.site.x402.pay_to,
    mint: config.site.x402.asset,
    start,
    end,
    facilitatorFeePayers: config.classify.x402.facilitator_fee_payers,
  }),
);

const cardPurchases = await attempt('stripe', !!env.STRIPE_API_KEY, async () => {
  const bts = await fetchChargeTransactions(env.STRIPE_API_KEY, start, end);
  return bts
    .filter((bt) => matchesPlan(bt, config.site.card.stripe_match))
    .map(toPurchase)
    .map(({ customer, ...rest }) => ({ ...rest, customer_hash: anonymize(customer) }));
});

const cardCalls = await attempt('gateway', !!env.GATEWAY_USAGE_URL, async () => {
  const calls = await fetchUsage(env.GATEWAY_USAGE_URL, env.GATEWAY_USAGE_TOKEN, start, end);
  return calls.map(({ token, ...rest }) => ({ ...rest, token_hash: anonymize(token) }));
});

const daily = buildDaily({ date, config, page, x402Payments, cardPurchases, cardCalls, sources });
mkdirSync(join(ROOT, 'data'), { recursive: true });
const out = join(ROOT, 'data', `${date}.json`);
writeFileSync(out, JSON.stringify(daily, null, 2) + '\n');
console.log(`wrote ${out}`);
console.log(JSON.stringify({ sources, external: daily.external, price_check: daily.price_check }, null, 2));
