import { mergeDetails, summarize } from './aggregate.js';

const n = (v) => (v == null ? '—' : String(v));
const usd = (v, d = 2) => (v == null ? '—' : `$${Number(v).toFixed(d)}`);
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const msf = (v) => (v == null ? '—' : `${v} ms`);
const sumBy = (arr, f) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);

function table(s, lat, scope) {
  const u = s.usdc || {};
  const c = s.card;
  const latRow =
    scope === 'external'
      ? `| 決済1件の所要時間（リクエスト〜200） | ${msf(lat.usdc.total_ms_p50)}（計測用の買い手 ${lat.usdc.ok} 回の中央値） | ${msf(lat.card.total_ms_p50)}（同 ${lat.card.ok} 回）／ゲートウェイ内 ${msf(c.gateway_latency_ms_p50)}（外部の買い手の中央値） |`
      : `| ゲートウェイ内の所要時間 | — | ${msf(c.gateway_latency_ms_p50)} |`;
  return [
    '| 項目 | USDC 直接 | カード払い |',
    '|---|---|---|',
    `| 成約件数 | ${n(u.contracts)}（支払い件数） | ${n(c.contracts)}（プラン購入 ${n(c.plan_purchases)}・都度払い ${n(c.per_call_payments)}） |`,
    `| 利用回数 | ${n(u.uses)}（支払い件数） | ${n(c.uses_credits)} クレジット（${n(c.calls)} コール） |`,
    `| 購入者数 | ${n(u.buyers)}（支払い元アドレス数） | ${n(c.buyers)} |`,
    `| 売上 | ${usd(u.revenue_usd)} | ${usd(c.revenue_usd)} |`,
    `| 1件あたりの手数料 | ${usd(u.chain_fee_usd_per_contract, 6)}（チェーン手数料。ファシリテーター負担 ${n(u.fee_paid_by_facilitator)}/${n(u.contracts)} 件） | ${usd(c.card_fee_usd_per_contract, 4)}（カード手数料・実測。Stripe ＋ Nevermined） |`,
    `| 手数料率（売上比） | ${pct(u.fee_rate)} | ${pct(c.fee_rate)} |`,
    latRow,
    `| 着金までの日数 | ${u.contracts ? '即時（0 日）' : '—'} | ${c.days_to_payout_median == null ? '—' : `${c.days_to_payout_median} 日`}（Stripe Connect の入金日。未入金 ${n(c.payouts_pending)} 件） |`,
  ].join('\n');
}

