// 実証1ゲートウェイの利用ログを読む。形式は docs/card-source.md。

export function normalizeCall(c) {
  const ts = typeof c.ts === 'number' ? c.ts : Math.floor(Date.parse(c.ts) / 1000);
  return {
    ts,
    token: c.token ?? c.token_id ?? c.subscriber ?? null,
    endpoint: c.endpoint ?? null,
    credits: Number(c.credits ?? 0),
    status: Number(c.status ?? 200),
    user_agent: c.user_agent ?? c.ua ?? '',
  };
}

export function parseUsage(text) {
  const t = text.trim();
  if (!t) return [];
  let rows;
  if (t.startsWith('[') || t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      rows = Array.isArray(j) ? j : j.calls;
    } catch {
      rows = null;
    }
  }
  if (!rows) rows = t.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return rows.map(normalizeCall);
}

export async function fetchUsage(url, token, start, end) {
  const u = new URL(url);
  u.searchParams.set('from', new Date(start * 1000).toISOString());
  u.searchParams.set('to', new Date(end * 1000).toISOString());
  const res = await fetch(u, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new Error(`gateway usage: HTTP ${res.status}`);
  return parseUsage(await res.text()).filter((c) => c.ts >= start && c.ts < end);
}
