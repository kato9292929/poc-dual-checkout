// カード払いの手数料と着金日を Stripe（Nevermined の Stripe Connect の接続アカウント）から読む。
// キーは制限付きの読み取り専用キー（STRIPE_RESTRICTED_KEY。Balance transactions・Payouts の Read）。
// 手数料は「買い手の支払額 − 売り手の受取額」。Stripe の手数料と Nevermined の手数料（2%）の両方を含む。
import { stamp } from './dates.js';

const API = 'https://api.stripe.com/v1';

async function get(path, params, key) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API}${path}?${qs}`, { headers: { authorization: `Bearer ${key}` } });
  const body = await res.json();
  if (!res.ok) throw new Error(`stripe ${path}: ${body.error?.message || res.status}`);
  return body;
}

async function listAll(path, params, key) {
  const out = [];
  let starting_after;
  for (;;) {
    const page = await get(path, { ...params, limit: 100, ...(starting_after ? { starting_after } : {}) }, key);
    out.push(...page.data);
    if (!page.has_more) break;
    starting_after = page.data[page.data.length - 1].id;
  }
  return out;
}

// 直接課金は charge、Connect の destination charge は接続アカウント側で payment
export const SALE_TYPES = new Set(['charge', 'payment']);

export async function fetchSales(key, start, end) {
  const bts = await listAll('/balance_transactions', { 'created[gte]': start, 'created[lt]': end, 'expand[]': 'data.source' }, key);
  return bts.filter((bt) => SALE_TYPES.has(bt.type));
}

export function matchesPlan(bt, match = {}) {
  const src = bt.source || {};
  if (match.metadata_key) {
    const v = src.metadata?.[match.metadata_key];
    if (match.metadata_value ? v !== match.metadata_value : v == null) return false;
  }
  if (match.description_contains && !String(src.description || bt.description || '').includes(match.description_contains)) return false;
  return true;
}

export function withPayout(sale, arrivalSec, offset) {
  if (arrivalSec == null) return { ...sale, payout_arrival_utc: null, payout_date_jst: null, days_to_payout: null };
  const s = stamp(arrivalSec, offset);
  return {
    ...sale,
    payout_arrival_utc: s.time_utc,
    payout_date_jst: s.date_jst,
    days_to_payout: Math.round(((arrivalSec - Date.parse(sale.time_utc) / 1000) / 86400) * 10) / 10,
  };
}

export function toSale(bt, anonymize, offset) {
  const src = bt.source || {};
  const grossCents = typeof src.amount === 'number' ? src.amount : bt.amount;
  return withPayout(
    {
      source: 'api',
      ...stamp(bt.created, offset),
      txn_hash: anonymize(bt.id),
      currency: bt.currency,
      gross_usd: grossCents / 100,
      net_usd: bt.net / 100,
      fee_usd: (grossCents - bt.net) / 100,
    },
    null,
    offset,
  );
}

// 直近に着金した payout と、それに含まれる取引 → { txn_hash: arrival_date(Unix 秒) }
export async function fetchPayoutArrivals(key, sinceSec, anonymize) {
  const payouts = await listAll('/payouts', { 'arrival_date[gte]': sinceSec, status: 'paid' }, key);
  const map = {};
  for (const po of payouts) {
    const bts = await listAll('/balance_transactions', { payout: po.id }, key);
    for (const bt of bts) if (SALE_TYPES.has(bt.type)) map[anonymize(bt.id)] = po.arrival_date;
  }
  return map;
}
