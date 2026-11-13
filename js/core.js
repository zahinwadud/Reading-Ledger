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
