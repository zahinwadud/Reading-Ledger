// All Supabase calls live here, plus a few tiny helpers shared by both pages.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.107.0/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import * as CONFIG from './config.js';   // read by name, so an older config.js without the YouTube key still works

// The helpers both pages share live in core.js (the public site loads only that file, not this one).
import { configured } from './core.js';
export { configured, STATUS, OWN, esc, norm, authorsOf, ytId, ytThumb, initTheme, coverUrl, coverOf } from './core.js';
export { readsOf, readWhen, lastReadDate, toMinutes, ordinal, readingNow } from './core.js';   // added 18 November 2026

const sb = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
const BUCKET = 'covers';

// ---------- YouTube playlist import (optional) ----------
const YT_KEY = CONFIG.YOUTUBE_API_KEY || '';
export const youtubeConfigured = YT_KEY !== '' && !/PASTE_YOUR/i.test(YT_KEY);

// START-PURE-HELPERS
// A playlist link (or just its ID) -> the playlist ID, or '' if it is not one.
export function playlistId(input) {
  const s = String(input || '').trim();
  try { const list = new URL(s).searchParams.get('list'); if (list) return list; } catch (e) { /* not a link */ }
  return /^[A-Za-z0-9_-]{13,64}$/.test(s) ? s : '';
}

