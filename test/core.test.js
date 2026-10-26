import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dayBounds, localDate, isoWeek, weekDays, yesterday, percentile, stamp } from '../lib/dates.js';
import { parsePayment } from '../lib/solana.js';
import { buildDaily, priceCheck, findPeriod } from '../lib/aggregate.js';
import { renderWeekly } from '../lib/report.js';
import { eventKey, statsKeys, statsFromValues, isBot } from '../lib/track.js';
import { matchesPlan, toSale } from '../lib/stripe.js';
import { salesFromCsv, checkHeader } from '../lib/stripe-csv.js';
import { parseJsonl, toCalls, fetchGatewayLog, upstreamErrorCode } from '../lib/gateway.js';
import { summarizeReconcile, assertOrgId, reconcile } from '../lib/nevermined.js';
import { refuseUsdc, measureCard } from '../lib/probe.js';
import { anonymize } from '../lib/anon.js';
import { loadConfig } from '../lib/config.js';

const PAY_TO = '4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FAC = 'CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww';
const fixture = (f) => new URL(`./fixtures/${f}`, import.meta.url);
const anon = (v) => anonymize(v, 'test-salt');

function cfg({ start = '2026-11-02', ownWallets = [], ownTokens = [], extWallets = [], extTokens = [], ownTxns = [], extTxns = [] } = {}) {
  const c = structuredClone(loadConfig());
  c.period.periods[0].start = start;
  c.own.solana = ownWallets.map((address) => ({ address, label: 'own' }));
  c.own.card_token_ids.ids = ownTokens;
  c.own.stripe_txn_hashes.ids = ownTxns;
  c.external.solana = extWallets.map((id) => ({ id, confirmed_on: '2026-11-01', evidence: 'test' }));
  c.external.card_token_ids = extTokens.map((id) => ({ id }));
  c.external.stripe_txn_hashes = extTxns.map((id) => ({ id }));
  return c;
}

test('JST の日境界・ISO 週・パーセンタイル', () => {
  const { start, end } = dayBounds('2026-10-13', '+09:00');
  assert.equal(new Date(start * 1000).toISOString(), '2026-10-12T15:00:00.000Z');
  assert.equal(end - start, 86400);
  assert.equal(localDate(start - 1, '+09:00'), '2026-10-12');
  assert.equal(isoWeek('2026-10-13').label, '2026-W42');
  assert.deepEqual(weekDays('2026-W42'), isoWeek('2026-10-13').days);
  assert.equal(weekDays('2026-W01')[0], '2025-12-29');
  assert.equal(yesterday('+09:00', Date.parse('2026-10-12T16:00:00Z')), '2026-10-12');
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([], 50), null);
  assert.deepEqual(stamp(Date.parse('2026-10-12T15:30:00Z') / 1000), { time_utc: '2026-10-12T15:30:00.000Z', date_jst: '2026-10-13' });
});

test('payTo への USDC 入金を取り出す', () => {
  const tx = JSON.parse(readFileSync(fixture('tx-payment.json')));
  const p = parsePayment(tx, { payTo: PAY_TO, mint: USDC });
  assert.equal(p.payer, 'BuyerWa11et111111111111111111111111111111111');
  assert.equal(p.amount_atomic, '20000');
  assert.equal(p.fee_lamports, 10001);
  assert.equal(p.fee_payer, FAC);
  assert.equal(parsePayment(tx, { payTo: 'BuyerWa11et111111111111111111111111111111111', mint: USDC }), null);
});

test('ページ計測: 閲覧と、各入口の説明を開いた回数', () => {
  const now = Date.parse('2026-10-13T15:30:00Z') / 1000; // JST 10/14 00:30
  assert.equal(eventKey({ e: 'view' }, now), 'jin:2026-10-14:view');
  assert.equal(eventKey({ e: 'open', i: 'usdc' }, now), 'jin:2026-10-14:open:usdc');
  assert.equal(eventKey({ e: 'open', i: 'x' }, now), null);
  assert.equal(eventKey({ e: 'click' }, now), null);
  assert.equal(eventKey(null, now), null);
  assert.ok(isBot('Googlebot/2.1'));
  assert.ok(!isBot('Mozilla/5.0 (Macintosh) Safari/605'));
  const keys = statsKeys('2026-10-14');
  assert.deepEqual(statsFromValues('2026-10-14', keys, ['7', '2', null]), { date: '2026-10-14', views: 7, opens: { usdc: 2, card: 0 } });
});

test('所要時間の計測: 設定と違う提示には署名しない／カードは payment-signature を付ける', async () => {
  const { site } = loadConfig();
  const item = site.items[0];
  const pr = { accepts: [{ scheme: 'exact', network: site.usdc.network, asset: USDC, payTo: PAY_TO, amount: '10000' }] };
  assert.equal(refuseUsdc(pr, { item, usdc: site.usdc }), null);
  assert.match(refuseUsdc({ accepts: [{ ...pr.accepts[0], amount: '20000' }] }, { item, usdc: site.usdc }), /amount/);
  assert.match(refuseUsdc({ accepts: [{ ...pr.accepts[0], payTo: 'evil' }] }, { item, usdc: site.usdc }), /payTo/);
  const seen = [];
  const fake = async (url, init = {}) => {
    seen.push([url, init.headers?.['payment-signature']]);
    const paid = !!init.headers?.['payment-signature'];
    return new Response('{}', { status: paid ? 200 : 402, headers: paid ? { 'x-credits-consumed': '1' } : {} });
  };
  const r = await measureCard({ baseUrl: 'https://gw.test/', item, token: 'TOKEN', fetchImpl: fake });
  assert.equal(r.ok, true);
  assert.equal(r.credits_consumed, 1);
  assert.deepEqual(seen, [['https://gw.test/jin/series', undefined], ['https://gw.test/jin/series', 'TOKEN']]);
  assert.ok(r.total_ms >= 0);
});

