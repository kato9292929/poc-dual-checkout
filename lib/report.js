import { mergeDetails, summarize, findPeriod, periodPhase } from './aggregate.js';

const n = (v) => (v == null ? '—' : String(v));
const usd = (v, d = 2) => (v == null ? '—' : `$${Number(v).toFixed(d)}`);
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const msf = (v) => (v == null ? '—' : `${v} ms`);
const sumBy = (arr, f) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);

function table(s) {
  const u = s.usdc || {};
  const c = s.card;
  return [
    '| 項目 | USDC 直接 | カード払い |',
    '|---|---|---|',
    `| 成約件数 | ${n(u.contracts)}（支払い件数） | ${n(c.plan_purchases)}（プラン購入件数・${c.plan_purchases_source === 'nvm_events' ? 'Nevermined イベント' : 'Stripe'}） |`,
    `| 利用回数 | ${n(u.uses)}（支払い件数） | ${n(c.uses_credits)} クレジット（${n(c.calls)} コール・ゲートウェイログ） |`,
    `| 購入者数 | ${n(u.buyers)}（支払い元アドレス数） | ${n(c.buyers)}（匿名化したトークン ID の数） |`,
    `| 売上 | ${usd(u.revenue_usd)} | ${usd(c.revenue_usd)} |`,
    `| 1件あたりの手数料（売る側の負担） | ${usd(u.seller_fee_usd_per_contract, 6)}（チェーン手数料のうち seller が払った分） | ${usd(c.card_fee_usd_per_contract, 4)}（カード手数料・実測） |`,
    `| 手数料率（売る側の負担・売上比） | ${pct(u.seller_fee_rate)} | ${pct(c.fee_rate)} |`,
    `| 参考：facilitator が払ったチェーン手数料 | ${usd(u.facilitator_fee_usd, 6)}（売上比 ${pct(u.facilitator_fee_rate)}、${n(u.fee_by_payer?.facilitator?.txs)}/${n(u.contracts)} 件） | — |`,
    `| 参考：buyer が払ったチェーン手数料 | ${usd(u.fee_by_payer?.buyer?.usd, 6)}（${n(u.fee_by_payer?.buyer?.txs)} 件） | — |`,
    `| 照合：プラン購入件数（Stripe / Nevermined イベント） | — | ${n(c.plan_purchases_stripe)} / ${n(c.plan_purchases_nvm_events)} |`,
    `| ゲートウェイ内の所要時間 | — | ${msf(c.gateway_latency_ms_p50)}（中央値） |`,
    `| 着金までの日数 | ${u.contracts ? '即時（0 日）' : '—'} | ${c.days_to_payout_median == null ? '—' : `${c.days_to_payout_median} 日`}（Stripe Connect。未着金 ${n(c.payouts_pending)} 件） |`,
  ].join('\n');
}

function partyTable(parties, cls) {
  const rows = [];
  for (const p of parties.usdc || []) if (p.class === cls) rows.push(`| USDC 直接 | \`${p.id}\` | ${p.count} | ${p.note || ''} |`);
  for (const p of parties.card_tokens || []) if (p.class === cls) rows.push(`| カード払い | \`${p.id}\` | ${p.count} | ${p.note || ''} |`);
  if (!rows.length) return '';
  return ['| 入口 | 支払い元アドレス / トークン ID | 件数 | 注記 |', '|---|---|---|---|', ...rows].join('\n');
}

const activity = (s) => (s.usdc?.contracts || 0) + (s.card.plan_purchases || 0) + (s.card.calls || 0);

const PHASE_LABEL = { no_period: '開始日未設定', pre_period: '期間前', post_period: '期間後', in_period: '期間中' };

