#!/usr/bin/env node
// config/site.json から販売ページ（public/index.html）を生成する。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ROOT } from '../lib/config.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (n) => (n < 1 ? n.toFixed(2) : n.toFixed(2).replace(/\.00$/, ''));
const configured = (v) => v && !String(v).startsWith('TODO');

export function render(site) {
  const { card, x402, items } = site;
  const priceRows = items
    .map(
      (it) =>
        `<tr><td><strong>${esc(it.name)}</strong><br><code>${esc(new URL(it.x402_url).pathname)}</code></td><td class="desc">${esc(it.description)}</td>` +
        `<td class="num">$${usd(it.price_usd)}</td><td class="num">${it.card_credits} クレジット<wbr>（$${usd(it.card_credits * card.usd_per_credit)}）</td></tr>`,
    )
    .join('');

  const cardButton = configured(card.plan_purchase_url)
    ? `<a class="btn" href="${esc(card.plan_purchase_url)}" data-track="click_card" rel="noopener">カードで購入（$${usd(card.plan_price_usd)}）</a>`
    : `<a class="btn" aria-disabled="true" data-track="click_card">カードで購入（準備中）</a>`;

  const first = items[0];
  const cardExample = configured(card.gateway_base_url)
    ? `<p class="muted">購入後の呼び出し例</p><pre>curl -H "Authorization: Bearer $JIN_API_KEY" \\\n  ${esc(card.gateway_base_url.replace(/\/$/, ''))}${esc(new URL(first.x402_url).pathname)}</pre>`
    : '';

  const x402Items = items
    .map(
      (it) => `<div class="item">
        <div class="row"><h3>${esc(it.name)}</h3><code>$${usd(it.price_usd)} / call</code></div>
        <code>GET ${esc(it.x402_url)}</code>
        <pre id="ex-${esc(it.id)}"># 1) 支払い要求を受け取る（HTTP 402 と PAYMENT-REQUIRED ヘッダ）
curl -i ${esc(it.x402_url)}

# 2) x402 v2 対応クライアントで支払って呼び出す
#    scheme=exact, network=${esc(x402.network)},
#    asset=${esc(x402.asset_symbol)}, amount=${esc(it.x402_amount_atomic)} (${usd(it.price_usd)} USDC)
#    PAYMENT-SIGNATURE ヘッダを付けて再リクエストする</pre>
        <div><button class="btn ghost" type="button" data-track="click_x402" data-item="${esc(it.id)}" data-copy="ex-${esc(it.id)}">呼び出し例をコピー</button></div>
      </div>`,
    )
    .join('\n');

  const creditRules = items.map((it) => `${it.id} = ${it.card_credits}`).join('、');

  const vars = {
    summary: esc(site.product.summary),
    price_rows: priceRows,
    plan_credits: card.plan_credits,
    plan_price: usd(card.plan_price_usd),
    usd_per_credit: usd(card.usd_per_credit),
    plan_name: esc(card.plan_name),
    credit_rules: esc(creditRules),
    card_button: cardButton,
    card_example: cardExample,
    asset_symbol: esc(x402.asset_symbol),
    pay_to: esc(x402.pay_to),
    discovery_url: esc(x402.discovery_url),
    x402_items: x402Items,
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
