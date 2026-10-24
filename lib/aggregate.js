// 日次データの集計。明細（detail）の各トランザクションを own / external / unclassified に分け、区分ごとに数字を出す。
//   own          config/own_wallets.json に一致（＋実証1ゲートウェイが裏側で JIN を買った支払い）
//   external     config/external_buyers.json に一致（外部と確定したもの）
//   unclassified どちらにも一致しない。自動で external にはしない
// 分類リストを変えたら summarize をやり直すだけで数え直せるように、ここは純関数にしてある。
import { median, percentile } from './dates.js';

export const CLASSES = ['external', 'unclassified', 'own'];

// 日次データの形式の版。fee_payer_role・period_phase・own_candidate を持つ形を 1 とする。
// 形式を変えたら上げ、checkCurrent に条件を足し、node scripts/collect-daily.mjs --upgrade で data/ を数え直す
//   2: 各支払いに product（jin_movers / jin_series / osd / unresolved / other）と product_source を持つ。JIN の成約数は下限〜上限
export const SCHEMA_VERSION = 2;

export const JIN_PRODUCTS = ['jin_movers', 'jin_series'];
export const PRODUCTS = ['jin_movers', 'jin_series', 'unresolved', 'osd', 'other'];

// 支払いがどの商品か。売り手ログ（tx 署名 → エンドポイント）で一致すればそれを使い、無ければ金額で決める。
// 金額 $0.01 は JIN の series と OSD で同じなので、売り手ログが無ければ unresolved
export function attributeProduct(p, site, sellerIndex, gatewayIndex) {
  const hit = sellerIndex?.get(p.signature);
  if (hit) {
    const rule = (site.usdc.endpoint_products || []).find((r) => String(hit.endpoint || '').startsWith(r.prefix));
    return { product: rule ? rule.product : 'other', product_source: `seller_log:${hit.source || 'seller'}` };
  }
  // 実証1のゲートウェイがカード払いの裏側で払ったもの。どの商品を買ったかはゲートウェイのログの routeId で分かる
  const gw = gatewayIndex?.get(p.signature);
  if (gw && gw !== 'other') return { product: gw, product_source: 'gateway_log' };
  const byAmount = site.usdc.amount_products?.[p.amount_atomic] || 'other';
  // 売り手ログがその日そろっていれば（detail.usdc.seller_log_complete）、ログに無い $0.01 は消去法でもう一方の商品
  if (byAmount === 'unresolved' && sellerIndex?.complete === 'osd') return { product: 'jin_series', product_source: 'seller_log_exclusion:osd' };
  if (byAmount === 'unresolved' && sellerIndex?.complete === 'jin') return { product: 'osd', product_source: 'seller_log_exclusion:jin' };
  return { product: byAmount, product_source: 'amount' };
}

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

// その日が計測期間のどこにあるか。レポートは保存値ではなく、毎回いまの period.json から求め直す
//   no_period    開始日がまだ入っていない
//   pre_period   最初の期間の開始日より前（期間前。本表に入れない）
//   in_period    期間中
//   post_period  最後の期間の後
export function periodPhase(period, date) {
  const starts = period.periods.map((p) => p.start).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!starts.length) return 'no_period';
  if (findPeriod(period, date)) return 'in_period';
  return date < starts[0] ? 'pre_period' : 'post_period';
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
    payers: ids(config.own.card_payer_ids?.ids),
    stripe: ids(config.own.stripe_txn_hashes.ids),
    nvmUsers: ids(config.own.nvm_user_hashes?.ids),
    // 実証1のゲートウェイがカード払いの裏側で JIN を買った支払い（ウォレット未登録でも own にする）
    gatewayTxs: new Set((detail.card?.calls || []).map((c) => c.upstream_tx).filter(Boolean)),
  };
  const ext = {
    solana: ids(config.external.solana),
    tokens: ids(config.external.card_token_ids),
    payers: ids(config.external.card_payer_ids),
    stripe: ids(config.external.stripe_txn_hashes),
    nvmUsers: ids(config.external.nvm_user_hashes),
  };
  const pick = (isOwn, isExt) => (isOwn ? 'own' : isExt ? 'external' : 'unclassified');
  return {
    usdc: (p) => pick(own.solana.has(p.payer) || own.gatewayTxs.has(p.signature), ext.solana.has(p.payer)),
    call: (c) => pick(own.payers.has(c.payer_id) || own.tokens.has(c.token_id), ext.payers.has(c.payer_id) || ext.tokens.has(c.token_id)),
    sale: (s) => pick(own.stripe.has(s.txn_hash), ext.stripe.has(s.txn_hash)),
    purchase: (e) => pick(own.nvmUsers.has(e.buyer_hash), ext.nvmUsers.has(e.buyer_hash)),
  };
}

