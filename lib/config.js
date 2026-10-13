import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
}

export function loadConfig() {
  return {
    site: loadJson('config/site.json'),
    period: loadJson('config/period.json'),
    exclusions: loadJson('config/exclusions.json'),
  };
}
