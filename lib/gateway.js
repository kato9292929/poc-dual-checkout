// 実証1ゲートウェイのリクエストログ（poc-card-credits の src/log.ts の RequestLogEntry）を読む。
// GET {gateway}/logs/:date（:date は JST の日付、Bearer は LOG_READ_TOKEN）で1日分を取る。
// 念のため、受け取った行は JST のその日の範囲（時刻）でも絞る。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stamp } from './dates.js';

export function parseJsonl(text) {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
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

// date は JST の日付。start / end はその日の範囲（Unix 秒）
export async function fetchGatewayLog({ dir, url, token }, date, start, end) {
  const rows = await readDay(date, { dir, url, token });
  return rows.filter((r) => {
    const t = Date.parse(r.time_utc ?? r.ts) / 1000;
    return t >= start && t < end;
  });
}

// 明細に残す形。tokenId・payerId は実証1で匿名化済み。パスやエラー本文は残さない。
export function toCalls(rows, offset) {
  return rows.map((r) => ({
    ...stamp(Math.floor(Date.parse(r.time_utc ?? r.ts) / 1000), offset),
    token_id: r.tokenId ?? null,
    route_id: r.routeId ?? null,
    outcome: r.outcome,
    verify: r.verify ?? null,
    settle: r.settle ?? null,
    credits: Number(r.creditsConsumed || 0),
    latency_ms: Number.isFinite(r.latencyMs) ? Math.round(r.latencyMs) : null,
    upstream_latency_ms: Number.isFinite(r.upstreamLatencyMs) ? Math.round(r.upstreamLatencyMs) : null,
    // 実証1は支払っていない行を 'none' で埋める
    upstream_tx: r.upstreamTx && r.upstreamTx !== 'none' ? r.upstreamTx : null,
    upstream_network: r.upstreamNetwork ?? null,
  }));
}