// tx のチェーン手数料を誰が払ったか
export function feePayerRole(p, site) {
  if (site.usdc.facilitator_fee_payers.some((f) => f.address === p.fee_payer)) return 'facilitator';
  if (p.fee_payer === site.usdc.pay_to || (site.usdc.seller_fee_payers || []).some((f) => (f.address ?? f) === p.fee_payer)) return 'seller';
  if (p.fee_payer === p.payer) return 'buyer';
  return 'other';
}

export const FEE_ROLES = ['seller', 'facilitator', 'buyer', 'other'];

function usdcSummary(payments, site) {
  const dec = 10 ** site.usdc.asset_decimals;
  const by_product = Object.fromEntries(PRODUCTS.map((k) => [k, 0]));
  for (const p of payments) by_product[p.product] = (by_product[p.product] || 0) + 1;
  const jin = payments.filter((p) => JIN_PRODUCTS.includes(p.product));
  const jinOrUnresolved = payments.filter((p) => JIN_PRODUCTS.includes(p.product) || p.product === 'unresolved');
  const revenueOf = (list) => sum(list, (p) => p.amount_atomic) / dec;
  const paytoRevenue = revenueOf(payments);
  const n = payments.length;
  // チェーン手数料は入口（受取口座）の性質なので、商品に関係なく受取口座への入金すべてで数える
  const feeOf = (list) => (list.every((p) => p.sol_usd != null) ? sum(list, (p) => (p.fee_lamports / 1e9) * p.sol_usd) : null);
  const fee_by_payer = {};
  for (const r of FEE_ROLES) {
    const list = payments.filter((p) => p.fee_payer_role === r);
    fee_by_payer[r] = { txs: list.length, lamports: sum(list, (p) => p.fee_lamports), usd: round(feeOf(list), 6) };
  }
  const sellerUsd = fee_by_payer.seller.usd;
  return {
    // JIN の成約数：下限は商品が確定したものだけ、上限は unresolved（JIN の series か OSD）も含める
    jin_contracts_min: jin.length,
    jin_contracts_max: jinOrUnresolved.length,
    unresolved: by_product.unresolved,
    by_product,
    jin_buyers_min: new Set(jin.map((p) => p.payer)).size,
    jin_buyers_max: new Set(jinOrUnresolved.map((p) => p.payer)).size,
    jin_revenue_usd_min: round(revenueOf(jin), 6),
    jin_revenue_usd_max: round(revenueOf(jinOrUnresolved), 6),
    // 受取口座への入金すべて（OSD を含む）
    payto_inflows: n,
    payto_revenue_usd: round(paytoRevenue, 6),
    // 売る側の手数料：seller が払った分だけ（受取口座への入金すべてに対して）
    seller_fee_usd: sellerUsd,
    seller_fee_usd_per_tx: n && sellerUsd != null ? round(sellerUsd / n, 6) : null,
    seller_fee_rate: paytoRevenue && sellerUsd != null ? round(sellerUsd / paytoRevenue, 4) : null,
    // 参考値：facilitator が払った分
    facilitator_fee_usd: fee_by_payer.facilitator.usd,
    facilitator_fee_rate: paytoRevenue && fee_by_payer.facilitator.usd != null ? round(fee_by_payer.facilitator.usd / paytoRevenue, 4) : null,
    fee_by_payer,
    days_to_settlement: n ? 0 : null,
  };
}

