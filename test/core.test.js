import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dayBounds, localDate, isoWeek, weekDays, yesterday } from '../lib/dates.js';
import { parsePayment } from '../lib/solana.js';
import { classifyX402Payer, classifyCardToken } from '../lib/classify.js';
import { buildDaily, priceCheck, findPeriod } from '../lib/aggregate.js';
import { renderWeekly } from '../lib/report.js';
import { eventKey, statsKeys, statsFromValues, isBot } from '../lib/track.js';
import { matchesPlan, toPurchase } from '../lib/stripe.js';
import { parseUsage } from '../lib/gateway.js';
import { anonymize } from '../lib/anon.js';
import { loadConfig } from '../lib/config.js';

const PAY_TO = '4s8XQC2WzRfgH8Xiep7ybnCW11VKRCMwxQF6jknx3VPf';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FAC = 'CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww';

function cfg({ start = '2026-11-02', own = [] } = {}) {
  const c = structuredClone(loadConfig());
  c.period.periods[0].start = start;
  c.classify.own.wallets = own.map((address) => ({ address, label: 'own' }));
  return c;
}

test('JST の日境界と ISO 週', () => {
  const { start, end } = dayBounds('2026-10-13', '+09:00');
  assert.equal(new Date(start * 1000).toISOString(), '2026-10-12T15:00:00.000Z');
  assert.equal(end - start, 86400);
  assert.equal(localDate(start, '+09:00'), '2026-10-13');
  assert.equal(localDate(start - 1, '+09:00'), '2026-10-12');
  assert.equal(isoWeek('2026-10-13').label, '2026-W42');
  assert.deepEqual(weekDays('2026-W42'), isoWeek('2026-10-13').days);
  assert.equal(weekDays('2026-W01')[0], '2025-12-29');
  assert.equal(yesterday('+09:00', Date.parse('2026-10-12T16:00:00Z')), '2026-10-12');
});

test('payTo への USDC 入金を取り出し、ファシリテーター負担の手数料は除く', () => {
  const tx = JSON.parse(readFileSync(new URL('./fixtures/tx-payment.json', import.meta.url)));
  const p = parsePayment(tx, { payTo: PAY_TO, mint: USDC, facilitatorFeePayers: [FAC] });
  assert.equal(p.payer, 'BuyerWa11et111111111111111111111111111111111');
  assert.equal(p.amount_atomic, '20000');
  assert.equal(p.fee_lamports, 10001);
  assert.equal(p.fee_lamports_excl_facilitator, 0);
  const p2 = parsePayment(tx, { payTo: PAY_TO, mint: USDC, facilitatorFeePayers: [] });
  assert.equal(p2.fee_lamports_excl_facilitator, 10001);
  // payTo 側が出金なら入金ではない
  assert.equal(parsePayment(tx, { payTo: 'BuyerWa11et111111111111111111111111111111111', mint: USDC }), null);
});

test('x402 の判定: 頻度・間隔で agent、それ以外は既定値', () => {
  const r = loadConfig().classify;
  assert.equal(classifyX402Payer([0, 3600], r).reason, 'default');
  assert.equal(classifyX402Payer([0, 10, 20], r).label, 'agent');
  assert.equal(classifyX402Payer(Array.from({ length: 12 }, (_, i) => i * 3600), r).label, 'agent');
});

test('カードの判定: UA と頻度', () => {
  const r = loadConfig().classify;
  const mk = (n, gap, ua) => Array.from({ length: n }, (_, i) => ({ ts: i * gap, user_agent: ua }));
  assert.equal(classifyCardToken(mk(3, 600, 'python-requests/2.32'), r).label, 'agent');
  assert.equal(classifyCardToken(mk(3, 600, 'curl/8.5.0'), r).label, 'human');
  assert.equal(classifyCardToken(mk(3, 2, 'curl/8.5.0'), r).label, 'agent');
  assert.equal(classifyCardToken(mk(50, 600, 'curl/8.5.0'), r).label, 'unknown');
  assert.equal(classifyCardToken(mk(2, 600, 'SomethingElse/1'), r).label, 'unknown');
});

test('価格の一致チェックと期間', () => {
  const c = cfg();
  assert.equal(findPeriod(c.period, '2026-11-01'), null);
  assert.deepEqual(findPeriod(c.period, '2026-11-02').day, 1);
  assert.equal(findPeriod(c.period, '2026-11-30'), null);
  assert.equal(priceCheck(c.site, findPeriod(c.period, '2026-11-10')), 'ok');
  c.site.items[0].price_usd = 0.02;
  assert.match(priceCheck(c.site, findPeriod(c.period, '2026-11-10')), /^mismatch/);
});

function sample(c, date = '2026-11-03') {
  const t0 = dayBounds(date, '+09:00').start;
  const pay = (payer, amt, dt) => ({ signature: `s${dt}`, block_time: t0 + dt, payer, amount_atomic: amt, fee_lamports: 5000, fee_payer: FAC, fee_lamports_excl_facilitator: 0 });
  return buildDaily({
    date,
    config: c,
    page: { date, views: 40, clicks: { card: 3, x402: 5 } },
    x402Payments: [pay('ExtA', '10000', 100), pay('ExtA', '20000', 7200), pay('OwnProbe', '10000', 300)],
    cardPurchases: [{ created: t0, amount_usd: 5, fee_usd: 0.45, net_usd: 4.55, currency: 'usd', available_on: t0 + 2 * 86400, days_to_available: 2, customer_hash: 'h_c1' }],
    cardCalls: [
      { ts: t0 + 10, token_hash: 'h_t1', endpoint: '/api/jin/series', credits: 1, status: 200, user_agent: 'curl/8' },
      { ts: t0 + 4000, token_hash: 'h_t1', endpoint: '/api/jin/movers', credits: 2, status: 200, user_agent: 'curl/8' },
      { ts: t0 + 50, token_hash: 'h_t2', endpoint: '/api/jin/series', credits: 1, status: 402, user_agent: 'x' },
    ],
    sources: { page: 'ok', x402_chain: 'ok', stripe: 'ok', gateway: 'ok' },
  });
}

