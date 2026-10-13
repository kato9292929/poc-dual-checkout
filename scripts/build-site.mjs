#!/usr/bin/env node
// config/site.json から販売ページ（public/index.html）を生成する。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ROOT } from '../lib/config.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (n) => (n < 1 ? n.toFixed(2) : n.toFixed(2).replace(/\.00$/, ''));
const configured = (v) => v && !String(v).startsWith('TODO');

export function render(site) {
  const { card, usdc, items } = site;
  const mode = card.modes[card.mode];
  const gw = configured(card.gateway_base_url) ? card.gateway_base_url.replace(/\/$/, '') : 'https://<ゲートウェイ>';

  const cardCell = (it) =>
    card.mode === 'prepaid'
      ? `${it.card_credits} クレジット<wbr>（$${usd(it.card_credits * card.usd_per_credit)}）`
      : card.mode === 'per_call'
        ? `$${usd(it.price_usd)}`
        : '準備中';
  const priceRows = items
    .map(
      (it) =>
        `<tr><td><strong>${esc(it.name)}</strong><br><code>${esc(new URL(it.usdc_url).pathname)}</code></td><td class="desc">${esc(it.description)}</td>` +
        `<td class="num">$${usd(it.price_usd)}</td><td class="num">${cardCell(it)}</td></tr>`,
    )
    .join('');

  const usdcItems = items
    .map(
      (it) => `<div class="item">
            <div class="row"><h3>${esc(it.name)}</h3><code>$${usd(it.price_usd)} / call</code></div>
            <pre># 支払いなしで呼ぶと 402 と PAYMENT-REQUIRED ヘッダ（amount=${esc(it.usdc_amount_atomic)}）
curl -i ${esc(it.usdc_url)}</pre>
          </div>`,
    )
    .join('\n');
  const cardItems = items
    .map(
      (it) => `<div class="item">
            <div class="row"><h3>${esc(it.name)}</h3><code>${card.mode === 'prepaid' ? `${it.card_credits} クレジット` : `$${usd(it.price_usd)}`} / call</code></div>
            <pre>curl -H "payment-signature: $NVM_ACCESS_TOKEN" \\
  ${esc(gw)}${esc(it.card_path)}</pre>
          </div>`,
    )
    .join('\n');

  const ready = mode && configured(card.plan_purchase_url);
  let cardSummary;
  let cardPrice;
  if (!mode) {
    cardSummary = 'カードでの購入は準備中です。';
    cardPrice = '準備中';
  } else {
    cardSummary = `Nevermined のカードプラン（${esc(mode.label)}）。${esc(mode.summary)}`;
    cardPrice =
      card.mode === 'prepaid'
        ? `$${usd(mode.plan_price_usd)} <span class="muted">/ ${mode.plan_credits} クレジット（${mode.plan_credits} コール相当）</span>`
        : `$0.01〜$0.02 <span class="muted">/ call</span>`;
  }
  const label = card.mode === 'per_call' ? 'カードを登録する' : 'カードでプランを購入';
  const cardButton = ready
    ? `<a class="btn" href="${esc(card.plan_purchase_url)}" rel="noopener">${label}</a>`
    : `<a class="btn" aria-disabled="true">${label}（準備中）</a>`;
  const stepBuy =
    card.mode === 'per_call'
      ? '<li>プランに登録する（呼び出しごとに登録カードへ課金）</li>'
      : '<li>プランを購入する（Stripe Checkout でカード決済。クレジットが付与される）</li>';

  const vars = {
    summary: esc(site.product.summary),
    price_rows: priceRows,
    asset_symbol: esc(usdc.asset_symbol),
    pay_to: esc(usdc.pay_to),
    discovery_url: esc(usdc.discovery_url),
    network: esc(usdc.network),
    first_usdc_url: esc(items[0].usdc_url),
    usdc_items: usdcItems,
    card_summary: cardSummary,
    card_price: cardPrice,
    card_button: cardButton,
    card_step_buy: stepBuy,
    card_items: cardItems,
    nvm_env: esc(card.nvm_environment),
    plan_id: esc(configured(card.nvm_plan_id) ? card.nvm_plan_id : '<PLAN_ID>'),
    agent_id: esc(configured(card.nvm_agent_id) ? card.nvm_agent_id : '<AGENT_ID>'),
    first_card_url: esc(`${gw}${items[0].card_path}`),
  };
  const tpl = readFileSync(join(ROOT, 'site/index.template.html'), 'utf8');
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`template var missing: ${k}`);
    return vars[k];
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const html = render(loadConfig().site);
  mkdirSync(join(ROOT, 'public'), { recursive: true });
  writeFileSync(join(ROOT, 'public/index.html'), html);
  console.log('wrote public/index.html');
}