export function renderWeekly({ label, days, dailies: all, config }) {
  // 期間は保存値ではなく、いまの period.json から日ごとに求め直す（開始日をあとで入れても正しく分かれる）
  const phased = all.map((d) => ({ d, phase: periodPhase(config.period, d.date), p: findPeriod(config.period, d.date) }));
  const dailies = phased.filter((x) => x.phase === 'in_period').map((x) => x.d);
  const outside = phased.filter((x) => x.phase !== 'in_period');
  const have = new Set(all.map((d) => d.date));
  // 欠けとして数えるのは期間中の日だけ
  const missing = days.filter((d) => findPeriod(config.period, d) && !have.has(d));
  const s = dailies.length ? summarize(mergeDetails(dailies), config) : null;
  const so = outside.length ? summarize(mergeDetails(outside.map((x) => x.d)), config) : null;
  const pageDays = dailies.filter((d) => d.page);

  const ok = (d, k) => d.sources?.[k] === 'ok';
  const inDays = days.filter((d) => findPeriod(config.period, d)).length;
  const full = inDays > 0 && dailies.length === inDays;
  const usdcMeasured = full && dailies.every((d) => ok(d, 'usdc_chain'));
  const cardMeasured = full && dailies.every((d) => ok(d, 'gateway_log'));
  const gatewayMissing = dailies.filter((d) => d.sources?.gateway_log === 'missing').map((d) => d.date);
  const unmeasured = [!usdcMeasured && 'USDC 直接', !cardMeasured && 'カード払い'].filter(Boolean);
  const ext = s ? activity(s.by_class.external) : 0;
  const unc = s ? activity(s.by_class.unclassified) : 0;

  const periods = [...new Set(phased.map((x) => (x.p ? `${x.p.id} 第${x.p.day}日` : PHASE_LABEL[x.phase])))];
  const versions = [...new Set(all.map((d) => `own v${d.classification?.own_wallets_version} / external v${d.classification?.external_buyers_version}`))];
  // 価格の固定値との照合は期間中の日だけ（期間前は価格を変えてよい）
  const priceIssues = phased.filter((x) => x.phase === 'in_period' && x.d.price_check?.startsWith('mismatch')).map((x) => x.d);
  const sourceIssues = [];
  for (const d of dailies) for (const [k, v] of Object.entries(d.sources || {})) if (v !== 'ok' && k !== 'nvm_api_reason' && k !== 'gateway_log_backfilled_at') sourceIssues.push(`${d.date} ${k}: ${v}`);

  const L = [];
  L.push(`# 週次レポート ${label}`, '');
  L.push(`対象: ${days[0]} 〜 ${days[6]}（${config.period.timezone}、各日 00:00〜24:00） / 期間: ${periods.join(', ') || '—'} / 分類リスト: ${versions.join(', ') || '—'}`, '');
  if (outside.length) {
    L.push(`> 期間外の日（${outside.map((x) => `${x.d.date} ${PHASE_LABEL[x.phase]}`).join(', ')}）は本表に含めない。参考として末尾の「期間外の日」に出す。`, '');
  }
  if (!dailies.length) {
    L.push(`> **この週に計測期間中の日はない**（${config.period.periods.some((p) => /^\d{4}-/.test(p.start)) ? '期間外の週' : '開始日（config/period.json）が未設定'}）。以下の本表は空。`, '');
  } else if (ext === 0) {
    const parts = ['**今週は外部の購入者がいなかった**（外部と確定した購入者による成約・利用は 0 件）。'];
    if (unc) parts.push(`ただし未分類（unclassified）が ${unc} 件ある（下の別表）。外部かどうかは確定していない。`);
    if (unmeasured.length) parts.push(`${unmeasured.join('・')} は一部またはすべての日で計測できていない（「データの欠け」を参照）。`);
    L.push(`> ${parts.join('')}`, '');
  } else if (unmeasured.length) {
    L.push(`> ${unmeasured.join('・')} は一部またはすべての日で計測できていない。該当する数値は下限として読むこと。`, '');
  }
  if (gatewayMissing.length) L.push(`> カード払いの利用件数は、実証1ゲートウェイのログが欠損している日がある（${gatewayMissing.join(', ')}）。口がつながったら \`--resummarize\` で数え直す。`, '');
  if (priceIssues.length) L.push(`> ⚠ 価格の不一致を検知: ${priceIssues.map((d) => `${d.date} ${d.price_check}`).join(' / ')}`, '');

  L.push('## 販売ページ', '');
  L.push('| 閲覧数 | 「USDC で支払う」の説明を開いた回数 | 「カードで支払う」の説明を開いた回数 | 計測できた日数 |');
  L.push('|---|---|---|---|');
  L.push(`| ${sumBy(pageDays, (d) => d.page.views)} | ${sumBy(pageDays, (d) => d.page.opens?.usdc)} | ${sumBy(pageDays, (d) => d.page.opens?.card)} | ${pageDays.length} / ${inDays} |`, '');

  L.push('## 入口別：外部の購入者（external）', '');
  L.push('`config/external_buyers.json` で外部と確定した購入者だけ。', '');
  L.push(s ? table(s.by_class.external) : '日次データなし。', '');

  L.push('## 別表：未分類（unclassified）', '');
  L.push('自社のリストにも外部のリストにも一致しないもの。自動で外部には入れない。確認して `config/own_wallets.json` か `config/external_buyers.json` に振り分ける。', '');
  if (s) {
    L.push(table(s.by_class.unclassified), '');
    const pt = partyTable(s.parties, 'unclassified');
    if (pt) L.push('支払い元・購入者', '', pt, '');
  } else L.push('日次データなし。', '');

  L.push('## 参考値：自社の購入（own）', '');
  L.push('AA・Seller Probe・実証1のゲートウェイ（裏側の JIN 購入を含む）・実証1の検証用買い手・実証2の計測用の買い手。上の表からは除外している。', '');
  L.push(s ? table(s.by_class.own) : '日次データなし。', '');

  L.push('## 決済1件の所要時間（リクエストから 200 まで）', '');
  if (s) {
    const lt = s.latency;
    L.push('| 入口 | 中央値 | 90% | 計測回数（成功 / 実行） | 402 まで | 署名 | 支払い付きリクエスト |');
    L.push('|---|---|---|---|---|---|---|');
    for (const [k, name] of [['usdc', 'USDC 直接'], ['card', 'カード払い']]) {
      const x = lt[k];
      L.push(`| ${name} | ${msf(x.total_ms_p50)} | ${msf(x.total_ms_p90)} | ${x.ok} / ${x.runs} | ${msf(x.first_402_ms_median)} | ${msf(x.sign_ms_median)} | ${msf(x.paid_request_ms_median)} |`);
    }
    L.push('', '計測用の買い手（自社）が両方の入口を同じ手順で測った値（`docs/sources.md`）。', '');
  } else L.push('日次データなし。', '');

  if (so) {
    L.push('## 期間外の日（参考。本表に含めない）', '');
    L.push(`対象: ${outside.map((x) => `${x.d.date}（${PHASE_LABEL[x.phase]}）`).join(', ')}`, '');
    L.push('| 区分 | USDC 直接の支払い件数 | USDC 直接の売上 | カードの利用（コール） | カードのプラン購入 |');
    L.push('|---|---|---|---|---|');
    for (const [k, name] of [['external', '外部'], ['unclassified', '未分類'], ['own', '自社']]) {
      const x = so.by_class[k];
      L.push(`| ${name} | ${n(x.usdc?.contracts)} | ${usd(x.usdc?.revenue_usd)} | ${n(x.card.calls)} | ${n(x.card.plan_purchases)} |`);
    }
    const pt = partyTable(so.parties, 'unclassified');
    if (pt) L.push('', '未分類の支払い元・購入者', '', pt);
    L.push('');
  }

  L.push('## データの欠け', '');
  if (!missing.length && !sourceIssues.length) L.push('なし。');
  for (const m of missing) L.push(`- ${m}: 日次データなし`);
  for (const x of sourceIssues) L.push(`- ${x}`);
  L.push('');
  L.push('## 注記', '');
  L.push('- 本表は計測期間中（`config/period.json`）の日だけを数える。期間は日次データの保存値ではなく、レポートを出すたびに今の設定から求め直す。価格の固定値との照合も期間中の日だけに当てる。');
  L.push('- 日次の区切りは JST の 00:00〜24:00。各トランザクションには UTC の時刻と JST の日付の両方を記録している。');
  L.push('- カード払いの利用回数・購入者は実証1ゲートウェイのログ（購入者＝匿名化したトークン ID）、手数料と着金日は Stripe。Nevermined の Events & Analytics は照合用で、自社分を含む。');
  L.push('- USDC 直接のチェーン手数料は、トランザクション手数料（SOL）をその日の SOL/USD の終値で換算した。tx ごとに fee payer が誰か（facilitator / seller / buyer）を記録し、売る側の手数料率には seller が払った分だけを入れる。facilitator が払った分は参考値として別の行に出す。');
  L.push('- カード手数料は「買い手の支払額 − 売り手の受取額」で、Stripe と Nevermined（2%）の両方を含む。');
  L.push('');
  return L.join('\n');
}
