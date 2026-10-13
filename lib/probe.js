// 決済1件の所要時間（リクエストから 200 まで）を、買い手の側から測る。
// 2つの入口を同じ手順で測る：支払いなしで GET → 402 → 支払い情報を付けて GET → 200。
//   USDC 直接: 402 の提示に署名する（@x402/svm）。署名の時間も含む
//   カード払い: 事前に発行した Nevermined のアクセストークンを payment-signature ヘッダに付ける
// 計測用の買い手は自社なので、支払い元を config/own_wallets.json に書き、own として集計から除外する。

const now = () => performance.now();
const ms = (a, b) => Math.round(b - a);

export function decodePaymentRequired(header) {
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

// 署名してよい提示か。金額・受取先・資産が設定と完全に一致するときだけ払う
export function refuseUsdc(pr, { item, usdc }) {
  const a = (pr?.accepts || []).find((x) => x.network === usdc.network);
  if (!a) return 'Solana mainnet の提示がない';
  if (a.scheme !== 'exact') return `scheme ${a.scheme}`;
  if (a.asset !== usdc.asset) return `asset ${a.asset}`;
  if (a.payTo !== usdc.pay_to) return `payTo ${a.payTo}`;
  if (a.amount !== item.usdc_amount_atomic) return `amount ${a.amount} ≠ ${item.usdc_amount_atomic}`;
  return null;
}

export async function measureUsdc({ http, item, usdc, fetchImpl = fetch }) {
  const rec = { entry: 'usdc', item: item.id, ts: new Date().toISOString() };
  const t0 = now();
  try {
    const r1 = await fetchImpl(item.usdc_url);
    const t1 = now();
    rec.first_status = r1.status;
    rec.first_ms = ms(t0, t1);
    if (r1.status !== 402) throw new Error(`最初の応答が 402 ではない: ${r1.status}`);
    const body = await r1.json().catch(() => undefined);
    const pr = http.getPaymentRequiredResponse((n) => r1.headers.get(n), body);
    const why = refuseUsdc(pr, { item, usdc });
    if (why) throw new Error(`支払わない: ${why}`);
    const a = pr.accepts.find((x) => x.network === usdc.network);
    const payload = await http.createPaymentPayload({ ...pr, accepts: [a] });
    const t2 = now();
    rec.sign_ms = ms(t1, t2);
    const r2 = await fetchImpl(item.usdc_url, { headers: http.encodePaymentSignatureHeader(payload) });
    const text = await r2.text();
    if (r2.status !== 200) rec.error = `HTTP ${r2.status} ${text.slice(0, 160)}`;
    const t3 = now();
    rec.paid_ms = ms(t2, t3);
    rec.status = r2.status;
    rec.total_ms = ms(t0, t3);
    rec.ok = r2.status === 200;
    try {
      const s = http.getPaymentSettleResponse((n) => r2.headers.get(n));
      rec.tx = s.transaction || null;
    } catch {}
  } catch (e) {
    rec.ok = false;
    rec.error = e.message;
  }
  return rec;
}

export async function measureCard({ baseUrl, item, token, fetchImpl = fetch }) {
  const url = `${baseUrl.replace(/\/$/, '')}${item.card_path}`;
  const rec = { entry: 'card', item: item.id, ts: new Date().toISOString() };
  const t0 = now();
  try {
    const r1 = await fetchImpl(url);
    await r1.arrayBuffer();
    const t1 = now();
    rec.first_status = r1.status;
    rec.first_ms = ms(t0, t1);
    if (r1.status !== 402) throw new Error(`最初の応答が 402 ではない: ${r1.status}`);
    rec.sign_ms = 0; // トークンは事前発行。発行の時間は含めない（docs/sources.md）
    const r2 = await fetchImpl(url, { headers: { 'payment-signature': token } });
    const text = await r2.text();
    if (r2.status !== 200) rec.error = `HTTP ${r2.status} ${text.slice(0, 160)}`;
    const t2 = now();
    rec.paid_ms = ms(t1, t2);
    rec.status = r2.status;
    rec.total_ms = ms(t0, t2);
    rec.ok = r2.status === 200;
    rec.credits_consumed = Number(r2.headers.get('x-credits-consumed') || 0) || null;
  } catch (e) {
    rec.ok = false;
    rec.error = e.message;
  }
  return rec;
}

export async function makeUsdcClient({ secret, rpcUrl, network }) {
  const [{ x402Client, x402HTTPClient }, { ExactSvmScheme }, { createKeyPairSignerFromBytes }, bs58] = await Promise.all([
    import('@x402/core/client'),
    import('@x402/svm/exact/client'),
    import('@solana/kit'),
    import('bs58'),
  ]);
  const bytes = secret.trim().startsWith('[') ? Uint8Array.from(JSON.parse(secret)) : bs58.default.decode(secret.trim());
  if (bytes.length !== 64) throw new Error(`秘密鍵は 64 バイト（実際 ${bytes.length}）`);
  const signer = await createKeyPairSignerFromBytes(bytes);
  // ライブラリ側にも上限をかける（1回 $0.02 まで）
  const client = x402Client.fromConfig({ schemes: [], spendControls: { maxAmountPerPayment: '$0.02' } });
  client.register(network, new ExactSvmScheme(signer, rpcUrl ? { rpcUrl } : undefined));
  return { http: new x402HTTPClient(client), address: signer.address };
}
