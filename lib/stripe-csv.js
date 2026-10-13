// 手で書き出した Stripe の CSV（data/stripe/YYYY-MM.csv）を読む。
// Stripe ダッシュボードの「残高 → レポート → 残高の変動（項目別）」などの書き出しを想定し、列名の揺れを吸収する。
// 購入者を特定できる列（メール・名前・顧客・カード・住所・電話・説明文）が入っていたら読まずにエラーにする。
// 取引 ID はここで匿名化し、生の値は日次データに書かない。
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';
import { stamp } from './dates.js';
import { SALE_TYPES, withPayout } from './stripe.js';

export const FORBIDDEN = /mail|name|customer|card|address|phone|description|statement|billing|shipping|ip/i;

const COLS = {
  id: ['id', 'balance_transaction_id', 'source_id'],
  type: ['type', 'reporting_category', 'Type'],
  created: ['created', 'created_utc', 'Created (UTC)', 'Created'],
  gross: ['gross', 'amount', 'Amount', 'Gross'],
  fee: ['fee', 'Fee'],
  net: ['net', 'Net'],
  currency: ['currency', 'Currency'],
  payout: ['automatic_payout_effective_at', 'Automatic Payout Effective At (UTC)', 'automatic_payout_effective_at_utc', 'payout_arrival_date'],
};

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') row.push(field), (field = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field), (field = '');
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

export function checkHeader(header) {
  const bad = header.filter((h) => FORBIDDEN.test(h) && !COLS.payout.includes(h));
  if (bad.length) throw new Error(`購入者を特定できる列があるので読まない: ${bad.join(', ')}（その列を消してから置く）`);
}

const toSec = (s) => {
  if (!s) return null;
  const t = /^\d+$/.test(s) ? Number(s) : Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`) / 1000;
  return Number.isFinite(t) ? Math.floor(t) : null;
};

export function salesFromCsv(text, { anonymize, offset }) {
  const [header, ...rows] = parseCsv(text);
  checkHeader(header);
  const idx = Object.fromEntries(Object.entries(COLS).map(([k, names]) => [k, header.findIndex((h) => names.includes(h.trim()))]));
  for (const k of ['id', 'created', 'gross', 'net']) if (idx[k] < 0) throw new Error(`列 ${k} が無い（${COLS[k].join(' / ')}）`);
  const val = (r, k) => (idx[k] >= 0 ? (r[idx[k]] ?? '').trim() : '');
  return rows
    .filter((r) => !val(r, 'type') || SALE_TYPES.has(val(r, 'type').toLowerCase()))
    .map((r) => {
      const gross = Number(val(r, 'gross'));
      const net = Number(val(r, 'net'));
      return withPayout(
        {
          source: 'csv',
          ...stamp(toSec(val(r, 'created')), offset),
          txn_hash: anonymize(val(r, 'id')),
          currency: (val(r, 'currency') || 'usd').toLowerCase(),
          gross_usd: gross,
          net_usd: net,
          fee_usd: Math.round((gross - net) * 100) / 100,
        },
        toSec(val(r, 'payout')),
        offset,
      );
    });
}

// その日（JST）の分。月をまたぐ日のために前後の月のファイルも読む
export function csvSalesForDate(date, { anonymize, offset }, dir = join(ROOT, 'data/stripe')) {
  const months = new Set([date.slice(0, 7)]);
  const d = new Date(`${date}T00:00:00Z`);
  months.add(new Date(d.getTime() - 86400000).toISOString().slice(0, 7));
  months.add(new Date(d.getTime() + 86400000).toISOString().slice(0, 7));
  const files = [...months].map((m) => join(dir, `${m}.csv`)).filter(existsSync);
  if (!files.length) return null;
  return files.flatMap((f) => salesFromCsv(readFileSync(f, 'utf8'), { anonymize, offset })).filter((s) => s.date_jst === date);
}