// calls / sales が null ＝ その日は取れなかった。数字も null のまま返す（0 で埋めない）
// 買い手の識別子。payer_id が無い古い明細だけ token_id（購入ごとに変わるので買い手数は多めに出る）
const buyerKey = (c) => c.payer_id ?? c.token_id;

// calls は入口の比較に使う商品（card.products）の行だけ数える。全商品の成約は calls_by_product
function cardSummary(allCalls, sales, purchases, source, products) {
  const calls = allCalls ? allCalls.filter((c) => products.includes(c.product)) : null;
  const ok = calls ? calls.filter((c) => c.outcome === 'ok') : null;
  const failures = {};
  for (const c of calls || []) if (c.outcome !== 'ok') failures[c.outcome] = (failures[c.outcome] || 0) + 1;
  const byProduct = {};
  for (const c of allCalls || []) if (c.outcome === 'ok') byProduct[c.product] = (byProduct[c.product] || 0) + 1;
  const lat = (ok || []).map((c) => c.latency_ms).filter((x) => x != null);
  const upLat = (ok || []).map((c) => c.upstream_latency_ms).filter((x) => x != null);
  const revenue = sales ? sum(sales, (s) => s.gross_usd) : null;
  const fee = sales ? sum(sales, (s) => s.fee_usd) : null;
  return {
    calls: ok ? ok.length : null,
    calls_products: products,
    calls_by_product: allCalls ? byProduct : null,
    uses_credits: ok ? sum(ok, (c) => c.credits) : null,
    buyers: ok ? new Set(ok.map(buyerKey)).size : null,
    failures: calls ? failures : null,
    // 上流（JIN）には払ったがクレジットを消費できなかった回数。成約（calls）には入れない
    settle_failed: calls ? failures.settle_failed || 0 : null,
    // プラン購入件数の主系は card.purchase_source（stripe / nvm_events）。もう一方は照合用
    plan_purchases: source === 'nvm_events' ? (purchases ? purchases.length : null) : sales ? sales.length : null,
    plan_purchases_source: source,
    plan_purchases_stripe: sales ? sales.length : null,
    plan_purchases_nvm_events: purchases ? purchases.length : null,
    revenue_usd: round(revenue, 2),
    card_fee_usd: round(fee, 2),
    card_fee_usd_per_contract: sales && sales.length ? round(fee / sales.length, 4) : null,
    fee_rate: revenue ? round(fee / revenue, 4) : null,
    days_to_payout_median: sales ? median(sales.filter((s) => s.days_to_payout != null).map((s) => s.days_to_payout)) : null,
    payouts_pending: sales ? sales.filter((s) => s.days_to_payout == null).length : null,
    gateway_latency_ms_p50: percentile(lat, 50),
    gateway_latency_ms_p90: percentile(lat, 90),
    upstream_latency_ms_p50: percentile(upLat, 50),
    upstream_latency_ms_p90: percentile(upLat, 90),
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

export function summarize(detail, config, date = null) {
  const { site } = config;
  const cls = classifier(config, detail);
  const sellerIndex = sellerLogIndex(detail);
  const gwIndex = gatewayIndex(detail, site);
  const pays = detail.usdc
    ? detail.usdc.payments.map((p) => ({ ...p, fee_payer_role: feePayerRole(p, site), ...attributeProduct(p, site, sellerIndex, gwIndex), class: cls.usdc(p) }))
    : null;
  const routes = site.card.route_products || {};
  const calls = detail.card?.calls ? detail.card.calls.map((c) => ({ ...c, product: routes[c.route_id] || 'other', class: cls.call(c) })) : null;
  const sales = detail.card?.sales ? detail.card.sales.map((s) => ({ ...s, class: cls.sale(s) })) : null;
  const purchases = detail.card?.nvm_purchases ? detail.card.nvm_purchases.map((e) => ({ ...e, class: cls.purchase(e) })) : null;
  const source = site.card.purchase_source || 'stripe';
  const of = (list, k) => (list ? list.filter((x) => x.class === k) : null);

  const by_class = {};
  for (const k of CLASSES) {
    by_class[k] = {
      usdc: pays ? usdcSummary(of(pays, k), site) : null,
      card: cardSummary(of(calls, k), of(sales, k), of(purchases, k), source, site.card.products || ['jin_series']),
    };
  }
  return {
    by_class,
    // 区分ごとの支払い元・購入者の一覧（unclassified を人が確認して振り分けるため）
    parties: {
      usdc: pays ? partyList(pays, (p) => p.payer, candidateNotes(config)) : null,
      card_payers: calls ? partyList(calls.filter((c) => c.outcome === 'ok'), buyerKey) : null,
    },
    latency: latencySummary(detail.latency || []),
    gateway_upstream: gatewayUpstream(pays, calls, config, date),
    nvm_reconcile_incl_own: detail.card?.nvm ?? null,
  };
}

// 実証1のゲートウェイのウォレットから JIN への支払い（チェーン側）と、ゲートウェイのログの照合。
// ログが欠けた日（config の card.known_gaps）も、チェーン側の件数で上流への支払い回数が分かる
function gatewayUpstream(pays, calls, config, date) {
  const addrs = new Set(config.own.solana.filter((w) => w.role === 'card_gateway' && w.address).map((w) => w.address));
  if (!addrs.size || !pays) return null;
  const chain = pays.filter((p) => addrs.has(p.payer));
  const by_product = {};
  for (const p of chain) by_product[p.product] = (by_product[p.product] || 0) + 1;
  const logged = calls ? new Set(calls.map((c) => c.upstream_tx).filter(Boolean)) : null;
  const countBy = (outcome) => {
    if (!calls) return null;
    const o = {};
    for (const c of calls) if (c.outcome === outcome) o[c.product] = (o[c.product] || 0) + 1;
    return o;
  };
  const gap = (config.site.card.known_gaps || []).find((g) => g.date === date);
  return {
    chain_payments: chain.length,
    by_product,
    log_calls_ok: calls ? calls.filter((c) => c.outcome === 'ok').length : null,
    log_settle_failed: calls ? calls.filter((c) => c.outcome === 'settle_failed').length : null,
    log_ok_by_product: countBy('ok'),
    log_settle_failed_by_product: countBy('settle_failed'),
    chain_not_in_log: logged ? chain.filter((p) => !logged.has(p.signature)).length : null,
    known_gap: gap ?? null,
  };
}

// own 候補の注記（照合には使わない）
function candidateNotes(config) {
  const m = {};
  for (const c of config.own.candidates?.solana || []) m[c.address] = `own 候補（${c.likely}）: ${c.note_short || c.reason}。確定: ${c.confirm_when}`;
  return m;
}

function partyList(list, key, notes = {}) {
  const m = new Map();
  for (const x of list) {
    const k = key(x);
    if (!m.has(k)) m.set(k, { id: k, class: x.class, count: 0, ...(notes[k] && x.class !== 'own' ? { note: notes[k] } : {}) });
    m.get(k).count++;
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

export function buildDaily({ date, config, detail, sources }) {
  const p = findPeriod(config.period, date);
  if (detail.usdc) {
    // 各トランザクションに、手数料の負担者と own 候補の注記を付ける（候補は照合には使わない）
    const cands = Object.fromEntries((config.own.candidates?.solana || []).map((c) => [c.address, c]));
    const ownSet = new Set(config.own.solana.map((w) => w.address).filter(Boolean));
    const sellerIndex = sellerLogIndex(detail);
    const gwIndex = gatewayIndex(detail, config.site);
    detail = {
      ...detail,
      usdc: {
        ...detail.usdc,
        payments: detail.usdc.payments.map(({ own_candidate, ...x }) => {
          const c = !ownSet.has(x.payer) && cands[x.payer];
          return {
            ...x,
            fee_payer_role: feePayerRole(x, config.site),
            ...attributeProduct(x, config.site, sellerIndex, gwIndex),
            ...(c ? { own_candidate: { likely: c.likely, note: c.note_short } } : {}),
          };
        }),
      },
    };
  }
  return {
    schema_version: SCHEMA_VERSION,
    schema: 3,
    date,
    timezone: config.period.timezone,
    window_utc: detail.window_utc ?? null,
    period: p ? { id: p.id, day: p.day, of: p.of } : null,
    period_phase: periodPhase(config.period, date),
    price_check: priceCheck(config.site, p),
    classification: { own_wallets_version: config.own.version, external_buyers_version: config.external.version },
    generated_at: new Date().toISOString(),
    sources,
    page: detail.page ?? null,
    ...summarize(detail, config, date),
    detail,
  };
}

// ゲートウェイのログの upstream_tx → 商品（card.route_products）
export function gatewayIndex(detail, site) {
  const routes = site.card?.route_products || {};
  return new Map((detail.card?.calls || []).filter((c) => c.upstream_tx).map((c) => [c.upstream_tx, routes[c.route_id] || 'other']));
}

// その日の売り手ログを「すべて含む」とみなせるか（消去法に使ってよいか）。
// ログが取れていて、かつ売り手が記録を始めた日（usdc.seller_log_since）以降のときだけ、売り手（jin / osd）を返す
export function sellerLogCompleteFor(site, date, fetchedOk) {
  const since = site.usdc.seller_log_since;
  if (!fetchedOk || !site.usdc.seller_log_covers) return null;
  if (!since || !/^\d{4}-\d{2}-\d{2}$/.test(since) || date < since) return null;
  return site.usdc.seller_log_covers;
}

// 売り手ログ（と外部の公開情報）の tx 署名 → エンドポイント
export function sellerLogIndex(detail) {
  const m = new Map();
  for (const r of detail.usdc?.seller_log || []) if (r.tx_signature) m.set(r.tx_signature, r);
  m.complete = detail.usdc?.seller_log_complete || null;
  return m;
}

// 複数日の明細を1つにまとめる（週次用）
export function mergeDetails(dailies) {
  const cat = (f) => {
    const parts = dailies.map((d) => f(d.detail));
    return parts.every((x) => x == null) ? null : parts.flatMap((x) => x || []);
  };
  return {
    usdc: dailies.some((d) => d.detail.usdc) ? { payments: cat((x) => x.usdc?.payments), seller_log: cat((x) => x.usdc?.seller_log) } : null,
    card: { calls: cat((x) => x.card?.calls), sales: cat((x) => x.card?.sales), nvm_purchases: cat((x) => x.card?.nvm_purchases), nvm: null },
    latency: cat((x) => x.latency) || [],
  };
}

// 日次データが現行の形式かを調べる。問題の一覧を返す（空なら現行）
export function checkCurrent(daily, config) {
  const bad = [];
  if (daily.schema_version !== SCHEMA_VERSION) bad.push(`schema_version が ${daily.schema_version} （現行は ${SCHEMA_VERSION}）`);
  if (!daily.period_phase) bad.push('period_phase が無い');
  if (!daily.by_class) bad.push('by_class が無い');
  const cands = new Set((config.own.candidates?.solana || []).map((c) => c.address));
  const own = new Set(config.own.solana.map((w) => w.address).filter(Boolean));
  for (const p of daily.detail?.usdc?.payments || []) {
    if (!p.fee_payer_role) bad.push(`${p.signature?.slice(0, 10)}: fee_payer_role が無い`);
    if (!p.product || !p.product_source) bad.push(`${p.signature?.slice(0, 10)}: product が無い`);
    if (!p.time_utc || !p.date_jst) bad.push(`${p.signature?.slice(0, 10)}: time_utc / date_jst が無い`);
    if (cands.has(p.payer) && !own.has(p.payer) && !p.own_candidate) bad.push(`${p.signature?.slice(0, 10)}: own 候補の注記（own_candidate）が無い`);
    if (own.has(p.payer) && p.own_candidate) bad.push(`${p.signature?.slice(0, 10)}: own に確定済みなのに own_candidate が残っている`);
  }
  // 分類リストが変わったのに数え直していない
  if (daily.classification?.own_wallets_version !== config.own.version) bad.push(`own_wallets v${daily.classification?.own_wallets_version} で集計（現行 v${config.own.version}）`);
  if (daily.classification?.external_buyers_version !== config.external.version) bad.push(`external_buyers v${daily.classification?.external_buyers_version} で集計（現行 v${config.external.version}）`);
  return bad;
}
