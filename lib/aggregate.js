// 日次データの集計。明細（detail）の各トランザクションを own / external / unclassified に分け、区分ごとに数字を出す。
//   own          config/own_wallets.json に一致（＋実証1ゲートウェイが裏側で JIN を買った支払い）
//   external     config/external_buyers.json に一致（外部と確定したもの）
//   unclassified どちらにも一致しない。自動で external にはしない
// 分類リストを変えたら summarize をやり直すだけで数え直せるように、ここは純関数にしてある。
import { median, percentile } from './dates.js';

export const CLASSES = ['external', 'unclassified', 'own'];

const round = (n, d = 6) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const sum = (arr, f) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const ids = (list) => new Set((list || []).map((x) => (typeof x === 'string' ? x : x?.id ?? x?.address)).filter(Boolean));

export function findPeriod(period, date) {
  for (const p of period.periods) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.start)) continue;
    const idx = Math.round((Date.parse(date) - Date.parse(p.start)) / 86400000);
    if (idx >= 0 && idx < period.period_days) return { id: p.id, day: idx + 1, of: period.period_days, locked: p.locked };
  }
  return null;
}

// 価格の一致（入口どうし・期間の固定値）。変更そのものは禁止。検知したら記録してレポートで目立たせる
export function priceCheck(site, p) {
  const diffs = [];
  const { card } = site;
  if (card.mode !== 'prepaid') diffs.push(`カードの mode が prepaid ではない: ${card.mode}`);
  for (const it of site.items) {
    const viaCard = it.card_credits * card.usd_per_credit;
    if (round(viaCard) !== round(it.price_usd)) diffs.push(`${it.id}: カード ${viaCard} ≠ USDC ${it.price_usd}`);
  }
  if (round(card.plan.plan_price_usd / card.plan.plan_credits) !== round(card.usd_per_credit)) {
    diffs.push(`プラン単価 ${card.plan.plan_price_usd}/${card.plan.plan_credits} ≠ ${card.usd_per_credit}`);
  }
  if (p) {
    const L = p.locked;
    for (const it of site.items) {
      if (L.prices_usd?.[it.id] != null && L.prices_usd[it.id] !== it.price_usd) diffs.push(`${it.id}: ${L.prices_usd[it.id]} → ${it.price_usd}`);
    }
    if (L.plan_price_usd !== card.plan.plan_price_usd || L.plan_credits !== card.plan.plan_credits) {
      diffs.push(`プラン: ${L.plan_price_usd}/${L.plan_credits} → ${card.plan.plan_price_usd}/${card.plan.plan_credits}`);
    }
  }
  if (diffs.length) return `mismatch: ${diffs.join('; ')}`;
  return p ? 'ok' : 'no_period';
}

export function classifier(config, detail) {
  const own = {
    solana: ids(config.own.solana.map((w) => w.address)),
    tokens: ids(config.own.card_token_ids.ids),
    stripe: ids(config.own.stripe_txn_hashes.ids),
    // 実証1のゲートウェイがカード払いの裏側で JIN を買った支払い（ウォレット未登録でも own にする）
    gatewayTxs: new Set((detail.card?.calls || []).map((c) => c.upstream_tx).filter(Boolean)),
  };
  const ext = {
    solana: ids(config.external.solana),
    tokens: ids(config.external.card_token_ids),
    stripe: ids(config.external.stripe_txn_hashes),
  };
  const pick = (isOwn, isExt) => (isOwn ? 'own' : isExt ? 'external' : 'unclassified');
  return {
    usdc: (p) => pick(own.solana.has(p.payer) || own.gatewayTxs.has(p.signature), ext.solana.has(p.payer)),
    call: (c) => pick(own.tokens.has(c.token_id), ext.tokens.has(c.token_id)),
    sale: (s) => pick(own.stripe.has(s.txn_hash), ext.stripe.has(s.txn_hash)),
  };
}

function usdcSummary(payments, site, facilitators) {
  const byAmount = Object.fromEntries(site.items.map((i) => [i.usdc_amount_atomic, i.id]));
  const byItem = {};
  for (const p of payments) byItem[byAmount[p.amount_atomic] || 'other'] = (byItem[byAmount[p.amount_atomic] || 'other'] || 0) + 1;
  const revenue = sum(payments, (p) => p.amount_atomic) / 10 ** site.usdc.asset_decimals;
  // SOL の価格はその支払いの日のもの
  const priced = payments.every((p) => p.sol_usd != null);
  const feeUsd = priced ? sum(payments, (p) => (p.fee_lamports / 1e9) * p.sol_usd) : null;
  const n = payments.length;
  return {
    contracts: n,
    uses: n,
    buyers: new Set(payments.map((p) => p.payer)).size,
    by_item: byItem,
    revenue_usd: round(revenue, 6),
    chain_fee_lamports: sum(payments, (p) => p.fee_lamports),
    chain_fee_usd: round(feeUsd, 6),
    chain_fee_usd_per_contract: n && feeUsd != null ? round(feeUsd / n, 6) : null,
    fee_rate: revenue && feeUsd != null ? round(feeUsd / revenue, 4) : null,
    fee_paid_by_facilitator: payments.filter((p) => facilitators.has(p.fee_payer)).length,
    days_to_settlement: n ? 0 : null,
  };
}

