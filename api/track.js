// POST /api/track  body: {"e":"view"} | {"e":"click_card"} | {"e":"click_x402","i":"series"}
// navigator.sendBeacon から text/plain で届く。Cookie は読まない・書かない。
import { eventKey, isBot, redis } from '../lib/track.js';

const TTL = 60 * 60 * 24 * 400;

export default async function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') return res.status(405).end();
  if (isBot(req.headers['user-agent'])) return res.status(204).end();
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }
  const key = eventKey(body);
  if (!key) return res.status(400).end();
  try {
    await redis([['INCR', key], ['EXPIRE', key, TTL]]);
  } catch {
    return res.status(503).end();
  }
  return res.status(204).end();
}
