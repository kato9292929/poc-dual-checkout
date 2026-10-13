// 日次データの集計。明細（detail）から、除外リストを当てて external / internal の数字を出す。
// 除外リストを変えたら summarize をやり直すだけで数え直せるように、ここは純関数にしてある。
import { median, percentile } from './dates.js';

const round = (n, d = 6) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const sum = (arr, f) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const real = (list) => (list || []).filter((x) => x && !String(x).startsWith('TODO'));

export function findPeriod(period, date) {
  for (const p of period.periods) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.start)) continue;
    const idx = Math.round((Date.parse(date) - Date.parse(p.start)) / 86400000);
    if (idx >= 0 && idx < period.period_days) return { id: p.id, day: idx + 1, of: period.period_days, locked: p.locked };
  }
  return null;
}

// 価格の一致（入口どうし・期間の固定値）を確認する。変更そのものは禁止。検知したら記録してレポートで目立たせる
export function priceCheck(site, p) {
  const diffs = [];
  const card = site.card;
  const mode = card.modes[card.mode];
  for (const it of site.items) {
    const viaCard = it.card_credits * card.usd_per_credit;
    if (round(viaCard) !== round(it.price_usd)) diffs.push(`${it.id}: カード ${viaCard} ≠ USDC ${it.price_usd}`);
  }
  if (card.mode === 'prepaid' && round(mode.plan_price_usd / mode.plan_credits) !== round(card.usd_per_credit)) {
    diffs.push(`プラン単価 ${mode.plan_price_usd}/${mode.plan_credits} ≠ ${card.usd_per_credit}`);
  }
  if (p) {
    const L = p.locked;
    for (const it of site.items) {
      if (L.prices_usd?.[it.id] != null && L.prices_usd[it.id] !== it.price_usd) diffs.push(`${it.id}: ${L.prices_usd[it.id]} → ${it.price_usd}`);
    }
    if (L.card_mode && !L.card_mode.startsWith('TODO') && L.card_mode !== card.mode) diffs.push(`カードの mode: ${L.card_mode} → ${card.mode}`);
    if (card.mode === 'prepaid' && (L.plan_price_usd !== mode.plan_price_usd || L.plan_credits !== mode.plan_credits)) {
      diffs.push(`プラン: ${L.plan_price_usd}/${L.plan_credits} → ${mode.plan_price_usd}/${mode.plan_credits}`);
    }
  }
  if (diffs.length) return `mismatch: ${diffs.join('; ')}`;
  return p ? 'ok' : 'no_period';
}

export function ownSets(ex, detail) {
  return {
    wallets: new Set(real(ex.usdc_wallets.map((w) => w.address))),
    gatewayTxs: new Set(detail.card?.gateway?.upstream_txs || []),
    facilitators: new Set(ex.facilitator_fee_payers.map((f) => f.address)),
    nvmUsers: new Set(ex.card_buyers.nvm_user_hashes),
    gatewayPayers: new Set(ex.card_buyers.gateway_payer_ids),
    stripeTxns: new Set(ex.card_buyers.stripe_txn_hashes),
    window: ex.own_purchase_match_window_sec,
  };
}

export function isOwnUsdc(p, own) {
  return own.wallets.has(p.payer) || own.gatewayTxs.has(p.signature);
}

