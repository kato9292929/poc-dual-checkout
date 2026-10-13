#!/usr/bin/env node
// Nevermined の userId・Stripe の取引 ID を匿名化したハッシュを出す（config/exclusions.json の card_buyers に書く用）。
// ANON_SALT=... node scripts/anon.mjs <id> [<id> ...]
import { anonymize } from '../lib/anon.js';
for (const v of process.argv.slice(2)) console.log(`${v.slice(0, 4)}…\t${anonymize(v)}`);
