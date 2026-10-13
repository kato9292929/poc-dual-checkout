#!/usr/bin/env node
// 週次レポート: node scripts/report-weekly.mjs [--week YYYY-Www]
// 既定は直前に終わった ISO 週。reports/YYYY-Www.md に書く。
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ROOT } from '../lib/config.js';
import { isoWeek, weekDays, addDays, yesterday } from '../lib/dates.js';
import { renderWeekly } from '../lib/report.js';

const args = process.argv.slice(2);
const config = loadConfig();
let label = args.includes('--week') ? args[args.indexOf('--week') + 1] : null;
if (!label) {
  const y = yesterday(config.period.utc_offset);
  const w = isoWeek(y);
  // 昨日が日曜でなければ、まだ週が終わっていないので前週
  label = w.days[6] === y ? w.label : isoWeek(addDays(w.days[0], -1)).label;
}
const days = weekDays(label);
const dailies = days
  .map((d) => join(ROOT, 'data', `${d}.json`))
  .filter(existsSync)
  .map((f) => JSON.parse(readFileSync(f, 'utf8')));

mkdirSync(join(ROOT, 'reports'), { recursive: true });
const out = join(ROOT, 'reports', `${label}.md`);
writeFileSync(out, renderWeekly({ label, days, dailies, config }));
console.log(`wrote ${out} (${dailies.length}/7 days)`);