function usdcSummary(payments, site, solUsd) {
  const byItem = Object.fromEntries(site.items.map((i) => [i.usdc_amount_atomic, i.id]));
  const byEndpoint = {};
  for (const p of payments) {
    const id = byItem[p.amount_atomic] || 'other';
    byEndpoint[id] = (byEndpoint[id] || 0) + 1;
  }
  const revenue = sum(payments, (p) => p.amount_atomic) / 10 ** site.usdc.asset_decimals;
  const lamports = sum(payments, (p) => p.fee_lamports);
  // SOL の価格はその支払いの日のもの（週次では日ごとに違う）
  const priced = payments.every((p) => (p.sol_usd ?? solUsd) != null);
  const feeUsd = priced ? sum(payments, (p) => (p.fee_lamports / 1e9) * (p.sol_usd ?? solUsd)) : null;
  const n = payments.length;
  return {
    contracts: n,
    uses: n,
    buyers: new Set(payments.map((p) => p.payer)).size,
    by_item: byEndpoint,
    revenue_usd: round(revenue, 6),
    chain_fee_lamports: lamports,
    chain_fee_usd: round(feeUsd, 6),
    chain_fee_usd_per_contract: n && feeUsd != null ? round(feeUsd / n, 6) : null,
    fee_rate: revenue && feeUsd != null ? round(feeUsd / revenue, 4) : null,
    fee_paid_by_facilitator: payments.filter((p) => p.fee_by_facilitator).length,
    days_to_settlement: n ? 0 : null,
  };
}

function cardSummary({ mode, purchases, sales, payers }, site) {
  const perCall = mode === 'per_call';
  // 都度払いでは Stripe の取引は1コールごとの課金なので、プラン購入には数えない
  const plan = purchases ? purchases.length : perCall ? 0 : sales ? sales.filter((s) => (s.kind || 'plan') === 'plan').length : null;
  const calls = payers ? sum(payers, (p) => p.calls_ok) : null;
  const perCallPayments = perCall ? calls : 0;
  const revenue = sales ? sum(sales, (s) => s.gross_usd) : null;
  const fee = sales ? sum(sales, (s) => s.fee_usd) : null;
  const latencies = payers ? payers.flatMap((p) => p.latency_ms) : [];
  let buyers = null;
  if (perCall && payers) buyers = new Set(payers.filter((p) => p.calls_ok > 0).map((p) => p.payer_id)).size;
  else if (purchases) buyers = new Set(purchases.map((p) => p.buyer_hash)).size;
  else if (sales) buyers = sales.length;
  const unknown = perCall ? calls == null : plan == null;
  const contracts = unknown ? null : (plan || 0) + (perCallPayments || 0);
  return {
    contracts,
    plan_purchases: plan,
    per_call_payments: perCallPayments,
    uses_credits: payers ? sum(payers, (p) => p.credits) : null,
    calls,
    buyers,
    revenue_usd: round(revenue, 2),
    card_fee_usd: round(fee, 2),
    card_fee_usd_per_contract: sales && sales.length ? round(fee / sales.length, 4) : null,
    fee_rate: revenue ? round(fee / revenue, 4) : null,
    days_to_payout_median: median(sales ? sales.filter((s) => s.days_to_payout != null).map((s) => s.days_to_payout) : []),
    payouts_pending: sales ? sales.filter((s) => s.days_to_payout == null).length : null,
    gateway_latency_ms_p50: percentile(latencies, 50),
    gateway_latency_ms_p90: percentile(latencies, 90),
    gateway_failures: payers ? payers.reduce((o, p) => { for (const [k, v] of Object.entries(p.failures)) o[k] = (o[k] || 0) + v; return o; }, {}) : null,
  };
}

function latencySummary(recs) {
  const out = {};
  for (const entry of ['usdc', 'card']) {
    const all = recs.filter((r) => r.entry === entry && !r.skipped);
    const ok = all.filter((r) => r.ok);
    const t = ok.map((r) => r.total_ms);
    out[entry] = {
      runs: all.length,
      ok: ok.length,
      skipped: recs.filter((r) => r.entry === entry && r.skipped).length,
      total_ms_p50: percentile(t, 50),
      total_ms_p90: percentile(t, 90),
      first_402_ms_median: median(ok.map((r) => r.first_ms)),
      sign_ms_median: median(ok.map((r) => r.sign_ms)),
      paid_request_ms_median: median(ok.map((r) => r.paid_ms)),
    };
  }
  return out;
}

