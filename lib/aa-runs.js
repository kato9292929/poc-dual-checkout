// AA（Autonomous Agent）の公開 run ログ（https://aa.x402jp.com/api/runs）から、
// AA 自身の購入の「エンドポイント ↔ tx 署名」を取り出す。売り手ログ（docs/seller-log.md）と同じ形に揃える。
// 対象は AA の購入だけ（own）。外部の買い手の $0.01 はこれでは確定できない。
// 公開されているのは直近の run だけなので、日次集計のたびに取り込んで明細に残す。

export const AA_RUNS_URL = 'https://aa.x402jp.com/api/runs';

export function rowsFromRuns(body, { hosts = ['jin.x402jp.com', 'osd.x402jp.com'] } = {}) {
  const out = [];
  for (const run of body?.runs || []) {
    for (const r of run.results || []) {
      if (!r.txHash || !r.endpoint) continue;
      if (!hosts.some((h) => String(r.endpoint).includes(`//${h}/`))) continue;
      out.push({
        tx_signature: r.txHash,
        endpoint: r.endpoint,
        amount: r.costUsdc != null ? String(Math.round(r.costUsdc * 1e6)) : null,
        time_utc: new Date(run.timestamp).toISOString(),
        source: 'aa_runs',
      });
    }
  }
  return out;
}

export async function fetchAaRuns(url = AA_RUNS_URL) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`aa runs: HTTP ${res.status}`);
  return rowsFromRuns(await res.json());
}

// 売り手ログを優先して1つにまとめる（同じ tx 署名なら売り手ログを残す）
export function mergeSellerRows(...lists) {
  const m = new Map();
  for (const list of lists.reverse()) for (const r of list || []) m.set(r.tx_signature, r);
  return [...m.values()];
}
