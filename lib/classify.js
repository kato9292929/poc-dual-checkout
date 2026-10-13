import { median } from './dates.js';

const lc = (s) => String(s || '').toLowerCase();

export function ownWalletSet(rules) {
  return new Set(
    (rules.own?.wallets || []).map((w) => w.address).filter((a) => a && !a.startsWith('TODO')),
  );
}

function intervals(times) {
  const s = [...times].sort((a, b) => a - b);
  const out = [];
  for (let i = 1; i < s.length; i++) out.push(s[i] - s[i - 1]);
  return out;
}

// x402: 支払い元ウォレット1つ分の1日の支払い時刻（Unix 秒）から推定する
export function classifyX402Payer(times, rules) {
  const r = rules.x402;
  const n = times.length;
  const med = median(intervals(times));
  if (n >= r.agent_if_payments_per_day_gte) {
    return { label: 'agent', reason: `支払い ${n} 件/日 ≥ ${r.agent_if_payments_per_day_gte}` };
  }
  if (med != null && med < r.agent_if_median_interval_sec_lt) {
    return { label: 'agent', reason: `支払い間隔の中央値 ${med}s < ${r.agent_if_median_interval_sec_lt}s` };
  }
  return { label: r.default_label, reason: 'default' };
}

// カード: 匿名トークン1つ分の1日の呼び出し [{ts, user_agent}] から推定する
export function classifyCardToken(calls, rules) {
  const r = rules.card;
  const n = calls.length;
  const uas = [...new Set(calls.map((c) => c.user_agent || ''))];
  const med = median(intervals(calls.map((c) => c.ts)));

  const hit = (patterns) => uas.find((ua) => patterns.some((p) => lc(ua).includes(lc(p))));

  const agentUa = hit(r.agent_ua_patterns);
  if (agentUa) return { label: 'agent', reason: `UA: ${agentUa.slice(0, 60)}` };
  if (n >= r.agent_if_calls_per_day_gte) {
    return { label: 'agent', reason: `呼び出し ${n} 件/日 ≥ ${r.agent_if_calls_per_day_gte}` };
  }
  if (med != null && med < r.agent_if_median_interval_sec_lt) {
    return { label: 'agent', reason: `呼び出し間隔の中央値 ${med}s < ${r.agent_if_median_interval_sec_lt}s` };
  }
  const manualUa = hit(r.manual_ua_patterns);
  if (
    manualUa &&
    n <= r.human_if_calls_per_day_lte &&
    (med == null || med >= r.human_if_median_interval_sec_gte)
  ) {
    return { label: 'human', reason: `手動クライアント UA かつ低頻度 (${n} 件/日)` };
  }
  return { label: r.default_label, reason: 'default' };
}

export function countLabels(items, rules) {
  const out = Object.fromEntries(rules.labels.map((l) => [l, 0]));
  for (const it of items) out[it.label] = (out[it.label] || 0) + 1;
  return out;
}
