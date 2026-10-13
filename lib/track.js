// 販売ページの計測。Cookie・IP・UA は保存しない。日ごとのカウンタを増やすだけ。
import { localDate } from './dates.js';

export const EVENTS = {
  view: [],
  click_card: [],
  click_x402: ['series', 'movers'],
};

const BOT_UA = /bot|crawl|spider|slurp|preview|headless|lighthouse|monitor|curl|wget|python|go-http/i;

export function isBot(ua) {
  return !ua || BOT_UA.test(ua);
}

// 受け取ったイベントを検証してカウンタのキーを返す。不正なら null。
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
  const x402ByItem = Object.fromEntries(EVENTS.click_x402.map((i) => [i, v[`click_x402:${i}`]]));
  return {
    date,
    views: v.view,
    clicks: {
      card: v.click_card,
      x402: Object.values(x402ByItem).reduce((a, b) => a + b, 0),
      x402_by_item: x402ByItem,
    },
  };
}

// Upstash Redis REST
export async function redis(commands, env = process.env) {
  const res = await fetch(`${env.UPSTASH_REDIS_REST_URL}/pipeline`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`redis HTTP ${res.status}`);
  return (await res.json()).map((r) => r.result);
}