test('日次集計: 自社ウォレットを除外し、別枠に出す', () => {
  const d = sample(cfg({ own: ['OwnProbe'] }));
  assert.equal(d.period.id, 'P1');
  assert.equal(d.price_check, 'ok');
  assert.equal(d.external.x402.payments, 2);
  assert.equal(d.external.x402.buyers, 1);
  assert.equal(d.external.x402.revenue_usdc, 0.03);
  assert.deepEqual(d.external.x402.by_endpoint, { series: 1, movers: 1 });
  assert.equal(d.internal.x402.payments, 1);
  assert.equal(d.external.card.purchases, 1);
  assert.equal(d.external.card.credits_consumed, 3);
  assert.equal(d.external.card.calls, 2);
  assert.equal(d.external.card.tokens_by_label.human, 1);
  assert.equal(d.external.card.card_fee_usd_per_purchase, 0.45);
  assert.equal(d.external.card.days_to_available_median, 2);
});

test('週次レポート: 外部購入者なしの週を明記する', () => {
  const c = cfg({ own: ['OwnProbe', 'ExtA'] });
  const days = weekDays('2026-W45');
  const dailies = days.map((d) => {
    const x = sample(c, d);
    x.detail.card_purchases = [];
    x.detail.card_tokens = [];
    x.external.card = { ...x.external.card, purchases: 0, calls: 0, credits_consumed: 0 };
    return x;
  });
  const md = renderWeekly({ label: '2026-W45', days, dailies, config: c });
  assert.match(md, /今週は外部の購入者がいなかった/);
  assert.match(md, /参考値：自社/);
  const partial = renderWeekly({ label: '2026-W45', days, dailies: dailies.slice(0, 5), config: c });
  assert.match(partial, /確認できなかった/);
  assert.match(partial, /日次データなし/);
});

test('週次レポート: 外部購入者ありの表', () => {
  const c = cfg({ own: ['OwnProbe'] });
  const days = weekDays('2026-W45');
  const md = renderWeekly({ label: '2026-W45', days, dailies: [sample(c, days[1])], config: c });
  assert.doesNotMatch(md, /外部の購入者がいなかった/);
  assert.match(md, /\| 成約件数 \| 1（プラン購入数） \| 2（支払い件数） \|/);
});

test('ページ計測: イベントの検証とキー', () => {
  const now = Date.parse('2026-10-13T15:30:00Z') / 1000; // JST 10/14 00:30
  assert.equal(eventKey({ e: 'view' }, now), 'jin:2026-10-14:view');
  assert.equal(eventKey({ e: 'click_x402', i: 'movers' }, now), 'jin:2026-10-14:click_x402:movers');
  assert.equal(eventKey({ e: 'click_x402' }, now), null);
  assert.equal(eventKey({ e: 'nope' }, now), null);
  assert.equal(eventKey(null, now), null);
  assert.ok(isBot('Googlebot/2.1'));
  assert.ok(!isBot('Mozilla/5.0 (Macintosh) Safari/605'));
  const keys = statsKeys('2026-10-14');
  const s = statsFromValues('2026-10-14', keys, keys.map((_, i) => String(i + 1)));
  assert.equal(s.views, 1);
  assert.equal(s.clicks.card, 2);
  assert.equal(s.clicks.x402, 3 + 4);
});

test('Stripe・ゲートウェイの取り込みと匿名化', () => {
  const bt = { created: 100, amount: 500, fee: 45, net: 455, currency: 'usd', available_on: 100 + 86400 * 2, source: { customer: 'cus_X', metadata: { plan: 'jin' } } };
  assert.ok(matchesPlan(bt, {}));
  assert.ok(matchesPlan(bt, { metadata_key: 'plan', metadata_value: 'jin' }));
  assert.ok(!matchesPlan(bt, { metadata_key: 'plan', metadata_value: 'other' }));
  assert.deepEqual(toPurchase(bt), { created: 100, amount_usd: 5, fee_usd: 0.45, net_usd: 4.55, currency: 'usd', available_on: 172900, days_to_available: 2, customer: 'cus_X' });
  const rows = parseUsage('{"ts":"2026-11-03T00:00:00Z","token":"tok","endpoint":"/api/jin/series","credits":1,"user_agent":"curl/8"}\n');
  assert.equal(rows[0].ts, Date.parse('2026-11-03T00:00:00Z') / 1000);
  assert.equal(parseUsage('{"calls":[{"ts":1,"token":"a"}]}')[0].token, 'a');
  const h = anonymize('tok', 'salt');
  assert.match(h, /^h_[0-9a-f]{16}$/);
  assert.equal(h, anonymize('tok', 'salt'));
  assert.notEqual(h, anonymize('tok', 'salt2'));
  assert.throws(() => anonymize('tok', ''));
});
