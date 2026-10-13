import { classifyX402Payer, classifyCardToken, countLabels, ownWalletSet } from './classify.js';
import { median } from './dates.js';

const round = (n, d = 6) => (n == null ? null : Math.round(n * 10 ** d) / 10 ** d);

export function findPeriod(period, date) {
  for (const p of period.periods) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.start)) continue;
    const idx = Math.round((Date.parse(date) - Date.parse(p.start)) / 86400000);
    if (idx >= 0 && idx < period.period_days) return { id: p.id, day: idx + 1, of: period.period_days, locked: p };
  }
  return null;
}

// 期間中の価格変更を検知する（変更そのものは禁止。検知したら日次データに残し、レポートで目立たせる）
export function priceCheck(site, p) {
  if (!p) return 'no_period';
  const diffs = [];
  for (const it of site.items) {
    const locked = p.locked.locked_prices_usd?.[it.id];
    if (locked != null && locked !== it.price_usd) diffs.push(`${it.id}: ${locked} → ${it.price_usd}`);
    const viaCard = it.card_credits * site.card.usd_per_credit;
    if (round(viaCard) !== round(it.price_usd)) diffs.push(`${it.id}: card ${viaCard} ≠ x402 ${it.price_usd}`);
  }
  const lc = p.locked.locked_card;
  if (lc && (lc.plan_price_usd !== site.card.plan_price_usd || lc.plan_credits !== site.card.plan_credits)) {
    diffs.push(`plan: ${lc.plan_price_usd}/${lc.plan_credits} → ${site.card.plan_price_usd}/${site.card.plan_credits}`);
  }
  return diffs.length ? `mismatch: ${diffs.join('; ')}` : 'ok';
}

function itemByAmount(site) {
  return Object.fromEntries(site.items.map((i) => [i.x402_amount_atomic, i.id]));
}

function x402Summary(payers, payments, site, rules) {
  const dec = site.x402.asset_decimals;
  const byItem = itemByAmount(site);
  const byEndpoint = {};
  let atomic = 0n;
  let feeAll = 0;
  let feeExcl = 0;
  for (const p of payments) {
    const id = byItem[p.amount_atomic] || 'other';
    byEndpoint[id] = (byEndpoint[id] || 0) + 1;
    atomic += BigInt(p.amount_atomic);
    feeAll += p.fee_lamports;
    feeExcl += p.fee_lamports_excl_facilitator;
  }
  const callsByLabel = Object.fromEntries(rules.labels.map((l) => [l, 0]));
  for (const p of payers) callsByLabel[p.label] += p.payments;
  return {
    payments: payments.length,
    uses: payments.length,
    buyers: payers.length,
    buyers_by_label: countLabels(payers, rules),
    uses_by_label: callsByLabel,
    by_endpoint: byEndpoint,
    revenue_usdc: Number(atomic) / 10 ** dec,
    chain_fee_lamports_total: feeAll,
    chain_fee_lamports_excl_facilitator: feeExcl,
    chain_fee_sol_per_payment_excl_facilitator: payments.length ? round(feeExcl / payments.length / 1e9, 9) : null,
    days_to_settlement: payments.length ? 0 : null,
  };
}

function cardSummary(purchases, tokens, rules) {
  const fee = purchases.reduce((s, p) => s + p.fee_usd, 0);
  const revenue = purchases.reduce((s, p) => s + p.amount_usd, 0);
  const custs = new Set();
  let anon = 0;
  for (const p of purchases) (p.customer_hash ? custs.add(p.customer_hash) : anon++);
  const callsByLabel = Object.fromEntries(rules.labels.map((l) => [l, 0]));
  for (const t of tokens) callsByLabel[t.label] += t.calls;
  return {
    purchases: purchases.length,
    buyers: custs.size + anon,
    revenue_usd: round(revenue, 2),
    credits_consumed: tokens.reduce((s, t) => s + t.credits, 0),
    calls: tokens.reduce((s, t) => s + t.calls, 0),
    active_tokens: tokens.length,
    tokens_by_label: countLabels(tokens, rules),
    calls_by_label: callsByLabel,
    card_fee_usd_total: round(fee, 2),
    card_fee_usd_per_purchase: purchases.length ? round(fee / purchases.length, 4) : null,
    days_to_available_median: median(purchases.map((p) => p.days_to_available)),
  };
}

/**
 * 日次データを組み立てる（純関数）。
 * cardPurchases の customer_hash、cardCalls の token_hash は匿名化済みであること。
 */
export function buildDaily({ date, config, page, x402Payments, cardPurchases, cardCalls, sources }) {
  const { site, period, classify: rules } = config;
  const own = ownWalletSet(rules);
  const ownTokens = new Set(rules.own?.card_token_hashes || []);
  const ownCustomers = new Set(rules.own?.stripe_customer_hashes || []);
  const p = findPeriod(period, date);

  // x402: 支払い元ごとにまとめて判定
  const byPayer = new Map();
  for (const pay of x402Payments || []) {
    const k = pay.payer || 'unknown';
    if (!byPayer.has(k)) byPayer.set(k, []);
    byPayer.get(k).push(pay);
  }
  const payers = [...byPayer].map(([address, list]) => {
    const c = classifyX402Payer(list.map((x) => x.block_time), rules);
    return {
      address,
      own: own.has(address),
      label: c.label,
      reason: c.reason,
      payments: list.length,
      amount_atomic: list.reduce((s, x) => s + BigInt(x.amount_atomic), 0n).toString(),
    };
  });
  const ownAddr = new Set(payers.filter((x) => x.own).map((x) => x.address));
  const isOwnPay = (x) => ownAddr.has(x.payer || 'unknown');

  // カード: 匿名トークンごとにまとめて判定（失敗した呼び出しは数えない）
  const byToken = new Map();
  for (const call of (cardCalls || []).filter((c) => c.status < 400)) {
    const k = call.token_hash || 'unknown';
    if (!byToken.has(k)) byToken.set(k, []);
    byToken.get(k).push(call);
  }
  const tokens = [...byToken].map(([token_hash, list]) => {
    const c = classifyCardToken(list, rules);
    return {
      token_hash,
      own: ownTokens.has(token_hash),
      label: c.label,
      reason: c.reason,
      calls: list.length,
      credits: list.reduce((s, x) => s + x.credits, 0),
    };
  });
  const purchases = cardPurchases || [];
  const isOwnPurchase = (x) => x.customer_hash && ownCustomers.has(x.customer_hash);

  const ext = {
    card: cardSummary(purchases.filter((x) => !isOwnPurchase(x)), tokens.filter((t) => !t.own), rules),
    x402: x402Summary(payers.filter((x) => !x.own), (x402Payments || []).filter((x) => !isOwnPay(x)), site, rules),
  };
  const int = {
    card: cardSummary(purchases.filter(isOwnPurchase), tokens.filter((t) => t.own), rules),
    x402: x402Summary(payers.filter((x) => x.own), (x402Payments || []).filter(isOwnPay), site, rules),
  };

  return {
    schema: 1,
    date,
    timezone: period.timezone,
    period: p ? { id: p.id, day: p.day, of: p.of } : null,
    price_check: priceCheck(site, p),
    classify_version: rules.version,
    generated_at: new Date().toISOString(),
    sources,
    page: page ?? null,
    external: ext,
    internal: int,
    detail: {
      x402_payers: payers,
      x402_payments: (x402Payments || []).map((x) => ({ ...x, own: isOwnPay(x) })),
      card_tokens: tokens,
      card_purchases: purchases.map((x) => ({ ...x, own: !!isOwnPurchase(x) })),
    },
  };
}
