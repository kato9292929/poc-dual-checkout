// 実証1ゲートウェイのリクエストログ（poc-card-credits の src/log.ts の RequestLogEntry）を読む。
// ログは UTC 日ごとのファイル（YYYY-MM-DD.jsonl）なので、JST の1日をまたぐ2ファイルを読んで時刻で絞る。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function parseJsonl(text) {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function utcDays(start, end) {
  const days = new Set();
  for (let t = start; t < end; t += 3600) days.add(new Date(t * 1000).toISOString().slice(0, 10));
  return [...days];
}

async function readDay(day, { dir, url, token }) {
  if (dir) {
    const f = join(dir, `${day}.jsonl`);
    return existsSync(f) ? parseJsonl(readFileSync(f, 'utf8')) : [];
  }
  const res = await fetch(url.replace('{day}', day), { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`gateway log ${day}: HTTP ${res.status}`);
  return parseJsonl(await res.text());
}

export async function fetchGatewayLog({ dir, url, token }, start, end) {
  const rows = [];
  for (const day of utcDays(start, end)) rows.push(...(await readDay(day, { dir, url, token })));
  return rows.filter((r) => {
    const t = Date.parse(r.ts) / 1000;
    return t >= start && t < end;
  });
}

// 明細に残す形にまとめる。payerId は実証1で匿名化済み。トークンID・パスは残さない。
export function summarizeGatewayLog(rows) {
  const byPayer = new Map();
  const upstreamTxs = [];
  for (const r of rows) {
    if (r.upstreamTx) upstreamTxs.push(r.upstreamTx);
    const k = r.payerId || null;
    if (!byPayer.has(k)) byPayer.set(k, { payer_id: k, calls_ok: 0, credits: 0, by_route: {}, failures: {}, latency_ms: [] });
    const p = byPayer.get(k);
    if (r.outcome === 'ok') {
      p.calls_ok++;
      p.credits += Number(r.creditsConsumed || 0);
      p.by_route[r.routeId || 'unknown'] = (p.by_route[r.routeId || 'unknown'] || 0) + 1;
      if (Number.isFinite(r.latencyMs)) p.latency_ms.push(Math.round(r.latencyMs));
    } else {
      p.failures[r.outcome] = (p.failures[r.outcome] || 0) + 1;
    }
  }
  return { payers: [...byPayer.values()], upstream_txs: upstreamTxs };
}
