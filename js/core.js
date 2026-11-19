// The small, fast core used by the public site. It has no outside library: the public pages read the
// books with a plain web request, so visitors never download the Supabase library (the dashboard still does).
// api.js re-exports everything here, so the dashboard keeps importing from './api.js' as before.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

// True once config.js has real values in it.
export const configured =
  SUPABASE_URL.startsWith('https://') && !/PASTE_YOUR/i.test(SUPABASE_URL + SUPABASE_ANON_KEY);

const BASE = SUPABASE_URL.replace(/\/+$/, '');
const BUCKET = 'covers';

// ---------- labels used on screen ----------
export const STATUS = { want: 'Want to Read', reading: 'Currently Reading', read: 'Read' };
export const OWN = { owned: 'Owned', buy: 'Want to Buy' };

// ---------- shared helpers ----------
// Escape text before it goes into HTML, so book data can never inject markup.
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Normalise text for searching: lower-case, no extra spaces. Works for Bengali too.
export function norm(value) {
  return String(value ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

// A book can have several authors. They are written in the one author box, separated by a comma
// ("Brian Michael Bendis, Jeph Loeb"); ";", "&", "and" and the Bengali "ও" / "এবং" between names work too.
// "Jeph Loeb, Jim Lee" -> ['Jeph Loeb', 'Jim Lee'].  (A "|" is left alone: it joins two spellings of one name.)
export function authorsOf(text) {
  const out = [];
  String(text ?? '').split(/\s*[,;&]\s*|\s+and\s+|\s+(?:\u0993|\u098f\u09ac\u0982)\s+/i).forEach((part) => {
    const name = part.replace(/\s+/g, ' ').trim();
    if (name && !out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
  });
  return out;
}

// Get the 11-character video ID from any common YouTube link
// (watch?v=..., youtu.be/..., /embed/..., /shorts/..., /live/...). Returns '' if it is not one.
export function ytId(url) {
  try {
    const u = new URL(String(url).trim());
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    let id = '';
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
      else { const m = u.pathname.match(/^\/(embed|shorts|live|v)\/([^/?]+)/); if (m) id = m[2]; }
    }
    return /^[\w-]{11}$/.test(id) ? id : '';
  } catch (e) { return ''; }
}

// YouTube serves a free thumbnail for every video. "hqdefault" always exists (480x360, with black
// bars that our 16:9 frame crops away); "maxresdefault" is sharper but missing on some videos;
// "mqdefault" is a true 16:9 320x180 (good for small thumbnails).
export function ytThumb(url, quality = 'hqdefault') {
  const id = ytId(url);
  return id ? `https://i.ytimg.com/vi/${id}/${quality}.jpg` : '';
}

// Dark / light toggle, remembered in the browser.
export function initTheme(button) {
  const isDark = () => {
    const root = document.documentElement;
    return root.dataset.theme === 'dark' || (!root.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
  };
  const sync = () => button.setAttribute('aria-pressed', String(isDark()));
  sync();
  button.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch (e) { /* storage blocked: ignore */ }
    sync();
  });
}

// ---------- covers ----------
// The public address of a file in the "covers" bucket.
export function coverUrl(path) {
  if (!path || !configured) return '';
  return `${BASE}/storage/v1/object/public/${BUCKET}/${path}`;
}

// The cover to show for a book: my uploaded file first, then a web link found by the Goodreads import
// (Open Library), otherwise '' (the page draws a cover from the title and author).
export function coverOf(b) {
  const uploaded = coverUrl(b.cover_path);
  if (uploaded) return uploaded;
  return /^https?:\/\//i.test(b.cover_url || '') ? b.cover_url : '';
}

// ---------- reading the books (public site) ----------
// Supabase sends back at most 1,000 rows per request, so a bigger library is read in pages.
// The first request also asks for the total; the remaining pages are then fetched at the same time.
// The order is fixed (newest first, then by id) so no row is repeated or skipped between pages.
const PAGE = 1000;
async function fetchPage(from, withCount) {
  const res = await fetch(`${BASE}/rest/v1/books?select=*&order=created_at.desc,id.desc`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Range-Unit': 'items',
      Range: `${from}-${from + PAGE - 1}`,
      ...(withCount ? { Prefer: 'count=exact' } : {}),
    },
  });
  if (res.status === 416) return { rows: [], total: null };       // asked for a page past the end
  if (!res.ok) throw new Error(`Could not load books (${res.status})`);
  const m = (res.headers.get('content-range') || '').match(/\/(\d+)$/);
  return { rows: await res.json(), total: m ? Number(m[1]) : null };
}

