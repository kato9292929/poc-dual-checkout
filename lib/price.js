// SOL/USD（チェーン手数料のドル換算用）。その日の日足終値。取れなければ null（推測で埋めない）。
export async function solUsd(date) {
  const start = Date.parse(`${date}T00:00:00Z`);
  try {
    const res = await fetch(`https://data-api.binance.vision/api/v3/klines?symbol=SOLUSDC&interval=1d&startTime=${start}&limit=1`);
    const rows = await res.json();
    if (res.ok && rows[0] && rows[0][0] === start) return { usd: Number(rows[0][4]), source: 'binance SOLUSDC 1d close (UTC)' };
  } catch {}
  return { usd: null, source: 'unavailable' };
}