// YouTube durations look like "PT7H40M12S" (or "P1DT2H" for very long ones) -> seconds.
export function isoSeconds(iso) {
  const m = String(iso || '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return 0;
  return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
}

// 27600 -> "7h 40m", 2700 -> "45m"
export function fmtDuration(seconds) {
  const total = Math.max(1, Math.round((seconds || 0) / 60));
  const h = Math.floor(total / 60), m = total % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}
// END-PURE-HELPERS

function ytErrorText(status, reason, message) {
  if (/quota|dailyLimit|rateLimit/i.test(reason)) return 'YouTube\u2019s free daily limit has been used up. Try again tomorrow.';
  if (reason === 'keyInvalid') return 'YouTube did not accept the API key. Check it in js/config.js.';
  if (reason === 'accessNotConfigured') return 'Switch on \u201cYouTube Data API v3\u201d for this key in the Google developer console.';
  if (/referer/i.test(reason + ' ' + message)) return 'This key is restricted to other websites. Add this site\u2019s address to the key\u2019s allowed websites in the Google console.';
  if (reason === 'playlistNotFound' || status === 404) return 'Playlist not found. Check the link, and make sure it is Public or Unlisted.';
  if (reason === 'playlistItemsNotAccessible' || status === 403) return 'That playlist is private. Set it to Unlisted or Public on YouTube.';
  return `YouTube returned an error (${status}${reason ? ', ' + reason : ''}).`;
}

async function ytGet(path, params) {
  let res;
  try { res = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${new URLSearchParams({ ...params, key: YT_KEY })}`); }
  catch (e) { throw new Error('Could not reach YouTube. Check your connection and try again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data.error && data.error.errors && data.error.errors[0]) || {};
    throw new Error(ytErrorText(res.status, err.reason || '', (data.error && data.error.message) || ''));
  }
  return data;
}

// Reads a playlist: its title and, for every video, the title and length.
// Costs about 1 unit per 50 videos for the list plus 1 unit per 50 for the details (free quota: 10,000 a day).
export async function fetchPlaylist(id) {
  const info = await ytGet('playlists', { part: 'snippet', id });
  if (!(info.items || []).length) throw new Error('Playlist not found. Check the link, and make sure it is Public or Unlisted.');
  const ids = [];
  let token = '';
  do {
    const page = await ytGet('playlistItems', { part: 'contentDetails', maxResults: 50, playlistId: id, ...(token ? { pageToken: token } : {}) });
    (page.items || []).forEach((it) => { if (it.contentDetails && it.contentDetails.videoId) ids.push(it.contentDetails.videoId); });
    token = page.nextPageToken || '';
  } while (token && ids.length < 500);
  const byId = {};
  for (let i = 0; i < ids.length; i += 50) {
    const v = await ytGet('videos', { part: 'snippet,contentDetails', id: ids.slice(i, i + 50).join(',') });
    (v.items || []).forEach((x) => { byId[x.id] = { id: x.id, title: x.snippet.title, channel: x.snippet.channelTitle, seconds: isoSeconds(x.contentDetails.duration) }; });
  }
  const items = ids.filter((x) => byId[x]).map((x) => byId[x]);        // private or deleted videos are not returned
  return { id, title: info.items[0].snippet.title, items, skipped: ids.length - items.length, capped: !!token };
}

// ---------- reading data (dashboard) ----------
// Supabase sends back at most 1,000 rows per request, so a bigger library has to be read in pages.
// The order is fixed (newest first, then by id) so no row is repeated or skipped between pages.
export async function fetchBooks() {
  const PAGE = 1000;
  const rows = [];
  let total = Infinity;
  while (rows.length < total && rows.length < 100000) {
    const { data, error, count } = await sb.from('books').select('*', { count: 'exact' })
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .range(rows.length, rows.length + PAGE - 1);
    if (error) throw error;
    if (!data.length) break;
    rows.push(...data);
    total = count == null ? (data.length < PAGE ? rows.length : Infinity) : count;
  }
  const seen = new Set();                                   // a book added mid-read could appear twice
  return rows.filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
}

// ---------- Goodreads import helpers (dashboard, owner only) ----------
// Does Open Library have a cover for this ISBN? Loading it as an image tells us (no download needed).
// "?default=false" makes a missing cover a 404 instead of a blank picture. Returns the link or ''.
export function probeCover(isbn) {
  return new Promise((resolve) => {
    const url = `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(isbn)}-L.jpg?default=false`;
    const img = new Image();
    const timer = setTimeout(() => { img.onload = img.onerror = null; resolve(''); }, 9000);
    img.onload = () => { clearTimeout(timer); resolve(img.naturalWidth > 10 ? url : ''); };
    img.onerror = () => { clearTimeout(timer); resolve(''); };
    img.src = url;
  });
}

// Save many books at once (in small batches). Every row carries its own id, made in the browser.
export async function importBooks(rows) {
  let saved = 0;
  for (let i = 0; i < rows.length; i += 40) {
    const { error } = await sb.from('books').insert(rows.slice(i, i + 40));
    if (error) { error.saved = saved; throw error; }
    saved += Math.min(40, rows.length - i);
  }
  return saved;
}

export async function setCoverUrl(id, url) {
  const { error } = await sb.from('books').update({ cover_url: url }).eq('id', id);
  if (error) throw error;
}

// ---------- writing data (dashboard, owner only) ----------
export async function saveBook(data, id) {
  const q = id ? sb.from('books').update(data).eq('id', id) : sb.from('books').insert(data);
  const { data: row, error } = await q.select().single();
  if (error) throw error;
  return row;
}

// Change the same fields on many books at once (bulk edit, merging author names).
export async function updateBooks(ids, patch) {
  for (let i = 0; i < ids.length; i += 100) {
    const { error } = await sb.from('books').update(patch).in('id', ids.slice(i, i + 100));
    if (error) throw error;
  }
}

// ---------- shared settings (the yearly reading goal) ----------
// Reads every setting. Returns null when the "settings" table does not exist yet.
export async function readSettings() {
  const { data, error } = await sb.from('settings').select('key,value');
  if (error) { if (/PGRST205|42P01/.test(error.code || '') || /settings/.test(error.message || '')) return null; throw error; }
  return Object.fromEntries(data.map((row) => [row.key, row.value]));
}
// Save one setting; a value of null removes it.
export async function saveSetting(key, value) {
  const q = value == null ? sb.from('settings').delete().eq('key', key)
    : sb.from('settings').upsert({ key, value, updated_at: new Date().toISOString() });
  const { error } = await q;
  if (error) throw error;
}

// Change a few fields on one book, without reading it back.
export async function patchBook(id, patch) {
  const { error } = await sb.from('books').update(patch).eq('id', id);
  if (error) throw error;
}

export async function deleteBook(book) {
  // Its reader file goes first, so nothing is left behind in Backblaze (21 November 2026).
  if (await fileOf(book.id).catch(() => null)) await bookFileAction('remove', book.id);
  const { error } = await sb.from('books').delete().eq('id', book.id);
  if (error) throw error;
  if (book.cover_path) await removeCover(book.cover_path);
}

export async function uploadCover(blob) {
  const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
  const path = `${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, blob, {
    contentType: blob.type, cacheControl: '31536000', upsert: false,
  });
  if (error) throw error;
  return path;
}

export async function removeCover(path) {
  if (!path) return;
  const { error } = await sb.storage.from(BUCKET).remove([path]);
  if (error) console.warn('Could not remove cover file:', error.message);
}

// ---------- login ----------
export async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
}
export async function signOut() { if (sb) await sb.auth.signOut(); }
export async function getSession() {
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session;
}
export function onAuth(callback) { if (sb) sb.auth.onAuthStateChange((event, session) => callback(event, session)); }