test('匿名化', () => {
  const h = anonymize('tok', 'salt');
  assert.match(h, /^h_[0-9a-f]{16}$/);
  assert.notEqual(h, anonymize('tok', 'salt2'));
  assert.throws(() => anonymize('tok', ''));
  assert.equal(parseJsonl('{"a":1}\n\n{"a":2}\n').length, 2);
});

test('実証1ゲートウェイのログ: /logs/:date（JST の日付）の1日分を読み、範囲外の行は落とし、UTC 時刻と JST 日付を付ける', async () => {
  const dir = new URL('./fixtures/gwlog/', import.meta.url).pathname;
  const { start, end } = dayBounds('2026-11-03', '+09:00');
  const calls = toCalls(await fetchGatewayLog({ dir }, '2026-11-03', start, end), '+09:00');
  assert.equal(calls.length, 4); // 2026-11-03T16:00Z は JST 11/4
  assert.deepEqual(calls[0], {
    time_utc: '2026-11-02T15:10:00.000Z',
    date_jst: '2026-11-03',
    token_id: 't1',
    payer_id: 'payerA',
    route_id: 'jin.series',
    outcome: 'ok',
    verify: 'valid',
    settle: 'ok',
    credits: 1,
    latency_ms: 1800,
    upstream_latency_ms: 1500,
    upstream_tx: 'GwTx1',
    upstream_network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    upstream_status: null,
    upstream_error: null,
  });
  assert.equal(upstreamErrorCode('upstream 402 after payment: invalid_exact_svm_payload_transaction'), 'invalid_exact_svm_payload_transaction');
  assert.equal(upstreamErrorCode('upstream 402 after payment'), null); // 文章は残さない
  assert.equal(upstreamErrorCode('<html>oops</html>'), null);
  assert.equal(calls[1].time_utc, '2026-11-02T16:00:00.000Z'); // 旧形式（ts）も読める
  assert.equal(toCalls([{ time_utc: '2026-11-02T15:00:00.000Z', outcome: 'no_token', upstreamTx: 'none' }], '+09:00')[0].upstream_tx, null);
  assert.ok(calls.every((c) => c.date_jst === '2026-11-03'));
  assert.ok(!JSON.stringify(calls).includes('/jin/series')); // パスは残さない
});

test('Nevermined: 照合用の集計。403 は例外で返し、呼び出し側で unavailable にする', async () => {
  const t = summarizeReconcile(
    {
      revenue: { items: [{ agentId: 'pl-1', totalRevenue: '3000000', transactionCount: 3 }, { agentId: 'pl-x', totalRevenue: '9', transactionCount: 9 }] },
      usage: { items: [{ planId: 'pl-1', creditsBurned: '42', uniqueUsers: 2 }] },
      purchased: 3,
    },
    'pl-1',
  );
  assert.deepEqual(t, { plan_purchased_events: 3, revenue_usd: 3, transaction_count: 3, credits_burned: 42, unique_users: 2 });
  assert.throws(() => assertOrgId('<ORG_ID>'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"code":"BCK.ORGANIZATIONS.0022"}', { status: 403 });
  try {
    await assert.rejects(reconcile({ base: 'https://nvm.test', key: 'k', orgId: 'org-1a' }, { from: 'a', to: 'b' }), (e) => e.status === 403);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Stripe: API の取引と手書き CSV。手数料は「支払額 − 受取額」、ID は匿名化', () => {
  const bt = { id: 'txn_1', type: 'charge', created: 1793700000, amount: 100, net: 65, fee: 35, currency: 'usd', source: { amount: 100, metadata: { plan: 'jin' } } };
  assert.ok(matchesPlan(bt, { metadata_key: 'plan', metadata_value: 'jin' }));
  assert.ok(!matchesPlan(bt, { metadata_key: 'plan', metadata_value: 'x' }));
  const s = toSale(bt, anon, '+09:00');
  assert.equal(s.gross_usd, 1);
  assert.equal(s.fee_usd, 0.35);
  assert.equal(s.txn_hash, anon('txn_1'));
  assert.equal(s.time_utc, new Date(1793700000 * 1000).toISOString());
  assert.equal(s.days_to_payout, null);

  const csv = 'id,reporting_category,created,gross,fee,net,currency,automatic_payout_effective_at\n' +
    'txn_A,charge,2026-11-02 16:00:00,1.00,0.35,0.65,usd,2026-11-05 00:00:00\n' +
    'txn_B,payout,2026-11-02 17:00:00,-5.00,0,-5.00,usd,\n' +
    '"txn_C",charge,2026-11-03 01:00:00,1.00,0.35,0.65,usd,\n';
  const rows = salesFromCsv(csv, { anonymize: anon, offset: '+09:00' });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].date_jst, '2026-11-03');
  assert.equal(rows[0].payout_date_jst, '2026-11-05');
  assert.equal(rows[0].days_to_payout, 2.3);
  assert.equal(rows[0].txn_hash, anon('txn_A'));
  assert.equal(rows[1].payout_arrival_utc, null);
  assert.throws(() => checkHeader(['id', 'created', 'Customer Email']), /購入者を特定できる列/);
  assert.throws(() => checkHeader(['id', 'description']), /購入者を特定できる列/);
});

