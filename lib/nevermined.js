// Nevermined の Organizations API（Events & Analytics）。Premium 以上の組織でだけ使える。
// 仕様: https://nevermined.ai/docs/agents-guide/check-revenue.md
//       https://nevermined.ai/docs/api-reference/organizations--activity/list-organization-activity-events.md

export const NVM_API = {
  sandbox: 'https://api.sandbox.nevermined.app/api/v1',
  live: 'https://api.live.nevermined.app/api/v1',
};

async function get(base, path, params, key) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();
  const res = await fetch(`${base}${path}${qs ? `?${qs}` : ''}`, { headers: { authorization: `Bearer ${key}` } });
  const text = await res.text();
  if (!res.ok) throw new Error(`nevermined ${path}: HTTP ${res.status} ${text.slice(0, 120)}`);
  return JSON.parse(text);
}

export function assertOrgId(orgId) {
  // 形の崩れた orgId は 200 の全ゼロが返るので、先に弾く（check-revenue の注意書き）
  if (!/^org-[0-9a-f-]+$/i.test(orgId || '')) throw new Error(`NVM_ORG_ID の形が不正: ${orgId}`);
}

export async function listActivity({ base, key, orgId }, { from, to, eventType }) {
  assertOrgId(orgId);
  const items = [];
  for (let page = 1; ; page++) {
    const r = await get(base, `/organizations/${orgId}/activity`, { page, limit: 200, eventType, from, to }, key);
    items.push(...r.items);
    if (items.length >= r.total || !r.items.length) break;
  }
  return items;
}

export async function analytics({ base, key, orgId }, { from, to }) {
  assertOrgId(orgId);
  const B = `/organizations/${orgId}/analytics`;
  const [revenue, usage] = await Promise.all([
    get(base, `${B}/revenue`, { from, to }, key),
    get(base, `${B}/usage`, { from, to }, key),
  ]);
  return { revenue, usage };
}

// plan.purchased イベント → 購入の明細（userId は匿名化する）
export function purchasesFromEvents(events, { planId, anonymize }) {
  return events
    .filter((e) => e.eventType === 'plan.purchased')
    .filter((e) => !planId || planId.startsWith('TODO') || e.subject?.id === planId)
    .map((e) => ({
      source: 'nevermined',
      kind: 'plan',
      ts: Math.floor(Date.parse(e.occurredAt) / 1000),
      buyer_hash: anonymize(e.actorUserId),
    }));
}

// 組織全体の集計値（自社分を含む。参考値として残す）
export function totalsFromAnalytics({ revenue, usage }, planId) {
  const pick = (rows, key) => (rows || []).filter((r) => !planId || planId.startsWith('TODO') || r[key] === planId);
  const rev = pick(revenue.items, 'agentId'); // 行のラベルは agentId だが実際はプラン単位
  const use = pick(usage.items, 'planId');
  return {
    revenue_usd: rev.reduce((s, r) => s + Number(r.totalRevenue || 0), 0) / 1e6,
    transaction_count: rev.reduce((s, r) => s + Number(r.transactionCount || 0), 0),
    credits_burned: use.reduce((s, r) => s + Number(r.creditsBurned || 0), 0),
    unique_users: use.reduce((s, r) => s + Number(r.uniqueUsers || 0), 0),
  };
}