// ---------- the reader (added 21 November 2026) ----------
// Book files live in a private Backblaze B2 bucket. The Edge Function "book-file" holds the key and
// only helps people allowed to read (see supabase/reader.sql and supabase/functions/book-file).

// What went wrong inside an Edge Function call, in its own words when it gave any.
async function fnError(error) {
  let msg = error.message;
  try { const j = await error.context.json(); if (j && j.error) msg = j.error; } catch (e) { /* no details */ }
  return new Error(msg);
}

export const sbReady = () => !!sb;

// One book, fresh from the database (the reader page does not load the whole shelf).
export async function bookById(id) {
  const { data, error } = await sb.from('books').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

// May the signed-in person read? (You always; others only if listed in "readers".)
export async function amReader() {
  const { data, error } = await sb.rpc('is_reader');
  if (error) throw error;
  return !!data;
}

// The file kept for a book, or null. Only readers see these rows.
export async function fileOf(bookId) {
  const { data, error } = await sb.from('book_files').select('*').eq('book_id', bookId).maybeSingle();
  if (error) throw error;
  return data;
}

// Every book with a file, with its shelf details, newest upload first.
export async function filesWithBooks() {
  const { data, error } = await sb.from('book_files')
    .select('book_id, kind, size, uploaded_at, file_id, books(id, title, author, cover_path, cover_url, status, rereading, language)')
    .order('uploaded_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// Where the signed-in person stopped in a book: { location, fraction, updated_at } or null.
export async function positionOf(bookId) {
  const { data, error } = await sb.from('reading_positions').select('location, fraction, updated_at').eq('book_id', bookId).maybeSingle();
  if (error) throw error;
  return data;
}
export async function savePosition(bookId, location, fraction, at) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error('Not signed in.');
  const { error } = await sb.from('reading_positions').upsert({
    user_id: session.user.id, book_id: bookId, location, fraction, updated_at: at || new Date().toISOString(),
  });
  if (error) throw error;
}

// open -> { url, kind, size, file_id } (a link valid for an hour); remove -> deletes the file (owner).
export async function bookFileAction(action, bookId) {
  const { data, error } = await sb.functions.invoke('book-file', { body: { action, book: bookId } });
  if (error) throw await fnError(error);
  return data;
}

// Store a book's file (owner). Replaces any earlier file for the same book.
export async function uploadBookFile(bookId, file) {
  const q = new URLSearchParams({ action: 'upload', book: bookId, name: file.name });
  const { data, error } = await sb.functions.invoke(`book-file?${q}`, {
    body: file, headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (error) throw await fnError(error);
  return data;
}

// Is the signed-in person the owner? (Used by the reader to decide whether it may change the shelf.)
export async function amOwner() {
  const { data, error } = await sb.rpc('is_owner');
  if (error) throw error;
  return !!data;
}
