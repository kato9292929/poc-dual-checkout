// 実証1ゲートウェイのリクエストログ（poc-card-credits の src/log.ts の RequestLogEntry）を読む。
// ログは実証1の外部保存先に UTC 日ごとのファイル（YYYY-MM-DD.jsonl）で置かれる前提で、読み取り専用のトークンで取る。
// JST の1日は UTC の2日にまたがるので、2ファイルを読んで時刻で絞る。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stamp } from './dates.js';

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

// 明細に残す形。tokenId・payerId は実証1で匿名化済み。パスやエラー本文は残さない。
export function toCalls(rows, offset) {
  return rows.map((r) => ({
    ...stamp(Math.floor(Date.parse(r.ts) / 1000), offset),
    token_id: r.tokenId ?? null,
    route_id: r.routeId ?? null,
    outcome: r.outcome,
    credits: Number(r.creditsConsumed || 0),
    latency_ms: Number.isFinite(r.latencyMs) ? Math.round(r.latencyMs) : null,
    upstream_tx: r.upstreamTx ?? null,
  }));
}
