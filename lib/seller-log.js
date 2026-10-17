// 売り手側の「エンドポイント ↔ tx 署名」ログ（docs/seller-log.md）を読む。
// GET {SELLER_LOG_URL}/sales/:date（:date は JST の日付、Bearer は SELLER_LOG_TOKEN）。
// 受取口座を JIN と OSD が共有しているので、$0.01 の支払いがどちらの商品かはこのログでしか分からない。
// ログが無い日（404・未設定）は、その日の $0.01 は unresolved のまま残る。

export function sellerLogUrl(base, date) {
  return base.includes('{date}') ? base.replace('{date}', date) : `${base.replace(/\/$/, '')}/sales/${date}`;
}

export function parseSellerLog(text, source = 'seller') {
  const t = text.trim();
  if (!t) return [];
  let rows;
  if (t.startsWith('[')) rows = JSON.parse(t);
  else if (t.startsWith('{') && !t.includes('\n')) {
    const j = JSON.parse(t);
    rows = Array.isArray(j.sales) ? j.sales : [j];
  } else rows = t.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return rows.map((r, i) => {
    for (const k of ['tx_signature', 'endpoint', 'amount', 'time_utc']) {
      if (r[k] == null || r[k] === '') throw new Error(`売り手ログの ${i + 1} 行目に ${k} が無い`);
    }
    return {
      tx_signature: String(r.tx_signature),
      endpoint: String(r.endpoint),
      amount: String(r.amount),
      time_utc: new Date(r.time_utc).toISOString(),
      source,
    };
  });
}

// 戻り値: 配列（その日のログ）／ null（その日のログが無い = 404）
export async function fetchSellerLog({ url, token }, date) {
  const res = await fetch(sellerLogUrl(url, date), { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`seller log ${date}: HTTP ${res.status}`);
  return parseSellerLog(await res.text());
}