export function renderWeekly({ label, days, dailies, config }) {
  const have = new Set(dailies.map((d) => d.date));
  const missing = days.filter((d) => !have.has(d));
  const s = dailies.length ? summarize(mergeDetails(dailies), config) : null;
  const ext = s?.external;
  const pageDays = dailies.filter((d) => d.page);
  const views = sumBy(pageDays, (d) => d.page.views);
  const openUsdc = sumBy(pageDays, (d) => d.page.opens?.usdc);
  const openCard = sumBy(pageDays, (d) => d.page.opens?.card);

  const ok = (d, k) => d.sources?.[k] === 'ok';
  const full = dailies.length === 7;
  const usdcMeasured = full && dailies.every((d) => ok(d, 'usdc_chain'));
  const cardMeasured =
    full && dailies.every((d) => (ok(d, 'nevermined_events') || ok(d, 'stripe') || ok(d, 'manual_card_payments')) && ok(d, 'gateway_log'));
  const extCount = ext ? (ext.usdc?.contracts || 0) + (ext.card.contracts || 0) + (ext.card.calls || 0) : 0;
  const unmeasured = [!usdcMeasured && 'USDC 直接', !cardMeasured && 'カード払い'].filter(Boolean);

  const periods = [...new Set(dailies.map((d) => (d.period ? `${d.period.id} 第${d.period.day}日` : '期間外')))];
  const modes = [...new Set(dailies.map((d) => d.card_mode))];
  const versions = [...new Set(dailies.map((d) => d.exclusions_version))];
  const priceIssues = dailies.filter((d) => d.price_check?.startsWith('mismatch'));
  const sourceIssues = [];
  for (const d of dailies) for (const [k, v] of Object.entries(d.sources || {})) if (v !== 'ok') sourceIssues.push(`${d.date} ${k}: ${v}`);

  const L = [];
  L.push(`# 週次レポート ${label}`, '');
  L.push(`対象: ${days[0]} 〜 ${days[6]}（${config.period.timezone}） / 期間: ${periods.join(', ') || '—'} / カード: ${modes.join(', ') || '—'} / 除外リスト: ${versions.length ? 'v' + versions.join(', v') : '—'}`, '');
  if (extCount === 0 && !unmeasured.length) {
    L.push('> **今週は外部の購入者がいなかった。** USDC 直接・カード払いのどちらの入口でも、自社を除く成約・利用は 0 件。', '');
  } else if (extCount === 0) {
    L.push(`> **今週、外部の購入者は確認できなかった。** ただし ${unmeasured.join('・')} は一部またはすべての日で計測できていないため、0 件とは言い切れない（下の「データの欠け」を参照）。`, '');
  } else if (unmeasured.length) {
    L.push(`> ${unmeasured.join('・')} は一部またはすべての日で計測できていない。該当する数値は下限として読むこと。`, '');
  }
  if (priceIssues.length) L.push(`> ⚠ 価格の不一致を検知: ${priceIssues.map((d) => `${d.date} ${d.price_check}`).join(' / ')}`, '');

  L.push('## 販売ページ', '');
  L.push('| 閲覧数 | 「USDC で支払う」の説明を開いた回数 | 「カードで支払う」の説明を開いた回数 | 計測できた日数 |');
  L.push('|---|---|---|---|');
  L.push(`| ${views} | ${openUsdc} | ${openCard} | ${pageDays.length} / 7 |`, '');

  L.push('## 入口別（自社を除く）', '');
  L.push(s ? table(ext, s.latency, 'external') : '日次データなし。', '');
  if (s?.card_sources) {
    const cs = s.card_sources;
    L.push(`カード払いの出典: 成約 ${cs.purchases || '—'} / 手数料・入金日 ${cs.fees || '—'} / 利用 ${cs.uses || '—'}`, '');
  }

  L.push('## 参考値：自社の購入', '');
  L.push('AA・Seller Probe・実証1のゲートウェイ・実証1の検証用買い手・実証2の計測用の買い手の分。上の表からは除外している。', '');
  L.push(s ? table(s.internal, s.latency, 'internal') : '日次データなし。', '');

  L.push('## データの欠け', '');
  if (!missing.length && !sourceIssues.length) L.push('なし。');
  for (const m of missing) L.push(`- ${m}: 日次データなし`);
  for (const x of sourceIssues) L.push(`- ${x}`);
  L.push('');
  L.push('## 注記', '');
  L.push('- USDC 直接のチェーン手数料は、トランザクション手数料（SOL）をその日の SOL/USD の終値で換算した。JIN の 402 ではファシリテーターが fee payer になっており、その場合、買い手も売り手も負担していない。');
  L.push('- カード手数料は「買い手の支払額 − 売り手の受取額」。Stripe の手数料と Nevermined の手数料（2%）の両方を含む。');
  L.push('- 決済1件の所要時間は、計測用の買い手が両方の入口を同じ手順（支払いなしで GET → 402 → 支払い情報を付けて GET → 200）で測った値。USDC 直接は署名の時間を含み、カード払いはトークンを事前に発行しておくので、その発行時間は含まない。外部の買い手については、USDC 直接（jin.x402jp.com）側のログを見ないため、カード払いのゲートウェイ内の時間だけを参考に出す。');
  L.push('- 除外リストは `config/exclusions.json`（変更履歴は `config/CHANGELOG.md`）。');
  L.push('');
  return L.join('\n');
}