// calls / sales が null ＝ その日は取れなかった。数字も null のまま返す（0 で埋めない）
function cardSummary(calls, sales) {
  const ok = calls ? calls.filter((c) => c.outcome === 'ok') : null;
  const failures = {};
  for (const c of calls || []) if (c.outcome !== 'ok') failures[c.outcome] = (failures[c.outcome] || 0) + 1;
  const lat = (ok || []).map((c) => c.latency_ms).filter((x) => x != null);
  const revenue = sales ? sum(sales, (s) => s.gross_usd) : null;
  const fee = sales ? sum(sales, (s) => s.fee_usd) : null;
  return {
    calls: ok ? ok.length : null,
    uses_credits: ok ? sum(ok, (c) => c.credits) : null,
    buyers: ok ? new Set(ok.map((c) => c.token_id)).size : null,
    failures: calls ? failures : null,
    plan_purchases: sales ? sales.length : null,
    revenue_usd: round(revenue, 2),
    card_fee_usd: round(fee, 2),
    card_fee_usd_per_contract: sales && sales.length ? round(fee / sales.length, 4) : null,
    fee_rate: revenue ? round(fee / revenue, 4) : null,
    days_to_payout_median: sales ? median(sales.filter((s) => s.days_to_payout != null).map((s) => s.days_to_payout)) : null,
    payouts_pending: sales ? sales.filter((s) => s.days_to_payout == null).length : null,
    gateway_latency_ms_p50: percentile(lat, 50),
    gateway_latency_ms_p90: percentile(lat, 90),
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
  const { site } = config;
  const cls = classifier(config, detail);
  const facilitators = new Set(site.usdc.facilitator_fee_payers.map((f) => f.address));
  const pays = detail.usdc ? detail.usdc.payments.map((p) => ({ ...p, class: cls.usdc(p) })) : null;
  const calls = detail.card?.calls ? detail.card.calls.map((c) => ({ ...c, class: cls.call(c) })) : null;
  const sales = detail.card?.sales ? detail.card.sales.map((s) => ({ ...s, class: cls.sale(s) })) : null;
  const of = (list, k) => (list ? list.filter((x) => x.class === k) : null);

  const by_class = {};
  for (const k of CLASSES) {
    by_class[k] = {
      usdc: pays ? usdcSummary(of(pays, k), site, facilitators) : null,
      card: cardSummary(of(calls, k), of(sales, k)),
    };
  }
  return {
    by_class,
    // 区分ごとの支払い元・購入者の一覧（unclassified を人が確認して振り分けるため）
    parties: {
      usdc: pays ? partyList(pays, (p) => p.payer) : null,
      card_tokens: calls ? partyList(calls.filter((c) => c.outcome === 'ok'), (c) => c.token_id) : null,
    },
    latency: latencySummary(detail.latency || []),
    nvm_reconcile_incl_own: detail.card?.nvm ?? null,
  };
}

function partyList(list, key) {
  const m = new Map();
  for (const x of list) {
    const k = key(x);
    if (!m.has(k)) m.set(k, { id: k, class: x.class, count: 0 });
    m.get(k).count++;
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

export function buildDaily({ date, config, detail, sources }) {
  const p = findPeriod(config.period, date);
  return {
    schema: 3,
    date,
    timezone: config.period.timezone,
    window_utc: detail.window_utc ?? null,
    period: p ? { id: p.id, day: p.day, of: p.of } : null,
    price_check: priceCheck(config.site, p),
    classification: { own_wallets_version: config.own.version, external_buyers_version: config.external.version },
    generated_at: new Date().toISOString(),
    sources,
    page: detail.page ?? null,
    ...summarize(detail, config),
    detail,
  };
}

// 複数日の明細を1つにまとめる（週次用）
export function mergeDetails(dailies) {
  const cat = (f) => {
    const parts = dailies.map((d) => f(d.detail));
    return parts.every((x) => x == null) ? null : parts.flatMap((x) => x || []);
  };
  return {
    usdc: dailies.some((d) => d.detail.usdc) ? { payments: cat((x) => x.usdc?.payments) } : null,
    card: { calls: cat((x) => x.card?.calls), sales: cat((x) => x.card?.sales), nvm: null },
    latency: cat((x) => x.latency) || [],
  };
}
