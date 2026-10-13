// JIN の受取アドレス（payTo）への USDC 入金をチェーンから読む。依存なし、JSON-RPC のみ。

export const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';

export async function rpc(url, method, params, { retries = 5 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  }
}

export async function findTokenAccounts(url, owner, mint) {
  const r = await rpc(url, 'getTokenAccountsByOwner', [owner, { mint }, { encoding: 'jsonParsed' }]);
  return r.value.map((v) => v.pubkey);
}

// [start, end) の署名を新しい順にページングして集める
export async function signaturesInRange(url, address, start, end) {
  const out = [];
  let before;
  for (;;) {
    const page = await rpc(url, 'getSignaturesForAddress', [
      address,
      { limit: 1000, ...(before ? { before } : {}) },
    ]);
    if (!page.length) break;
    for (const s of page) {
      if (s.blockTime == null) continue;
      if (s.blockTime >= start && s.blockTime < end && !s.err) out.push(s);
    }
    const last = page[page.length - 1];
    if (last.blockTime != null && last.blockTime < start) break;
    before = last.signature;
  }
  return out;
}

const keyOf = (k) => (typeof k === 'string' ? k : k.pubkey);

// jsonParsed のトランザクション1件から、payTo への入金を取り出す。入金でなければ null。
export function parsePayment(tx, { payTo, mint, facilitatorFeePayers = [] }) {
  if (!tx || tx.meta?.err) return null;
  const pre = tx.meta.preTokenBalances || [];
  const post = tx.meta.postTokenBalances || [];
  const amt = (list, idx) => {
    const b = list.find((x) => x.accountIndex === idx);
    return b ? BigInt(b.uiTokenAmount.amount) : 0n;
  };
  const idxs = new Set([...pre, ...post].filter((b) => b.mint === mint).map((b) => b.accountIndex));
  const owners = {};
  for (const b of [...pre, ...post]) if (b.mint === mint) owners[b.accountIndex] = b.owner;

  let received = 0n;
  const senders = [];
  for (const i of idxs) {
    const delta = amt(post, i) - amt(pre, i);
    if (owners[i] === payTo && delta > 0n) received += delta;
    else if (delta < 0n) senders.push({ owner: owners[i], amount: -delta });
  }
  if (received <= 0n) return null;
  senders.sort((a, b) => (b.amount > a.amount ? 1 : -1));

  const keys = tx.transaction.message.accountKeys.map(keyOf);
  const feePayer = keys[0];
  const fee = tx.meta.fee;
  const facilitatorPaid = facilitatorFeePayers.includes(feePayer);
  return {
    signature: tx.transaction.signatures[0],
    block_time: tx.blockTime,
    payer: senders[0]?.owner ?? null,
    amount_atomic: received.toString(),
    fee_lamports: fee,
    fee_payer: feePayer,
    // ファシリテーターが払ったチェーン手数料は除く
    fee_lamports_excl_facilitator: facilitatorPaid ? 0 : fee,
  };
}

export async function fetchPayments(url, { payTo, mint, start, end, facilitatorFeePayers }) {
  const accounts = await findTokenAccounts(url, payTo, mint);
  const seen = new Set();
  const payments = [];
  for (const acct of accounts) {
    for (const s of await signaturesInRange(url, acct, start, end)) {
      if (seen.has(s.signature)) continue;
      seen.add(s.signature);
      const tx = await rpc(url, 'getTransaction', [
        s.signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
      ]);
      const p = parsePayment(tx, { payTo, mint, facilitatorFeePayers });
      if (p) payments.push(p);
    }
  }
  return payments.sort((a, b) => a.block_time - b.block_time);
}
