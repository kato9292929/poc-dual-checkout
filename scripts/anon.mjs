#!/usr/bin/env node
// Stripe の取引 ID を匿名化した値を出す（config/own_wallets.json・external_buyers.json の stripe_txn_hashes に書く用）。
// ANON_SALT=... node scripts/anon.mjs <id> [<id> ...]
import { anonymize } from '../lib/anon.js';
for (const v of process.argv.slice(2)) console.log(`${v.slice(0, 4)}…\t${anonymize(v)}`);
