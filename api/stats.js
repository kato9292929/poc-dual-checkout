// GET /api/stats?date=YYYY-MM-DD  （Authorization: Bearer $STATS_TOKEN）
import { timingSafeEqual } from 'node:crypto';
import { statsKeys, statsFromValues, redis } from '../lib/track.js';

function authorized(header) {
  const want = process.env.STATS_TOKEN;
  if (!want || !header) return false;
  const a = Buffer.from(header);
  const b = Buffer.from(`Bearer ${want}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (!authorized(req.headers.authorization)) return res.status(401).end();
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date=YYYY-MM-DD' });
  const keys = statsKeys(date);
  try {
    const values = (await redis([['MGET', ...keys]]))[0];
    return res.status(200).json(statsFromValues(date, keys, values));
  } catch (e) {
    return res.status(503).json({ error: e.message });
  }
}
