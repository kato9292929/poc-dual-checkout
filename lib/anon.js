import { createHmac } from 'node:crypto';

// トークンID・Stripe 顧客IDは、保存前に HMAC で匿名化する。生の値は data/ に書かない。
export function anonymize(value, salt = process.env.ANON_SALT) {
  if (value == null || value === '') return null;
  if (!salt) throw new Error('ANON_SALT が未設定のため匿名化できない');
  return 'h_' + createHmac('sha256', salt).update(String(value)).digest('hex').slice(0, 16);
}
