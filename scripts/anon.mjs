#!/usr/bin/env node
// 自社のトークンID・Stripe顧客IDを匿名化したハッシュを出す（classify.json の own に書く用）。
// ANON_SALT=... node scripts/anon.mjs <id> [<id> ...]
import { anonymize } from '../lib/anon.js';
for (const v of process.argv.slice(2)) console.log(`${v.slice(0, 4)}…\t${anonymize(v)}`);
