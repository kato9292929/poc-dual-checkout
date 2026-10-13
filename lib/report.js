import { median } from './dates.js';

const fmt = (v, d = 2) => (v == null || Number.isNaN(v) ? '—' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(d)) : String(v));
const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);

function ratio(byLabel) {
  const h = byLabel.human || 0;
  const a = byLabel.agent || 0;
  const u = byLabel.unknown || 0;
  if (!h && !a && !u) return '—';
  return `人間 ${h} / エージェント ${a} / 不明 ${u}`;
}

function addLabels(target, src) {
  for (const [k, v] of Object.entries(src || {})) target[k] = (target[k] || 0) + v;
  return target;
}

// 1週間分の集計。scope は 'external' か 'internal'
export function summarizeWeek(dailies, scope) {
  const own = scope === 'internal';
  const pick = (d) => d[scope];
  const x402Payers = new Set();
  const cardBuyers = new Set();
  const cardTokens = new Map();
  const x402PayerLabel = new Map();
  let anonBuyers = 0;
  for (const d of dailies) {
    for (const p of d.detail.x402_payers) if (p.own === own) {
      x402Payers.add(p.address);
      // 週内で一度でも agent と判定されたら agent とする
      if (x402PayerLabel.get(p.address) !== 'agent') x402PayerLabel.set(p.address, p.label);
    }
    for (const p of d.detail.card_purchases) if (p.own === own) (p.customer_hash ? cardBuyers.add(p.customer_hash) : anonBuyers++);
    for (const t of d.detail.card_tokens) if (t.own === own && cardTokens.get(t.token_hash) !== 'agent') cardTokens.set(t.token_hash, t.label);
  }
  const countMap = (m) => [...m.values()].reduce((o, l) => ((o[l] = (o[l] || 0) + 1), o), {});
  const card = {
    purchases: sum(dailies, (d) => pick(d).card.purchases),
    revenue_usd: sum(dailies, (d) => pick(d).card.revenue_usd),
    credits_consumed: sum(dailies, (d) => pick(d).card.credits_consumed),
    calls: sum(dailies, (d) => pick(d).card.calls),
    buyers: cardBuyers.size + anonBuyers,
    tokens_by_label: countMap(cardTokens),
    calls_by_label: dailies.reduce((o, d) => addLabels(o, pick(d).card.calls_by_label), {}),
    fee_usd: sum(dailies, (d) => pick(d).card.card_fee_usd_total),
    days_to_available: median(dailies.flatMap((d) => d.detail.card_purchases.filter((p) => p.own === own).map((p) => p.days_to_available))),
  };
  card.fee_per_purchase = card.purchases ? card.fee_usd / card.purchases : null;
  const x402 = {
    payments: sum(dailies, (d) => pick(d).x402.payments),
    revenue_usdc: sum(dailies, (d) => pick(d).x402.revenue_usdc),
    buyers: x402Payers.size,
    buyers_by_label: countMap(x402PayerLabel),
    uses_by_label: dailies.reduce((o, d) => addLabels(o, pick(d).x402.uses_by_label), {}),
    fee_lamports_excl: sum(dailies, (d) => pick(d).x402.chain_fee_lamports_excl_facilitator),
  };
  x402.fee_sol_per_payment = x402.payments ? x402.fee_lamports_excl / x402.payments / 1e9 : null;
  return { card, x402 };
}

function table(s) {
  const { card, x402 } = s;
  return [
    '| 項目 | カード払い | x402 |',
    '|---|---|---|',
    `| 成約件数 | ${card.purchases}（プラン購入数） | ${x402.payments}（支払い件数） |`,
    `| 利用回数 | ${card.credits_consumed} クレジット（${card.calls} コール） | ${x402.payments}（1件＝1回） |`,
    `| 購入者数 | ${card.buyers}（プラン購入者数） | ${x402.buyers}（支払い元アドレス数） |`,
    `| 売上 | $${fmt(card.revenue_usd)} | ${fmt(x402.revenue_usdc)} USDC |`,
    `| 人間 / エージェントの比（購入者・トークン単位） | ${ratio(card.tokens_by_label)} | ${ratio(x402.buyers_by_label)} |`,
    `| 人間 / エージェントの比（利用回数） | ${ratio(card.calls_by_label)} | ${ratio(x402.uses_by_label)} |`,
    `| 1件あたりの手数料 | $${fmt(card.fee_per_purchase, 4)}（カード手数料） | ${fmt(x402.fee_sol_per_payment, 9)} SOL（ファシリテーター負担分を除く） |`,
    `| 売上の入金までの日数 | ${fmt(card.days_to_available, 1)} 日（Stripe available_on の中央値） | 0 日（受取アドレスへ即時着金） |`,
  ].join('\n');
}