export async function fetchShelf() {
  const first = await fetchPage(0, true);
  const rows = first.rows;
  if (first.total != null) {
    const starts = [];
    for (let from = PAGE; from < first.total && from < 100000; from += PAGE) starts.push(from);
    const rest = await Promise.all(starts.map((from) => fetchPage(from, false)));
    rest.forEach((p) => rows.push(...p.rows));
  } else {
    // No total in the reply: keep asking until a page comes back short.
    for (let from = PAGE, last = rows.length; last === PAGE && from < 100000; from += PAGE) {
      const p = await fetchPage(from, false);
      rows.push(...p.rows); last = p.rows.length;
    }
  }
  const seen = new Set();                                   // a book added mid-read could appear twice
  return rows.filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
}

// ---------- shared settings (the yearly reading goal) ----------
// A tiny "settings" table holds values that should be the same on every device. Returns { key: value },
// or null when the table has not been created yet (the goal is then kept per device instead).
export async function fetchSettings() {
  const res = await fetch(`${BASE}/rest/v1/settings?select=key,value`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) return null;
  const out = {};
  (await res.json()).forEach((row) => { out[row.key] = row.value; });
  return out;
}

// ---------- the saved copy of the shelf ----------
// The last shelf that loaded is kept in this browser, so the next visit shows it at once (and it still
// opens with no connection). The page then fetches the current shelf and redraws only if it changed.
const CACHE_KEY = 'rl-shelf-v1';
export function readShelfCache() {
  try {
    const saved = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    return saved && saved.url === BASE && Array.isArray(saved.rows) ? saved.rows : null;
  } catch (e) { return null; }
}
export function writeShelfCache(rows) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ url: BASE, rows })); }
  catch (e) { try { localStorage.removeItem(CACHE_KEY); } catch (e2) { /* storage blocked or full: ignore */ } }
}

// ---------- reads, rereads and progress (added 18 November 2026) ----------
// A book's reads live in "reads", oldest first. Each read is { d: '2024-03-14' } (a full date),
// { y: 2019 } (only the year is known) or {} (no date at all).
// Books saved before "reads" existed have an empty list: a Read book then counts as one read,
// on its "finished_at" date, exactly as before.
const readKey = (r) => (r && r.d ? String(r.d) : r && r.y ? String(r.y) : '');
export function readsOf(b) {
  const list = Array.isArray(b && b.reads) ? b.reads.filter((r) => r && typeof r === 'object') : [];
  if (!list.length) return b && b.status === 'read' ? [b.finished_at ? { d: String(b.finished_at).slice(0, 10) } : {}] : [];
  return list.slice().sort((a, c) => readKey(a).localeCompare(readKey(c)));   // undated first, then by date
}
// When a read happened, as text: '2024-03-14', '2019' or '' (no date).
export const readWhen = readKey;
// The latest full date among the reads (this is what "finished_at" holds), or null.
export function lastReadDate(reads) {
  const dated = reads.map((r) => (r && r.d ? String(r.d).slice(0, 10) : '')).filter(Boolean).sort();
  return dated.length ? dated[dated.length - 1] : null;
}
// "4h 2m", "1h", "31m" or "52" (minutes) -> minutes; 0 when it cannot be read.
export function toMinutes(text) {
  const t = String(text || '').trim().toLowerCase();
  if (/^\d+$/.test(t)) return Number(t);
  const m = t.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?$/);
  return m && (m[1] || m[2]) ? Number(m[1] || 0) * 60 + Number(m[2] || 0) : 0;
}
// 1 -> '1st', 2 -> '2nd', 11 -> '11th', 23 -> '23rd'
export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}
// Is this title being read (or reread) right now?
export const readingNow = (b) => b.status === 'reading' || (b.status === 'read' && !!b.rereading);
