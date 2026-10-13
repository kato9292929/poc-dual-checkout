import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/config.js';
import { parseCsv, checkHeader } from '../lib/stripe-csv.js';

// コミットされた手書き CSV に、購入者を特定できる列が入っていないこと
test('data/stripe/*.csv に購入者を特定できる列がない', () => {
  const dir = join(ROOT, 'data/stripe');
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.csv'))) {
    const [header] = parseCsv(readFileSync(join(dir, f), 'utf8'));
    assert.doesNotThrow(() => checkHeader(header), f);
  }
});

// 設定に秘密鍵らしきものが入っていないこと
test('config/ に秘密鍵・API キーらしき値がない', () => {
  for (const f of readdirSync(join(ROOT, 'config'))) {
    const text = readFileSync(join(ROOT, 'config', f), 'utf8');
    assert.doesNotMatch(text, /\b(sk|rk)_(live|test)_[0-9A-Za-z]{10,}/, f);
    assert.doesNotMatch(text, /sandbox:[A-Za-z0-9._-]{20,}|live:[A-Za-z0-9._-]{20,}/, f);
    assert.doesNotMatch(text, /\b[1-9A-HJ-NP-Za-km-z]{85,90}\b/, `${f}: base58 の 64 バイト秘密鍵らしき値`);
  }
});