test('価格の一致チェック（入口どうし・期間の固定値・前払い固定）', () => {
  const c = cfg();
  const p = findPeriod(c.period, '2026-11-10');
  assert.equal(p.day, 9);
  assert.equal(findPeriod(c.period, '2026-11-30'), null);
  assert.equal(priceCheck(c.site, p), 'ok');
  const c2 = cfg();
  c2.site.items[0].price_usd = 0.02;
  assert.match(priceCheck(c2.site, p), /カード 0.01 ≠ USDC 0.02/);
  const c3 = cfg();
  c3.site.card.mode = 'pay-as-you-go';
  assert.match(priceCheck(c3.site, p), /prepaid ではない/);
  const c4 = cfg();
  c4.site.card.plan.plan_credits = 50;
  assert.match(priceCheck(c4.site, p), /プラン単価/);
  assert.equal(loadConfig().site.card.mode, 'prepaid');
});

function detail(date) {
  const t0 = dayBounds(date, '+09:00').start;
  const pay = (sig, payer, amt, dt) => ({ ...stamp(t0 + dt), signature: sig, block_time: t0 + dt, payer, amount_atomic: amt, fee_lamports: 5000, fee_payer: FAC, sol_usd: 100 });
  const call = (tok, credits, dt, outcome = 'ok', up = null) => ({ ...stamp(t0 + dt), token_id: tok, route_id: 'jin.series', outcome, credits, latency_ms: 1800 + dt % 7, upstream_tx: up });
  const sale = (h, dt, days) => ({ source: 'api', ...stamp(t0 + dt), txn_hash: h, gross_usd: 1, net_usd: 0.65, fee_usd: 0.35, payout_arrival_utc: days == null ? null : 'x', payout_date_jst: null, days_to_payout: days });
  return {
    page: { date, views: 40, opens: { usdc: 5, card: 3 } },
    usdc: {
      payments: [pay('s1', 'ExtA', '10000', 100), pay('s2', 'ExtA', '20000', 7200), pay('s3', 'Probe', '10000', 300), pay('GwTx1', 'GatewayWallet', '10000', 400), pay('s5', 'Stranger', '10000', 500)],
      sol_usd: { usd: 100 },
    },
    card: {
      calls: [call('tokExt', 1, 10, 'ok', 'GwTx1'), call('tokExt', 2, 20), call('tokOwn', 1, 30), call('tokNew', 1, 40), call('tokNew', 0, 50, 'insufficient_credits')],
      sales: [sale('hExt', 1000, 2), sale('hOwn', 2000, null), sale('hNew', 3000, 3)],
      nvm: null,
    },
    latency: [
      { entry: 'usdc', ok: true, total_ms: 2500, first_ms: 300, sign_ms: 200, paid_ms: 2000 },
      { entry: 'card', ok: true, total_ms: 2100, first_ms: 250, sign_ms: 0, paid_ms: 1850 },
      { entry: 'card', skipped: 'x' },
    ],
  };
}

const fullCfg = () => cfg({ ownWallets: ['Probe'], ownTokens: ['tokOwn'], ownTxns: ['hOwn'], extWallets: ['ExtA'], extTokens: ['tokExt'], extTxns: ['hExt'] });

