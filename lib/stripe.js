// Nevermined のカード決済（Stripe）の成約・手数料・入金可能日を Stripe API から読む。
// 読み取り専用の制限付きキー（balance_transactions:read, charges:read）で足りる。

const API = 'https://api.stripe.com/v1';

async function get(path, params, key) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API}${path}?${qs}`, { headers: { authorization: `Bearer ${key}` } });
  const body = await res.json();
  if (!res.ok) throw new Error(`stripe ${path}: ${body.error?.message || res.status}`);
  return body;
}

// [start, end) に作成された charge の balance transaction
export async function fetchChargeTransactions(key, start, end) {
  const out = [];
  let starting_after;
  for (;;) {
    const page = await get(
      '/balance_transactions',
      {
        'created[gte]': start,
        'created[lt]': end,
        type: 'charge',
        limit: 100,
        'expand[]': 'data.source',
        ...(starting_after ? { starting_after } : {}),
      },
      key,
    );
    out.push(...page.data);
    if (!page.has_more) break;
    starting_after = page.data[page.data.length - 1].id;
  }
  return out;
}

// プランの購入に当たる charge だけ残す。match が空なら全件。
export function matchesPlan(bt, match = {}) {
  const src = bt.source || {};
  if (match.metadata_key) {
    const v = src.metadata?.[match.metadata_key];
    if (match.metadata_value ? v !== match.metadata_value : v == null) return false;
  }
  if (match.description_contains && !String(src.description || bt.description || '').includes(match.description_contains)) {
    return false;
  }
  return true;
}

// 個人情報は持ち出さない。顧客IDは呼び出し側で匿名化する。
export function toPurchase(bt) {
  const src = bt.source || {};
  return {
    created: bt.created,
    amount_usd: bt.amount / 100,
    fee_usd: bt.fee / 100,
    net_usd: bt.net / 100,
    currency: bt.currency,
    available_on: bt.available_on,
    days_to_available: Math.round(((bt.available_on - bt.created) / 86400) * 10) / 10,
    customer: typeof src.customer === 'string' ? src.customer : src.customer?.id ?? null,
  };
}
