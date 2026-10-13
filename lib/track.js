// 販売ページの計測。Cookie・IP・UA は保存しない。日ごとのカウンタを増やすだけ。
//   view          ページの閲覧
//   open / usdc   「USDC で支払う（x402）」の説明を開いた
//   open / card   「カードで支払う」の説明を開いた
import { localDate } from './dates.js';

export const EVENTS = {
  view: [],
  open: ['usdc', 'card'],
};

const BOT_UA = /bot|crawl|spider|slurp|preview|headless|lighthouse|monitor|curl|wget|python|go-http/i;

export function isBot(ua) {
  return !ua || BOT_UA.test(ua);
}

export function eventKey(body, nowSec = Math.floor(Date.now() / 1000), offset = '+09:00') {
  if (!body || typeof body !== 'object') return null;
  const items = EVENTS[body.e];
  if (!items) return null;
  let suffix = '';
  if (items.length) {
    if (!items.includes(body.i)) return null;
    suffix = `:${body.i}`;
  }
  return `jin:${localDate(nowSec, offset)}:${body.e}${suffix}`;
}

export function statsKeys(date) {
  const keys = [];
  for (const [e, items] of Object.entries(EVENTS)) {
    if (!items.length) keys.push(`jin:${date}:${e}`);
    for (const i of items) keys.push(`jin:${date}:${e}:${i}`);
  }
  return keys;
}

export function statsFromValues(date, keys, values) {
  const v = Object.fromEntries(keys.map((k, n) => [k.split(':').slice(2).join(':'), Number(values[n] || 0)]));
  return {
    date,
    views: v.view,
    opens: Object.fromEntries(EVENTS.open.map((i) => [i, v[`open:${i}`]])),
  };
}

export async function redis(commands, env = process.env) {
  const res = await fetch(`${env.UPSTASH_REDIS_REST_URL}/pipeline`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`redis HTTP ${res.status}`);
  return (await res.json()).map((r) => r.result);
}