test('日次集計: own / external / unclassified の3区分。一致しないものは unclassified', () => {
  const d = buildDaily({ date: '2026-11-03', config: fullCfg(), detail: detail('2026-11-03'), sources: {} });
  assert.equal(d.price_check, 'ok');
  const { external: e, unclassified: u, own: o } = d.by_class;
  // ExtA: movers（$0.02、JIN と確定）と $0.01（JIN の series か OSD か不明）
  assert.equal(e.usdc.jin_contracts_min, 1);
  assert.equal(e.usdc.jin_contracts_max, 2);
  assert.equal(e.usdc.unresolved, 1);
  assert.equal(e.usdc.jin_buyers_min, 1);
  assert.equal(e.usdc.jin_buyers_max, 1);
  assert.equal(e.usdc.jin_revenue_usd_min, 0.02);
  assert.equal(e.usdc.jin_revenue_usd_max, 0.03);
  assert.equal(e.usdc.payto_revenue_usd, 0.03);
  // どちらも facilitator が fee payer → 売る側の手数料は 0、facilitator の分は参考値
  assert.equal(e.usdc.seller_fee_usd, 0);
  assert.equal(e.usdc.seller_fee_rate, 0);
  assert.equal(e.usdc.facilitator_fee_usd, 0.001); // 10000 lamports × $100/SOL
  assert.equal(e.usdc.facilitator_fee_rate, 0.0333);
  assert.equal(e.usdc.fee_by_payer.facilitator.txs, 2);
  assert.ok(d.detail.usdc.payments.every((p) => p.fee_payer_role === 'facilitator'));
  assert.equal(o.usdc.payto_inflows, 2); // Probe と、ゲートウェイの裏側の購入（upstream_tx 一致）
  assert.equal(u.usdc.payto_inflows, 1); // Stranger は自動で external にしない
  assert.equal(e.card.calls, 2);
  assert.equal(e.card.uses_credits, 3);
  assert.equal(e.card.buyers, 1);
  assert.equal(e.card.plan_purchases, 1);
  assert.equal(e.card.plan_purchases_source, 'stripe');
  assert.equal(e.card.card_fee_usd_per_contract, 0.35);
  assert.equal(e.card.fee_rate, 0.35);
  assert.equal(e.card.days_to_payout_median, 2);
  assert.equal(u.card.calls, 1);
  assert.deepEqual(u.card.failures, { insufficient_credits: 1 });
  assert.equal(u.card.plan_purchases, 1);
  assert.equal(o.card.calls, 1);
  assert.equal(o.card.payouts_pending, 1);
  assert.deepEqual(d.parties.usdc.find((p) => p.id === 'Stranger'), { id: 'Stranger', class: 'unclassified', count: 1 });
  assert.equal(d.latency.usdc.total_ms_p50, 2500);
  assert.equal(d.latency.card.skipped, 1);
  assert.deepEqual(d.classification, { own_wallets_version: loadConfig().own.version, external_buyers_version: loadConfig().external.version });
});

test('日次集計: 取れなかったソースは null のまま（0 で埋めない）', () => {
  const det = detail('2026-11-03');
  det.card = { calls: null, sales: null, nvm: null };
  const d = buildDaily({ date: '2026-11-03', config: fullCfg(), detail: det, sources: {} });
  assert.equal(d.by_class.external.card.calls, null);
  assert.equal(d.by_class.external.card.plan_purchases, null);
  assert.equal(d.by_class.external.card.card_fee_usd, null);
  assert.equal(d.by_class.external.card.days_to_payout_median, null);
});

test('日次集計: 分類リストが空なら、全部 unclassified（ゲートウェイの裏側の購入だけは own）', () => {
  const d = buildDaily({ date: '2026-11-03', config: cfg(), detail: detail('2026-11-03'), sources: {} });
  assert.equal(d.by_class.external.usdc.payto_inflows, 0);
  assert.equal(d.by_class.own.usdc.payto_inflows, 1);
  assert.equal(d.by_class.unclassified.usdc.payto_inflows, 4);
  assert.equal(d.by_class.external.card.calls, 0);
});