export function summarize(detail, config) {
  const { site, exclusions: ex } = config;
  const own = ownSets(ex, detail);
  const c = detail.card || {};

  // USDC 直接
  const pays = (detail.usdc?.payments || []).map((p) => ({ ...p, fee_by_facilitator: own.facilitators.has(p.fee_payer) }));
  const solUsd = detail.usdc?.sol_usd?.usd ?? null;

  // カード払い：自社の購入時刻（Stripe の取引を自社分と突き合わせるのに使う）
  const purchases = c.purchases_nvm || null;
  const ownPurchaseTs = (purchases || []).filter((p) => own.nvmUsers.has(p.buyer_hash)).map((p) => p.ts);
  // 1日の中ではどちらか一方。週次でまとめたときは両方ありうる
  const sales = c.sales_stripe || c.sales_manual ? [...(c.sales_stripe || []), ...(c.sales_manual || [])] : null;
  const isOwnSale = (s) =>
    s.own === true || (s.txn_hash && own.stripeTxns.has(s.txn_hash)) || ownPurchaseTs.some((t) => Math.abs(t - s.ts) <= own.window);
  const payers = c.gateway?.payers || null;
  const isOwnPayer = (p) => own.gatewayPayers.has(p.payer_id);
  const split = (list, f, want) => (list ? list.filter((x) => !!f(x) === want) : null);

  const scope = (want) => ({
    usdc: detail.usdc ? usdcSummary(pays.filter((p) => isOwnUsdc(p, own) === want), site, solUsd) : null,
    card: cardSummary(
      {
        mode: c.mode,
        purchases: split(purchases, (p) => own.nvmUsers.has(p.buyer_hash), want),
        sales: split(sales, isOwnSale, want),
        payers: split(payers, isOwnPayer, want),
      },
      site,
    ),
  });

  return {
    external: scope(false),
    internal: scope(true),
    latency: latencySummary(detail.latency || []),
    card_sources: {
      purchases: purchases ? 'nevermined' : sales ? [c.sales_stripe && 'stripe', c.sales_manual && 'manual'].filter(Boolean).join('+') : null,
      fees: [c.sales_stripe && 'stripe', c.sales_manual && 'manual'].filter(Boolean).join('+') || null,
      uses: payers ? 'gateway' : null,
    },
    nevermined_org_totals_incl_own: c.nvm_totals || null,
  };
}

export function buildDaily({ date, config, detail, sources }) {
  const p = findPeriod(config.period, date);
  return {
    schema: 2,
    date,
    timezone: config.period.timezone,
    period: p ? { id: p.id, day: p.day, of: p.of } : null,
    card_mode: config.site.card.mode,
    price_check: priceCheck(config.site, p),
    exclusions_version: config.exclusions.version,
    generated_at: new Date().toISOString(),
    sources,
    page: detail.page ?? null,
    ...summarize(detail, config),
    detail,
  };
}

// 複数日の明細を1つにまとめる（週次用）。SOL の価格は支払いごとに持たせる
export function mergeDetails(dailies) {
  const cat = (f) => {
    const parts = dailies.map((d) => f(d.detail));
    return parts.every((x) => x == null) ? null : parts.flatMap((x) => x || []);
  };
  return {
    usdc: dailies.some((d) => d.detail.usdc)
      ? { payments: dailies.flatMap((d) => (d.detail.usdc?.payments || []).map((p) => ({ ...p, sol_usd: d.detail.usdc?.sol_usd?.usd ?? null }))), sol_usd: null }
      : null,
    card: {
      mode: dailies.at(-1)?.detail.card?.mode,
      purchases_nvm: cat((x) => x.card?.purchases_nvm),
      sales_stripe: cat((x) => x.card?.sales_stripe),
      sales_manual: cat((x) => x.card?.sales_manual),
      gateway: dailies.some((d) => d.detail.card?.gateway)
        ? { payers: cat((x) => x.card?.gateway?.payers), upstream_txs: cat((x) => x.card?.gateway?.upstream_txs) }
        : null,
      nvm_totals: null,
    },
    latency: cat((x) => x.latency) || [],
  };
}
