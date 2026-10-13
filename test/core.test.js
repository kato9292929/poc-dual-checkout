import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dayBounds, localDate, isoWeek, weekDays, yesterday, percentile } from '../lib/dates.js';
import { parsePayment } from '../lib/solana.js';
import { buildDaily, priceCheck, findPeriod } from '../lib/aggregate.js';
import { renderWeekly } from '../lib/report.js';
import { eventKey, statsKeys, statsFromValues, isBot } from '../lib/track.js';
import { matchesPlan, toSale } from '../lib/stripe.js';
import { parseJsonl, summarizeGatewayLog, fetchGatewayLog } from '../lib/gateway.js';
import { purchasesFromEvents, totalsFromAnalytics, assertOrgId } from '../lib/nevermined.js';
import { refuseUsdc, measureCard } from '../lib/probe.js';
import { anonymize } from '../lib/anon.js';
import { loadConfig } from '../lib/config.js';

const PAY_TO = '4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FAC = 'CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww';
const fixture = (f) => new URL(`./fixtures/${f}`, import.meta.url);
const anon = (v) => anonymize(v, 'test-salt');

function cfg({ start = '2026-11-02', mode = 'prepaid', ownWallets = [], ownUsers = [], ownPayers = [] } = {}) {
  const c = structuredClone(loadConfig());
  c.period.periods[0].start = start;
  c.period.periods[0].locked.card_mode = mode;
  c.site.card.mode = mode;
  c.exclusions.usdc_wallets = ownWallets.map((address) => ({ address, label: 'own' }));
  c.exclusions.card_buyers.nvm_user_hashes = ownUsers.map(anon);
  c.exclusions.card_buyers.gateway_payer_ids = ownPayers;
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

test('実証1ゲートウェイのログ: JST の1日分を UTC の2ファイルから読み、支払元ごとにまとめる', async () => {
  const dir = new URL('./fixtures/gwlog/', import.meta.url).pathname;
  const { start, end } = dayBounds('2026-11-03', '+09:00');
  const rows = await fetchGatewayLog({ dir }, start, end);
  assert.equal(rows.length, 4); // 2026-11-03T16:00Z は JST 11/4
  const g = summarizeGatewayLog(rows);
  const a = g.payers.find((p) => p.payer_id === 'payerA');
  assert.equal(a.calls_ok, 2);
  assert.equal(a.credits, 3);
  assert.deepEqual(a.latency_ms, [1800, 2200]);
  assert.deepEqual(g.payers.find((p) => p.payer_id === 'payerB').failures, { insufficient_credits: 1 });
  assert.deepEqual(g.upstream_txs, ['GwTx1', 'GwTx2', 'GwTx3']);
});

test('Nevermined: plan.purchased を匿名化した購入に、analytics を集計値に', () => {
  const ev = [
    { eventType: 'plan.purchased', actorUserId: 'us-1', subject: { kind: 'plan', id: 'pl-1' }, occurredAt: '2026-11-03T01:00:00Z' },
    { eventType: 'plan.purchased', actorUserId: 'us-2', subject: { kind: 'plan', id: 'pl-other' }, occurredAt: '2026-11-03T02:00:00Z' },
    { eventType: 'member.joined', actorUserId: 'us-3', subject: { kind: 'member', id: 'x' }, occurredAt: '2026-11-03T02:00:00Z' },
  ];
  const ps = purchasesFromEvents(ev, { planId: 'pl-1', anonymize: anon });
  assert.equal(ps.length, 1);
  assert.equal(ps[0].buyer_hash, anon('us-1'));
  assert.ok(!JSON.stringify(ps).includes('us-1'));
  const t = totalsFromAnalytics(
    { revenue: { items: [{ agentId: 'pl-1', totalRevenue: '3000000', transactionCount: 3 }] }, usage: { items: [{ planId: 'pl-1', creditsBurned: '42', uniqueUsers: 2 }] } },
    'pl-1',
  );
  assert.deepEqual(t, { revenue_usd: 3, transaction_count: 3, credits_burned: 42, unique_users: 2 });
  assert.throws(() => assertOrgId('<ORG_ID>'));
  assertOrgId('org-1a2b-3c');
});

test('Stripe: 手数料は「支払額 − 受取額」、ID は匿名化', () => {
  const bt = { id: 'txn_1', type: 'charge', created: 100, amount: 100, net: 65, fee: 35, currency: 'usd', available_on: 200, source: { amount: 100, metadata: { plan: 'jin' } } };
  assert.ok(matchesPlan(bt, { metadata_key: 'plan', metadata_value: 'jin' }));
  assert.ok(!matchesPlan(bt, { metadata_key: 'plan', metadata_value: 'x' }));
  const s = toSale(bt, anon);
  assert.equal(s.gross_usd, 1);
  assert.equal(s.fee_usd, 0.35);
  assert.equal(s.txn_hash, anon('txn_1'));
  // destination charge: 接続アカウント側の金額は Nevermined の手数料が引かれた後
  const s2 = toSale({ ...bt, type: 'payment', amount: 98, net: 65, source: { amount: 100 } }, anon);
  assert.equal(s2.fee_usd, 0.35);
});

test('価格の一致チェック（入口どうし・期間の固定値・カードの mode）', () => {
  const c = cfg();
  const p = findPeriod(c.period, '2026-11-10');
  assert.equal(p.day, 9);
  assert.equal(findPeriod(c.period, '2026-11-30'), null);
  assert.equal(priceCheck(c.site, p), 'ok');
  const c2 = cfg();
  c2.site.items[0].price_usd = 0.02;
  assert.match(priceCheck(c2.site, p), /カード 0.01 ≠ USDC 0.02/);
  const c3 = cfg();
  c3.site.card.mode = 'per_call';
  assert.match(priceCheck(c3.site, findPeriod(c3.period, '2026-11-10')), /mode: prepaid → per_call/);
  const c4 = cfg();
  c4.site.card.modes.prepaid.plan_credits = 50;
  assert.match(priceCheck(c4.site, p), /プラン単価/);
});

function detail(date, { gateway = true } = {}) {
  const t0 = dayBounds(date, '+09:00').start;
  const pay = (sig, payer, amt, dt) => ({ signature: sig, block_time: t0 + dt, payer, amount_atomic: amt, fee_lamports: 5000, fee_payer: FAC });
  return {
    page: { date, views: 40, opens: { usdc: 5, card: 3 } },
    usdc: {
      payments: [pay('s1', 'ExtA', '10000', 100), pay('s2', 'ExtA', '20000', 7200), pay('s3', 'Probe', '10000', 300), pay('GwTx1', 'GatewayWallet', '10000', 400)],
      sol_usd: { usd: 100, source: 'test' },
    },
    card: {
      mode: 'prepaid',
      purchases_nvm: [
        { source: 'nevermined', kind: 'plan', ts: t0 + 1000, buyer_hash: anon('us-ext') },
        { source: 'nevermined', kind: 'plan', ts: t0 + 5000, buyer_hash: anon('us-own') },
      ],
      sales_stripe: [
        { source: 'stripe', ts: t0 + 1010, txn_hash: 'h1', gross_usd: 1, net_usd: 0.65, fee_usd: 0.35, days_to_payout: 2 },
        { source: 'stripe', ts: t0 + 5020, txn_hash: 'h2', gross_usd: 1, net_usd: 0.65, fee_usd: 0.35, days_to_payout: null },
      ],
      sales_manual: null,
      gateway: gateway
        ? {
            payers: [
              { payer_id: 'payerA', calls_ok: 2, credits: 3, by_route: {}, failures: {}, latency_ms: [1800, 2200] },
              { payer_id: 'payerOwn', calls_ok: 1, credits: 1, by_route: {}, failures: {}, latency_ms: [1600] },
            ],
            upstream_txs: ['GwTx1'],
          }
        : null,
    },
    latency: [
      { entry: 'usdc', ok: true, total_ms: 2500, first_ms: 300, sign_ms: 200, paid_ms: 2000 },
      { entry: 'card', ok: true, total_ms: 2100, first_ms: 250, sign_ms: 0, paid_ms: 1850 },
      { entry: 'card', skipped: 'x' },
    ],
  };
}

test('日次集計: 自社を除外して別枠に、手数料率・所要時間・着金日数', () => {
  const c = cfg({ ownWallets: ['Probe'], ownUsers: ['us-own'], ownPayers: ['payerOwn'] });
  const d = buildDaily({ date: '2026-11-03', config: c, detail: detail('2026-11-03'), sources: {} });
  assert.equal(d.price_check, 'ok');
  const u = d.external.usdc;
  assert.equal(u.contracts, 2); // Probe とゲートウェイの裏側の購入（upstreamTx 一致）を除外
  assert.equal(u.buyers, 1);
  assert.equal(u.revenue_usd, 0.03);
  assert.equal(u.chain_fee_usd, 0.001); // 10000 lamports × $100/SOL
  assert.equal(u.fee_rate, 0.0333);
  assert.equal(u.fee_paid_by_facilitator, 2);
  assert.equal(d.internal.usdc.contracts, 2);
  const k = d.external.card;
  assert.equal(k.plan_purchases, 1);
  assert.equal(k.contracts, 1);
  assert.equal(k.buyers, 1);
  assert.equal(k.uses_credits, 3);
  assert.equal(k.revenue_usd, 1); // 自社購入と時刻が近い Stripe 取引は自社分
  assert.equal(k.card_fee_usd_per_contract, 0.35);
  assert.equal(k.fee_rate, 0.35);
  assert.equal(k.days_to_payout_median, 2);
  assert.equal(k.gateway_latency_ms_p50, 1800);
  assert.equal(d.internal.card.plan_purchases, 1);
  assert.equal(d.internal.card.payouts_pending, 1);
  assert.equal(d.latency.usdc.total_ms_p50, 2500);
  assert.equal(d.latency.card.total_ms_p50, 2100);
  assert.equal(d.latency.card.skipped, 1);
});

test('日次集計: 都度払いでは成功したコールが成約、購入者はゲートウェイの支払元', () => {
  const c = cfg({ mode: 'per_call', ownPayers: ['payerOwn'] });
  const det = detail('2026-11-03');
  det.card.mode = 'per_call';
  det.card.purchases_nvm = null;
  const d = buildDaily({ date: '2026-11-03', config: c, detail: det, sources: {} });
  assert.equal(d.external.card.plan_purchases, 0);
  assert.equal(d.external.card.per_call_payments, 2);
  assert.equal(d.external.card.buyers, 1);
});

test('週次レポート: 外部購入者なしの週を明記、ありの週は表', () => {
  const c = cfg({ ownWallets: ['Probe', 'ExtA'], ownUsers: ['us-own', 'us-ext'], ownPayers: ['payerOwn', 'payerA'] });
  const days = weekDays('2026-W45');
  const allOk = { usdc_chain: 'ok', nevermined_events: 'ok', gateway_log: 'ok' };
  const dailies = days.map((d) => buildDaily({ date: d, config: c, detail: detail(d), sources: allOk }));
  const md = renderWeekly({ label: '2026-W45', days, dailies, config: c });
  assert.match(md, /今週は外部の購入者がいなかった/);
  assert.match(md, /参考値：自社の購入/);
  const partial = renderWeekly({ label: '2026-W45', days, dailies: dailies.slice(0, 5), config: c });
  assert.match(partial, /確認できなかった/);
  assert.match(partial, /日次データなし/);

  const c2 = cfg({ ownWallets: ['Probe'], ownUsers: ['us-own'], ownPayers: ['payerOwn'] });
  const two = [days[0], days[1]].map((d) => buildDaily({ date: d, config: c2, detail: detail(d), sources: allOk }));
  const md2 = renderWeekly({ label: '2026-W45', days, dailies: two, config: c2 });
  assert.doesNotMatch(md2, /外部の購入者がいなかった/);
  // 2日分。支払い元アドレス・購入者は週で重複を数えない
  assert.match(md2, /\| 成約件数 \| 4（支払い件数） \| 2（プラン購入 2・都度払い 0） \|/);
  assert.match(md2, /\| 購入者数 \| 1（支払い元アドレス数） \| 1 \|/);
  assert.match(md2, /\| 80 \| 10 \| 6 \| 2 \/ 7 \|/);
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