test('週次レポート: 外部の購入者なし（未分類あり）・あり、未分類の別表', () => {
  const days = weekDays('2026-W45');
  const allOk = { usdc_chain: 'ok', gateway_log: 'ok', stripe: 'ok' };
  const c0 = cfg({ ownWallets: ['Probe'], ownTokens: ['tokOwn'], ownTxns: ['hOwn'] });
  const dailies = days.map((d) => buildDaily({ date: d, config: c0, detail: detail(d), sources: allOk }));
  const md = renderWeekly({ label: '2026-W45', days, dailies, config: c0 });
  assert.match(md, /今週は外部の購入者がいなかった/);
  assert.match(md, /ただし未分類（unclassified）が \d+ 件ある/);
  assert.match(md, /## 別表：未分類（unclassified）/);
  assert.match(md, /\| USDC 直接 \| `Stranger` \| 7 \|\s*\|/);
  assert.match(md, /参考：facilitator が払ったチェーン手数料/);
  assert.match(md, /## 参考値：自社の購入（own）/);
  const partial = renderWeekly({ label: '2026-W45', days, dailies: dailies.slice(0, 5), config: c0 });
  assert.match(partial, /計測できていない/);
  assert.match(partial, /日次データなし/);

  const c = fullCfg();
  const two = [days[0], days[1]].map((d) => buildDaily({ date: d, config: c, detail: detail(d), sources: allOk }));
  const md2 = renderWeekly({ label: '2026-W45', days, dailies: two, config: c });
  assert.doesNotMatch(md2, /外部の購入者がいなかった/);
  const extSection = md2.split('## 別表')[0];
  // 2日分。支払い元アドレス・購入者は週で重複を数えない
  assert.match(extSection, /\| 成約件数 \| 2 〜 4（JIN への支払い件数。[^|]*\| 2（プラン購入件数・Stripe） \|/);
  assert.match(extSection, /\| 購入者数 \| 1（支払い元アドレス数） \| 1（匿名化した購入者 ID＝payerId の数） \|/);
  assert.match(md2, /\| 80 \| 10 \| 6 \| 2 \/ 7 \|/);
  assert.match(md2, /\| USDC 直接 \| 2500 ms \| 2500 ms \| 2 \/ 2 \|/);
});

test('チェーン手数料: tx ごとに誰が払ったかを判定し、seller の分だけを売る側の手数料率に入れる', async () => {
  const { feePayerRole } = await import('../lib/aggregate.js');
  const c = cfg({ extWallets: ['B1', 'B2', 'B3'] });
  const site = c.site;
  assert.equal(feePayerRole({ fee_payer: FAC, payer: 'B1' }, site), 'facilitator');
  assert.equal(feePayerRole({ fee_payer: PAY_TO, payer: 'B1' }, site), 'seller');
  assert.equal(feePayerRole({ fee_payer: 'B1', payer: 'B1' }, site), 'buyer');
  assert.equal(feePayerRole({ fee_payer: 'X', payer: 'B1' }, site), 'other');
  const t0 = dayBounds('2026-11-03', '+09:00').start;
  const pay = (sig, payer, feePayer, lamports) => ({ ...stamp(t0), signature: sig, block_time: t0, payer, amount_atomic: '10000', fee_lamports: lamports, fee_payer: feePayer, sol_usd: 100 });
  const det = { usdc: { payments: [pay('a', 'B1', FAC, 5000), pay('b', 'B2', PAY_TO, 10000), pay('c', 'B3', 'B3', 20000)] }, card: { calls: null, sales: null }, latency: [] };
  const d = buildDaily({ date: '2026-11-03', config: c, detail: det, sources: {} });
  const u = d.by_class.external.usdc;
  assert.equal(u.payto_revenue_usd, 0.03);
  assert.equal(u.seller_fee_usd, 0.001); // 10000 lamports
  assert.equal(u.seller_fee_usd_per_tx, 0.000333);
  assert.equal(u.seller_fee_rate, 0.0333);
  assert.equal(u.facilitator_fee_usd, 0.0005);
  assert.equal(u.fee_by_payer.buyer.usd, 0.002);
  assert.deepEqual(d.detail.usdc.payments.map((p) => p.fee_payer_role), ['facilitator', 'seller', 'buyer']);
});

test('プラン購入件数の主系を card.purchase_source で切り替える', () => {
  const det = detail('2026-11-03');
  const t0 = dayBounds('2026-11-03', '+09:00').start;
  det.card.nvm_purchases = [
    { ...stamp(t0 + 10), buyer_hash: 'uExt', plan_id: 'pl' },
    { ...stamp(t0 + 20), buyer_hash: 'uExt', plan_id: 'pl' },
    { ...stamp(t0 + 30), buyer_hash: 'uNew', plan_id: 'pl' },
  ];
  const c = fullCfg();
  c.external.nvm_user_hashes = [{ id: 'uExt' }];
  let d = buildDaily({ date: '2026-11-03', config: c, detail: det, sources: {} });
  assert.equal(d.by_class.external.card.plan_purchases, 1); // 既定は stripe
  assert.equal(d.by_class.external.card.plan_purchases_nvm_events, 2);
  c.site.card.purchase_source = 'nvm_events';
  d = buildDaily({ date: '2026-11-03', config: c, detail: det, sources: {} });
  assert.equal(d.by_class.external.card.plan_purchases, 2);
  assert.equal(d.by_class.external.card.plan_purchases_stripe, 1);
  assert.equal(d.by_class.unclassified.card.plan_purchases, 1);
  assert.equal(loadConfig().site.card.purchase_source, 'stripe');
});

test('own 候補は注記だけで、unclassified のまま', () => {
  const c = cfg();
  c.own.candidates = {
    solana: [{ address: '7PVToVBASYgo7c7BfqdditPgud1xnDrSpCgCBaQyL6tY', likely: 'AA（Autonomous Agent）', note_short: '自社 AA の候補。movers $0.02 を毎日購入。週1回の seller-probe とは頻度が合わない', confirm_when: 'test' }],
  };
  const det = detail('2026-11-03');
  det.usdc.payments.push({ ...det.usdc.payments[0], signature: 'p7', payer: '7PVToVBASYgo7c7BfqdditPgud1xnDrSpCgCBaQyL6tY', amount_atomic: '20000' });
  const d = buildDaily({ date: '2026-11-03', config: c, detail: det, sources: {} });
  const p = d.parties.usdc.find((x) => x.id.startsWith('7PVT'));
  assert.equal(p.class, 'unclassified');
  assert.match(p.note, /own 候補（AA/);
  assert.match(p.note, /週1回の seller-probe とは頻度が合わない/);
  // 各トランザクションにも同じ注記
  const tx = d.detail.usdc.payments.find((x) => x.signature === 'p7');
  assert.equal(tx.own_candidate.likely, 'AA（Autonomous Agent）');
  assert.match(tx.own_candidate.note, /自社 AA の候補。movers \$0\.02 を毎日/);
  assert.equal(d.detail.usdc.payments.find((x) => x.signature === 's1').own_candidate, undefined);
  // own に確定したら注記は付かない
  const c2 = cfg({ ownWallets: ['7PVToVBASYgo7c7BfqdditPgud1xnDrSpCgCBaQyL6tY'] });
  c2.own.candidates = c.own.candidates;
  const d2 = buildDaily({ date: '2026-11-03', config: c2, detail: det, sources: {} });
  assert.equal(d2.detail.usdc.payments.find((x) => x.signature === 'p7').own_candidate, undefined);
  assert.equal(d2.parties.usdc.find((x) => x.id.startsWith('7PVT')).class, 'own');
});

test('期間外の日: 開始日前・開始日未設定の日は本表に入れず、期間外として別に出す', async () => {
  const { periodPhase } = await import('../lib/aggregate.js');
  const days = weekDays('2026-W45'); // 11/02(月)〜11/08(日)
  const allOk = { usdc_chain: 'ok', gateway_log: 'ok', stripe: 'ok' };
  // 日次データは開始日を入れる前に作られた（period: null）
  const before = cfg({ ownWallets: ['Probe'], ownTokens: ['tokOwn'], ownTxns: ['hOwn'], extWallets: ['ExtA'], extTokens: ['tokExt'], extTxns: ['hExt'] });
  before.period.periods[0].start = 'TODO_YYYY-MM-DD';
  const dailies = days.map((d) => buildDaily({ date: d, config: before, detail: detail(d), sources: allOk }));
  assert.ok(dailies.every((d) => d.period === null && d.period_phase === 'no_period'));

  // 開始日未設定のままレポートを出すと、本表は空
  let md = renderWeekly({ label: '2026-W45', days, dailies, config: before });
  assert.match(md, /この週に計測期間中の日はない\*\*（開始日（config\/period.json）が未設定）/);
  assert.match(md, /## 期間外の日（参考。本表に含めない）/);
  assert.doesNotMatch(md, /今週は外部の購入者がいなかった/);

  // あとで開始日を 11/04 に入れる。保存済みの日次データ（period: null）のままでも、11/02・11/03 は期間前になる
  const after = structuredClone(before);
  after.period.periods[0].start = '2026-11-04';
  assert.equal(periodPhase(after.period, '2026-11-03'), 'pre_period');
  assert.equal(periodPhase(after.period, '2026-11-04'), 'in_period');
  assert.equal(periodPhase(after.period, '2026-12-02'), 'post_period');
  md = renderWeekly({ label: '2026-W45', days, dailies, config: after });
  assert.match(md, /期間外の日（2026-11-02 期間前, 2026-11-03 期間前）は本表に含めない/);
  const main = md.split('## 別表')[0];
  // 本表は 11/04〜11/08 の5日分だけ（1日あたり外部の USDC 2件）
  assert.match(main, /\| 成約件数 \| 5 〜 10（JIN への支払い件数。/);
  assert.match(main, /\| 5 \/ 5 \|/); // 販売ページの計測できた日数
  assert.match(md, /\| 外部 \| 2 〜 4 \| \$0\.04 〜 \$0\.06 \|/); // 期間外の表に 11/02・11/03 の分
  // 期間前の日に価格を変えていても、固定値との不一致としては出さない
  const pricey = structuredClone(dailies);
  pricey[0].price_check = 'mismatch: series: 0.01 → 0.02';
  assert.doesNotMatch(renderWeekly({ label: '2026-W45', days, dailies: pricey, config: after }), /価格の不一致を検知/);
});

test('checkCurrent: 旧形式を検出する', async () => {
  const { checkCurrent, SCHEMA_VERSION } = await import('../lib/aggregate.js');
  const c = fullCfg();
  const d = buildDaily({ date: '2026-11-03', config: c, detail: detail('2026-11-03'), sources: {} });
  assert.equal(d.schema_version, SCHEMA_VERSION);
  assert.deepEqual(checkCurrent(d, c), []);
  const old = structuredClone(d);
  delete old.schema_version;
  delete old.period_phase;
  delete old.detail.usdc.payments[0].fee_payer_role;
  const bad = checkCurrent(old, c);
  assert.ok(bad.some((x) => /schema_version/.test(x)));
  assert.ok(bad.some((x) => /period_phase/.test(x)));
  assert.ok(bad.some((x) => /fee_payer_role/.test(x)));
  const c2 = structuredClone(c);
  c2.own.version += 1;
  assert.ok(checkCurrent(d, c2).some((x) => /own_wallets v/.test(x)));
});

test('$0.01 は JIN か OSD か不明（unresolved）。売り手ログで一致した tx だけ確定する', async () => {
  const { parseSellerLog, sellerLogUrl } = await import('../lib/seller-log.js');
  const c = fullCfg();
  const det = detail('2026-11-03');
  // 売り手ログ: s1（ExtA の $0.01）は JIN の series、s5（Stranger の $0.01）は OSD
  det.usdc.seller_log = parseSellerLog(JSON.stringify([
    { tx_signature: 's1', endpoint: 'https://jin.x402jp.com/api/jin/series', amount: '10000', time_utc: '2026-11-02T15:01:40Z' },
    { tx_signature: 's5', endpoint: 'https://osd.x402jp.com/api/alpha/portfolio/current', amount: '10000', time_utc: '2026-11-02T15:08:20Z' },
  ]));
  const d = buildDaily({ date: '2026-11-03', config: c, detail: det, sources: {} });
  const bySig = Object.fromEntries(d.detail.usdc.payments.map((p) => [p.signature, p]));
  assert.equal(bySig.s1.product, 'jin_series');
  assert.equal(bySig.s1.product_source, 'seller_log:seller');
  assert.equal(bySig.s2.product, 'jin_movers');
  assert.equal(bySig.s2.product_source, 'amount');
  assert.equal(bySig.s3.product, 'unresolved'); // ログに無い $0.01
  assert.equal(bySig.s5.product, 'osd');
  const e = d.by_class.external.usdc;
  assert.equal(e.jin_contracts_min, 2); // movers ＋ ログで確定した series
  assert.equal(e.jin_contracts_max, 2);
  assert.equal(e.unresolved, 0);
  assert.equal(d.by_class.unclassified.usdc.by_product.osd, 1);
  assert.equal(d.by_class.unclassified.usdc.jin_contracts_max, 0);
  // $0.001 は OSD
  const det2 = detail('2026-11-03');
  det2.usdc.payments[0].amount_atomic = '1000';
  assert.equal(buildDaily({ date: '2026-11-03', config: c, detail: det2, sources: {} }).detail.usdc.payments[0].product, 'osd');
  // ログの形
  assert.equal(sellerLogUrl('https://jin.x402jp.com/', '2026-11-03'), 'https://jin.x402jp.com/sales/2026-11-03');
  assert.equal(sellerLogUrl('https://x.example/s/{date}.json', '2026-11-03'), 'https://x.example/s/2026-11-03.json');
  assert.throws(() => parseSellerLog('[{"tx_signature":"a","endpoint":"e","amount":"1"}]'), /time_utc/);
  assert.equal(parseSellerLog('{"tx_signature":"a","endpoint":"e","amount":"1","time_utc":"2026-11-03T00:00:00Z"}\n{"tx_signature":"b","endpoint":"e","amount":"1","time_utc":"2026-11-03T00:00:01Z"}').length, 2);
});

test('売り手ログ: 404 は null（その日のログが無い）、それ以外のエラーは例外', async () => {
  const { fetchSellerLog } = await import('../lib/seller-log.js');
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push([url, init.headers.authorization]);
    if (url.endsWith('2026-11-01')) return new Response('', { status: 404 });
    if (url.endsWith('2026-11-02')) return new Response('', { status: 401 });
    return new Response('[{"tx_signature":"a","endpoint":"https://jin.x402jp.com/api/jin/series","amount":"10000","time_utc":"2026-11-03T00:00:00Z"}]');
  };
  try {
    assert.equal(await fetchSellerLog({ url: 'https://s.test', token: 'T' }, '2026-11-01'), null);
    await assert.rejects(fetchSellerLog({ url: 'https://s.test', token: 'T' }, '2026-11-02'), /HTTP 401/);
    assert.equal((await fetchSellerLog({ url: 'https://s.test', token: 'T' }, '2026-11-03')).length, 1);
    assert.deepEqual(seen[2], ['https://s.test/sales/2026-11-03', 'Bearer T']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('AA の公開 run ログ: JIN・OSD の購入だけを売り手ログの形にし、売り手ログを優先してまとめる', async () => {
  const { rowsFromRuns, mergeSellerRows } = await import('../lib/aa-runs.js');
  const body = {
    runs: [
      {
        timestamp: '2026-10-14T10:23:07.322Z',
        results: [
          { endpoint: 'https://osd.x402jp.com/api/alpha/portfolio/current', costUsdc: 0.01, txHash: 'tnFj' },
          { endpoint: 'https://jin.x402jp.com/api/jin/latest', costUsdc: 0 },
          { endpoint: 'https://x402yi.vercel.app/api/yield/scan', costUsdc: 0.2, txHash: '0x8f3b' },
        ],
      },
    ],
  };
  const rows = rowsFromRuns(body);
  assert.deepEqual(rows, [{ tx_signature: 'tnFj', endpoint: 'https://osd.x402jp.com/api/alpha/portfolio/current', amount: '10000', time_utc: '2026-10-14T10:23:07.322Z', source: 'aa_runs' }]);
  const seller = [{ tx_signature: 'tnFj', endpoint: 'https://jin.x402jp.com/api/jin/series', amount: '10000', time_utc: 'x', source: 'seller' }];
  assert.equal(mergeSellerRows(seller, rows)[0].source, 'seller');
  assert.equal(mergeSellerRows(null, rows)[0].source, 'aa_runs');
  // 集計では aa_runs で OSD と確定する
  const c = fullCfg();
  const det = detail('2026-11-03');
  det.usdc.seller_log = [{ ...rows[0], tx_signature: 's3' }];
  const d = buildDaily({ date: '2026-11-03', config: c, detail: det, sources: {} });
  const p = d.detail.usdc.payments.find((x) => x.signature === 's3');
  assert.deepEqual([p.product, p.product_source], ['osd', 'seller_log:aa_runs']);
});

test('売り手ログを OSD が出す場合: その日のログに無い $0.01 は消去法で JIN の series', () => {
  const c = fullCfg();
  const det = detail('2026-11-03');
  det.usdc.seller_log = [{ tx_signature: 's5', endpoint: 'https://osd.x402jp.com/api/alpha/portfolio/current', amount: '10000', time_utc: 'x', source: 'seller' }];
  det.usdc.seller_log_complete = 'osd';
  const d = buildDaily({ date: '2026-11-03', config: c, detail: det, sources: {} });
  const bySig = Object.fromEntries(d.detail.usdc.payments.map((p) => [p.signature, p]));
  assert.deepEqual([bySig.s5.product, bySig.s1.product, bySig.s1.product_source], ['osd', 'jin_series', 'seller_log_exclusion:osd']);
  assert.equal(bySig.s2.product, 'jin_movers');
  // ログが取れなかった日（complete が無い）は unresolved のまま
  delete det.usdc.seller_log_complete;
  const d2 = buildDaily({ date: '2026-11-03', config: c, detail: det, sources: {} });
  assert.equal(d2.detail.usdc.payments.find((p) => p.signature === 's1').product, 'unresolved');
});

test('売り手ログの消去法は、売り手が記録を始めた日（seller_log_since）以降だけ', async () => {
  const { sellerLogCompleteFor } = await import('../lib/aggregate.js');
  const c = fullCfg();
  c.site.usdc.seller_log_covers = 'jin';
  c.site.usdc.seller_log_since = null;
  assert.equal(sellerLogCompleteFor(c.site, '2026-11-03', true), null); // 未設定の間は使わない（[] の日と区別できない）
  c.site.usdc.seller_log_since = '2026-11-04';
  assert.equal(sellerLogCompleteFor(c.site, '2026-11-03', true), null); // 記録を始める前の日
  assert.equal(sellerLogCompleteFor(c.site, '2026-11-04', true), 'jin');
  assert.equal(sellerLogCompleteFor(c.site, '2026-11-04', false), null); // ログが取れなかった日
  // JIN の [] の日（記録0件）を消去法に使うと、その日の $0.01 はすべて OSD
  const det = detail('2026-11-04');
  det.usdc.seller_log = [];
  det.usdc.seller_log_complete = sellerLogCompleteFor(c.site, '2026-11-04', true);
  const d = buildDaily({ date: '2026-11-04', config: c, detail: det, sources: {} });
  assert.equal(d.detail.usdc.payments.find((p) => p.signature === 's1').product, 'osd');
  assert.equal(d.detail.usdc.payments.find((p) => p.signature === 's2').product, 'jin_movers');
});

test('実証1のゲートウェイ: ウォレット発の JIN 支払いは own。ログの ok は成約、settle_failed は別に数え、ログに無いチェーン側の支払いも数える', () => {
  const config = structuredClone(loadConfig());
  const gw = config.own.solana.find((w) => w.role === 'card_gateway').address;
  config.own.card_payer_ids.ids = ['pOwn'];
  const pay = (signature, payer) => ({ signature, payer, amount_micro: 10000, fee_payer: null, time_utc: '2026-10-21T01:00:00.000Z', date_jst: '2026-10-21' });
  const detail = {
    usdc: { payments: [pay('A', gw), pay('B', gw), pay('C', gw), pay('X', 'someoneElse')] },
    card: {
      calls: [
        { token_id: 't1', payer_id: 'p1', route_id: 'jin.series', outcome: 'ok', credits: 1, upstream_tx: 'A' },
        { token_id: 't2', payer_id: 'p1', route_id: 'jin.series', outcome: 'settle_failed', credits: 0, upstream_tx: 'B' },
        { token_id: 't3', payer_id: 'p1', route_id: 'osd.jp.catalysts', outcome: 'ok', credits: 1, upstream_tx: 'C' },
        { token_id: 't4', payer_id: 'p1', route_id: 'jin.series', outcome: 'ok', credits: 1, upstream_tx: 'D' },
        { token_id: 't5', payer_id: 'pOwn', route_id: 'jin.series', outcome: 'ok', credits: 1, upstream_tx: 'E' },
      ],
    },
  };
  const d = buildDaily({ date: '2026-10-21', config, detail, sources: {} });
  assert.equal(d.by_class.own.usdc.payto_inflows, 3);
  assert.equal(d.by_class.unclassified.usdc.payto_inflows, 1);
  assert.equal(d.by_class.unclassified.card.calls, 2); // 比較は JIN series だけ。OSD は内訳に出る
  assert.deepEqual(d.by_class.unclassified.card.calls_by_product, { jin_series: 2, osd: 1 });
  assert.equal(d.by_class.unclassified.card.buyers, 1); // tokenId は購入ごとに変わる。買い手は payerId で数える
  assert.equal(d.by_class.own.card.calls, 1); // card_payer_ids に入れた買い手は own
  assert.equal(d.by_class.unclassified.card.settle_failed, 1);
  assert.equal(d.gateway_upstream.chain_payments, 3);
  assert.deepEqual(d.gateway_upstream.by_product, { jin_series: 2, osd: 1 }); // $0.01 でも、ゲートウェイのログの routeId で商品が決まる
  assert.equal(d.gateway_upstream.log_calls_ok, 4);
  assert.deepEqual(d.gateway_upstream.log_ok_by_product, { jin_series: 3, osd: 1 });
  assert.equal(d.gateway_upstream.log_settle_failed, 1);
  assert.equal(d.gateway_upstream.chain_not_in_log, 0);
  assert.deepEqual(d.gateway_upstream.known_gap.missing_by_product, { jin_series: 2, osd: 1 });
});
