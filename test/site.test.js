import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../scripts/build-site.mjs';
import { loadConfig } from '../lib/config.js';

test('販売ページ: プラン未設定ならカード入口は準備中', () => {
  const site = structuredClone(loadConfig().site);
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
  site.card.gateway_base_url = 'https://gw.example.com/';
  const html = render(site);
  assert.match(html, /href="https:\/\/nevermined\.app\/checkout\/plan-1"/);
  assert.match(html, /\$1 <span class="muted">\/ 100 クレジット/);
  assert.match(html, /<td class="num">\$0\.01<\/td><td class="num">1 クレジット<wbr>（\$0\.01）/);
  assert.match(html, /<td class="num">\$0\.02<\/td><td class="num">2 クレジット<wbr>（\$0\.02）/);
  assert.match(html, /"payment-signature": accessToken/);
  assert.match(html, /https:\/\/gw\.example\.com\/jin\/movers/);
});