export function renderWeekly({ label, days, dailies, config }) {
  const have = new Set(dailies.map((d) => d.date));
  const missing = days.filter((d) => !have.has(d));
  const ext = summarizeWeek(dailies, 'external');
  const int = summarizeWeek(dailies, 'internal');
  const views = sum(dailies, (d) => d.page?.views);
  const clickCard = sum(dailies, (d) => d.page?.clicks?.card);
  const clickX402 = sum(dailies, (d) => d.page?.clicks?.x402);
  const pageDays = dailies.filter((d) => d.page).length;
  const noExternal = ext.card.purchases === 0 && ext.x402.payments === 0 && ext.card.calls === 0;
  const periods = [...new Set(dailies.map((d) => (d.period ? `${d.period.id} 第${d.period.day}日` : '期間外')))];
  const versions = [...new Set(dailies.map((d) => d.classify_version))];
  const priceIssues = dailies.filter((d) => d.price_check?.startsWith('mismatch'));
  const sourceIssues = [];
  for (const d of dailies) for (const [k, v] of Object.entries(d.sources || {})) if (v !== 'ok') sourceIssues.push(`${d.date} ${k}: ${v}`);

  const L = [];
  L.push(`# 週次レポート ${label}`);
  L.push('');
  L.push(`対象: ${days[0]} 〜 ${days[6]}（${config.period.timezone}） / 期間: ${periods.join(', ') || '—'} / 判定ルール: ${versions.length ? 'v' + versions.join(', v') : '—'}`);
  L.push('');
  const measured = (keys) => dailies.length === 7 && dailies.every((d) => keys.every((k) => d.sources?.[k] === 'ok'));
  const unmeasured = [
    !measured(['stripe', 'gateway']) && 'カード払い',
    !measured(['x402_chain']) && 'x402',
  ].filter(Boolean);
  if (noExternal && !unmeasured.length) {
    L.push('> **今週は外部の購入者がいなかった。** カード払い・x402 のどちらの入口でも、自社を除く成約・利用は 0 件。');
    L.push('');
  } else if (noExternal) {
    L.push(`> **今週、外部の購入者は確認できなかった。** ただし ${unmeasured.join('・')} は一部またはすべての日で計測できていないため、0 件とは言い切れない（下の「データの欠け」を参照）。`);
    L.push('');
  } else if (unmeasured.length) {
    L.push(`> ${unmeasured.join('・')} は一部またはすべての日で計測できていない。該当する数値は下限として読むこと。`);
    L.push('');
  }
  if (priceIssues.length) {
    L.push(`> ⚠ 価格の不一致を検知: ${priceIssues.map((d) => `${d.date} ${d.price_check}`).join(' / ')}`);
    L.push('');
  }
  L.push('## 販売ページ');
  L.push('');
  L.push('| 閲覧数 | 「カードで購入」クリック | 「x402 で購入」クリック | 計測できた日数 |');
  L.push('|---|---|---|---|');
  L.push(`| ${views} | ${clickCard} | ${clickX402} | ${pageDays} / 7 |`);
  L.push('');
  L.push('## 入口別（自社を除く）');
  L.push('');
  L.push(table(ext));
  L.push('');
  L.push('## 参考値：自社のエージェント・テスト購入');
  L.push('');
  L.push('上の表からは除外している。');
  L.push('');
  L.push(table(int));
  L.push('');
  L.push('## データの欠け');
  L.push('');
  if (!missing.length && !sourceIssues.length) L.push('なし。');
  for (const m of missing) L.push(`- ${m}: 日次データなし`);
  for (const s of sourceIssues) L.push(`- ${s}`);
  L.push('');
  L.push('## 注記');
  L.push('');
  L.push('- 人間 / エージェントの判定は推定。ルールは `config/classify.json`（変更履歴は `config/CHANGELOG.md`）。');
  L.push('- カード側の「人間」は手動クライアントの UA かつ低頻度の呼び出し。プラン購入そのものは人間とみなしている。');
  L.push('- x402 のチェーン手数料は、ファシリテーターが fee payer のトランザクションでは 0 として数えている。');
  L.push('');
  return L.join('\n');
}
