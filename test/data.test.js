import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../lib/config.js';
import { parseCsv, checkHeader } from '../lib/stripe-csv.js';
import { checkCurrent } from '../lib/aggregate.js';
import { loadConfig } from '../lib/config.js';

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
// Solana の tx 署名も秘密鍵も 64 バイト（base58 で 85〜90 文字）なので長さでは区別できない。
// キー名が tx 署名を示す値（signature / tx を含むキー、その配列）だけを除外し、それ以外は秘密鍵らしき値として落とす
function* strings(v, path = []) {
  if (typeof v === 'string') yield [path, v];
  else if (Array.isArray(v)) for (const x of v) yield* strings(x, path);
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) yield* strings(x, [...path, k]);
}

test('config/ に秘密鍵・API キーらしき値がない', () => {
  for (const f of readdirSync(join(ROOT, 'config'))) {
    const text = readFileSync(join(ROOT, 'config', f), 'utf8');
    assert.doesNotMatch(text, /\b(sk|rk)_(live|test)_[0-9A-Za-z]{10,}/, f);
    assert.doesNotMatch(text, /sandbox:[A-Za-z0-9._-]{20,}|live:[A-Za-z0-9._-]{20,}/, f);
    if (!f.endsWith('.json')) {
      assert.doesNotMatch(text, /\b[1-9A-HJ-NP-Za-km-z]{85,90}\b/, `${f}: base58 の 64 バイト秘密鍵らしき値`);
      continue;
    }
    for (const [path, v] of strings(JSON.parse(text))) {
      if (!/^[1-9A-HJ-NP-Za-km-z]{85,90}$/.test(v)) continue;
      const isTxSig = path.some((k) => /signature|^tx/i.test(k));
      assert.ok(isTxSig, `${f}: ${path.join('.')} に base58 の 64 バイト秘密鍵らしき値`);
    }
  }
});

// data/ に旧形式（旧コードで作られた・分類リストが古い）の日次データが残っていないこと
test('data/*.json がすべて現行の形式（schema_version）で、今の分類リストで数えてある', () => {
  const config = loadConfig();
  const files = readdirSync(join(ROOT, 'data')).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const problems = [];
  for (const f of files) {
    const bad = checkCurrent(JSON.parse(readFileSync(join(ROOT, 'data', f), 'utf8')), config);
    if (bad.length) problems.push(`${f}: ${bad.join(' / ')}`);
  }
  assert.deepEqual(problems, [], 'node scripts/collect-daily.mjs --upgrade で数え直す');
});
