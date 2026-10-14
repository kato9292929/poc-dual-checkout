// 日付はすべて period.json の utc_offset（JST）で区切る。日本は夏時間がないので固定オフセットで足りる。

export function offsetMinutes(offset = '+09:00') {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!m) throw new Error(`bad utc_offset: ${offset}`);
  const v = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === '-' ? -v : v;
}

// 'YYYY-MM-DD' のローカル日 → [開始, 終了) の Unix 秒
export function dayBounds(date, offset) {
  const [y, mo, d] = date.split('-').map(Number);
  const start = Date.UTC(y, mo - 1, d) / 1000 - offsetMinutes(offset) * 60;
  return { start, end: start + 86400 };
}

export function localDate(unixSec, offset) {
  return new Date((unixSec + offsetMinutes(offset) * 60) * 1000).toISOString().slice(0, 10);
}

export function addDays(date, n) {
  const t = Date.parse(`${date}T00:00:00Z`) + n * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

export function yesterday(offset, now = Date.now()) {
  return addDays(localDate(Math.floor(now / 1000), offset), -1);
}

// ISO 8601 週。返り値 { year, week, label: 'YYYY-Www', days: [月..日] }
export function isoWeek(date) {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay() || 7;
  const thursday = new Date(d.getTime() + (4 - dow) * 86400000);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / 86400000 / 7) + 1;
  const monday = addDays(date, 1 - dow);
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  return { year, week, label: `${year}-W${String(week).padStart(2, '0')}`, days };
}

// 'YYYY-Www' → その週の月〜日
export function weekDays(label) {
  const m = /^(\d{4})-W(\d{2})$/.exec(label);
  if (!m) throw new Error(`bad week label: ${label}`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  // 1月4日を含む週が第1週
  const jan4 = `${year}-01-04`;
  const w1 = isoWeek(jan4).days[0];
  const monday = addDays(w1, (week - 1) * 7);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

export function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function percentile(nums, p) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

// 各トランザクションに付ける時刻: UTC の時刻と、集計の区切り（JST）の日付
export function stamp(unixSec, offset = '+09:00') {
  return { time_utc: new Date(unixSec * 1000).toISOString(), date_jst: localDate(unixSec, offset) };
}
