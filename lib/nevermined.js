// Nevermined の Organizations API（Events & Analytics）。カード払いの件数はゲートウェイのログで数え、ここは照合用。
// Premium 以上の組織でないと 403 になる。そのときは処理を止めず、その日は nvm_api: "unavailable" と記録する。
// 仕様: https://nevermined.ai/docs/agents-guide/check-revenue.md

export const NVM_API = {
  sandbox: 'https://api.sandbox.nevermined.app/api/v1',
  live: 'https://api.live.nevermined.app/api/v1',
};

export class NvmHttpError extends Error {
  constructor(path, status, body) {
    super(`nevermined ${path}: HTTP ${status} ${String(body).slice(0, 120)}`);
    this.status = status;
  }
}

async function get(base, path, params, key) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null)).toString();
  const res = await fetch(`${base}${path}${qs ? `?${qs}` : ''}`, { headers: { authorization: `Bearer ${key}` } });
  const text = await res.text();
  if (!res.ok) throw new NvmHttpError(path, res.status, text);
  return JSON.parse(text);
}

export function assertOrgId(orgId) {
  // 形の崩れた orgId は 200 の全ゼロが返るので、先に弾く（check-revenue の注意書き）
  if (!/^org-[0-9a-f-]+$/i.test(orgId || '')) throw new Error(`NVM_ORG_ID の形が不正: ${orgId}`);
}

const forPlan = (planId) => (id) => !planId || planId.startsWith('TODO') || id === planId;

// 照合用の数字（自社分を含む組織全体の値）
export async function reconcile({ base, key, orgId }, { from, to, planId }) {
  assertOrgId(orgId);
  const B = `/organizations/${orgId}`;
  const mine = forPlan(planId);
  const [revenue, usage] = await Promise.all([
    get(base, `${B}/analytics/revenue`, { from, to }, key),
    get(base, `${B}/analytics/usage`, { from, to }, key),
  ]);
  let purchased = 0;
  for (let page = 1; ; page++) {
    const r = await get(base, `${B}/activity`, { page, limit: 200, eventType: 'plan.purchased', from, to }, key);
    purchased += r.items.filter((e) => mine(e.subject?.id)).length;
    if (page * 200 >= r.total || !r.items.length) break;
  }
  return summarizeReconcile({ revenue, usage, purchased }, planId);
}

export function summarizeReconcile({ revenue, usage, purchased }, planId) {
  const mine = forPlan(planId);
  const rev = (revenue.items || []).filter((r) => mine(r.agentId)); // 行のラベルは agentId だが実際はプラン単位
  const use = (usage.items || []).filter((r) => mine(r.planId));
  return {
    plan_purchased_events: purchased,
    revenue_usd: rev.reduce((s, r) => s + Number(r.totalRevenue || 0), 0) / 1e6,
    transaction_count: rev.reduce((s, r) => s + Number(r.transactionCount || 0), 0),
    credits_burned: use.reduce((s, r) => s + Number(r.creditsBurned || 0), 0),
    unique_users: use.reduce((s, r) => s + Number(r.uniqueUsers || 0), 0),
  };
}
