// Stripe API が使えないときの手入力（実証1の reports/inputs/card-payments.json と同じ形に、入金日と自社フラグを足したもの）
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './config.js';
import { dayBounds } from './dates.js';

export function manualSales(date, offset, file = join(ROOT, 'inputs/card-payments.json')) {
  if (!existsSync(file)) return null;
  const { payments = [] } = JSON.parse(readFileSync(file, 'utf8'));
  const { start } = dayBounds(date, offset);
  return payments
    .filter((p) => p.date === date)
    .map((p, i) => {
      const gross = Number(p.grossUsd);
      const net = p.netUsd != null ? Number(p.netUsd) : gross - Number(p.stripeFeeUsd || 0) - Number(p.neverminedFeeUsd || 0);
      const payoutTs = p.payoutDate ? dayBounds(p.payoutDate, offset).start : null;
      return {
        source: 'manual',
        kind: p.kind || 'plan',
        ts: start + i,
        txn_hash: null,
        own: !!p.own,
        currency: 'usd',
        gross_usd: gross,
        net_usd: net,
        fee_usd: Math.round((gross - net) * 100) / 100,
        payout_arrival: payoutTs,
        days_to_payout: p.payoutDate ? Math.round((Date.parse(p.payoutDate) - Date.parse(p.date)) / 86400000) : null,
      };
    });
}
