import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../scripts/build-site.mjs';
import { loadConfig } from '../lib/config.js';

test('販売ページ: プラン未設定ならカード入口は準備中', () => {
  const site = structuredClone(loadConfig().site);
  site.card.nvm_plan_id = null;
  site.card.plan_purchase_url = null;
  site.card.nvm_environment = 'sandbox';
  const html = render(site);
  assert.doesNotMatch(html, /\{\{/);
  assert.match(html, /aria-disabled="true">カードでプランを購入（準備中）/);
  assert.match(html, /カードでの購入は準備中です/);
  assert.match(html, /data-open="usdc"/);
  assert.match(html, /data-open="card"/);
  assert.ok(html.indexOf('h-usdc') < html.indexOf('h-card'), 'USDC が先');
  assert.doesNotMatch(html, /document\.cookie|localStorage|sessionStorage/);
  assert.doesNotMatch(html, /都度払い|pay-as-you-go/);
});

test('販売ページ: 前払いの価格表示が USDC とそろう', () => {
  const site = structuredClone(loadConfig().site);
  site.card.plan_purchase_url = 'https://nevermined.app/checkout/plan-1';
  site.card.nvm_environment = 'live';
  site.card.purchase_paused = null;
  site.card.gateway_base_url = 'https://gw.example.com/';
  const html = render(site);
  assert.match(html, /href="https:\/\/nevermined\.app\/checkout\/plan-1"/);
  assert.match(html, /\$1 <span class="muted">\/ 100 クレジット/);
  assert.match(html, /<td class="num">\$0\.01<\/td><td class="num">1 クレジット<wbr>（\$0\.01）/);
  assert.match(html, /<td class="num">\$0\.02<\/td><td class="num"><span class="muted">カードでは買えません（USDC のみ）/);
  assert.match(html, /"payment-signature": accessToken/);
  assert.match(html, /https:\/\/gw\.example\.com\/api\/jin\/series/);
  assert.doesNotMatch(html, /gw\.example\.com\/[^"]*movers/); // movers はカードの例に出さない
});

test('販売ページ: Sandbox のプランでは購入ボタンを出さない（テストカードしか通らない）', () => {
  const site = structuredClone(loadConfig().site);
  site.card.nvm_plan_id = '123456';
  site.card.plan_purchase_url = null;
  site.card.nvm_environment = 'sandbox';
  assert.match(render(site), /カードでプランを購入（準備中）/);
  site.card.nvm_environment = 'live';
  site.card.purchase_paused = null;
  assert.match(render(site), /href="https:\/\/nevermined\.app\/checkout\/plan\/123456"/);
});

test('週次レポート: 本番に移った日より前は、カード側の外部の利用が 0（本番未移行のため）と注記する', async () => {
  const { renderWeekly } = await import('../lib/report.js');
  const config = structuredClone(loadConfig());
  const d = (date) => ({ date, sources: {}, detail: { usdc: { payments: [] }, card: { calls: [] } }, classification: {} });
  const days = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'];
  config.site.card.nvm_environment = 'live';
  config.site.card.live_since = '2026-11-05';
  const md = renderWeekly({ label: '2026-W45', days, dailies: days.map(d), config });
  assert.match(md, /2026-11-05 に本番（Live）に移った。2026-11-02〜2026-11-04 は本番前/);
  config.site.card.live_since = '2026-11-01';
  assert.doesNotMatch(renderWeekly({ label: '2026-W45', days, dailies: days.map(d), config }), /本番未移行のため/);
});

test('販売ページ: 本番のプランが入っていれば購入ボタンを出す。purchase_paused の間は止める', () => {
  const site = structuredClone(loadConfig().site);
  assert.match(render(site), site.card.purchase_paused ? /カードでプランを購入（準備中）/ : /カードでプランを購入</);
  site.card.purchase_paused = null;
  const html = render(site);
  assert.match(html, /href="https:\/\/nevermined\.app\/checkout\/plan\/109390300569784239149001680992260682156573712120263169260609849660793213537158"/);
  assert.doesNotMatch(html, /カードでプランを購入（準備中）/);
});
