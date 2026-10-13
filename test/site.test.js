import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../scripts/build-site.mjs';
import { loadConfig } from '../lib/config.js';

test('販売ページ: 両方の入口を同じ価格で並べ、未設定のカード入口は準備中にする', () => {
  const site = structuredClone(loadConfig().site);
  let html = render(site);
  assert.doesNotMatch(html, /\{\{/);
  assert.match(html, /カードで購入（準備中）/);
  assert.match(html, /data-track="click_x402" data-item="series"/);
  assert.match(html, /data-track="click_x402" data-item="movers"/);
  assert.match(html, /\$0\.01/);
  assert.match(html, /\$0\.02/);
  assert.doesNotMatch(html, /document\.cookie|localStorage|sessionStorage/);
  site.card.plan_purchase_url = 'https://nevermined.app/plan/123';
  site.card.gateway_base_url = 'https://gw.example.com/';
  html = render(site);
  assert.match(html, /href="https:\/\/nevermined\.app\/plan\/123" data-track="click_card"/);
  assert.match(html, /https:\/\/gw\.example\.com\/api\/jin\/series/);
});
