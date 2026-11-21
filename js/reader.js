// The reader (21 November 2026): opens a book's file from the private Backblaze bucket and shows it.
//
//   reader.html            the books that have a file, and what is kept on this phone
//   reader.html#<book id>  that book, opened where you stopped
//
// EPUB is shown with foliate-js (js/vendor/foliate, MIT licence). Each book is kept on the phone after
// the first download (Cache Storage), so it opens straight away next time and works with no connection.
// Where you stopped is saved for each person (reading_positions). For you (the owner) it also fills
// the book's progress on the shelf, and the reader offers to mark the book Currently Reading / Read.
import { esc, coverOf, readsOf, readingNow, STATUS } from './core.js';
import './vendor/foliate/view.js';

const $ = (id) => document.getElementById(id);
const BOOKS = 'rl-books-v1';                       // Cache Storage name for downloaded books
const keyFor = (id) => new URL(`rl-book/${id}`, location.href).href;
const PREFS = 'rl-reader';
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const mb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const show = (id) => ['rd-signin', 'rd-list', 'rd-load', 'rd-book'].forEach((x) => { $(x).hidden = x !== id; });

let api = null;            // js/api.js, loaded when there is a connection (it needs the Supabase library)
let book = null;           // the book's row from the shelf (null when opened offline)
let owner = false;
let view = null;
let openId = '';          // the book now open

// ---------- settings: text size, spacing, colours ----------
const prefs = Object.assign({ theme: 'site', size: 100, space: 1.5 }, (() => { try { return JSON.parse(localStorage.getItem(PREFS) || '{}'); } catch (e) { return {}; } })());
const savePrefs = () => { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch (e) { /* storage blocked */ } };
const COLORS = {
  light: { bg: '#fbfaf7', ink: '#1c1b19', link: '#1d5c5c', scheme: 'light' },
  sepia: { bg: '#f4ecd8', ink: '#4a3b2a', link: '#7a4e1d', scheme: 'light' },
  dark: { bg: '#1d2226', ink: '#dedbd5', link: '#7fc4c4', scheme: 'dark' },
  black: { bg: '#000000', ink: '#c9c6c0', link: '#7fc4c4', scheme: 'dark' },
};
function themeName() {
  if (prefs.theme !== 'site') return prefs.theme;
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || (!t && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
}
function bookCSS() {
  const c = COLORS[themeName()];
  const force = themeName() !== 'light';   // on light paper the book's own colours are kept
  return `
    html { color-scheme: ${c.scheme}; font-size: ${prefs.size}% !important; }
    html, body { background: transparent !important; color: ${c.ink} !important; }
    ${force ? `body *:not(img):not(svg):not(svg *) { color: inherit !important; background-color: transparent !important; border-color: ${c.ink}33 !important; }` : ''}
    a:link, a:visited { color: ${c.link} !important; }
    p, li, blockquote, dd, div { line-height: ${prefs.space} !important; }
    img, svg, video { max-width: 100%; height: auto; }
    ${force ? 'img { filter: brightness(.9); }' : ''}
  `;
}
function applyLook() {
  const name = themeName(), c = COLORS[name];
  document.body.dataset.rdTheme = name;
  // The page must use the same light/dark scheme as the book inside it, or Chrome paints the book grey.
  document.documentElement.style.colorScheme = c.scheme;
  document.body.style.setProperty('--rd-bg', c.bg);
  document.body.style.setProperty('--rd-ink', c.ink);
  view?.renderer?.setStyles?.(bookCSS());
  $('rd-size').textContent = `${prefs.size}%`;
  $('rd-space').textContent = prefs.space.toFixed(1);
  document.querySelectorAll('[data-theme-pick]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themePick === prefs.theme)));
  const meta = document.querySelector('meta[name="theme-color"]:not([media])') || Object.assign(document.head.appendChild(document.createElement('meta')), { name: 'theme-color' });
  meta.content = c.bg;
}

// ---------- small helpers ----------
let toastTimer;
function toast(text) {
  const t = $('rd-toast'); t.textContent = text; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
}
async function loadApi() {
  if (api) return api;
  try { api = await import('./api.js'); return api.sbReady() ? api : (api = null); } catch (e) { return null; }   // offline: the library cannot load
}
const localPos = (id) => { try { return JSON.parse(localStorage.getItem(`rl-pos-${id}`) || 'null'); } catch (e) { return null; } };
const setLocalPos = (id, p) => { try { localStorage.setItem(`rl-pos-${id}`, JSON.stringify(p)); } catch (e) { /* storage full */ } };
// Remember which books have files, so the shelf can show a Read button without asking every time.
function rememberFiles(ids) { try { localStorage.setItem('rl-reader-files', JSON.stringify({ ids, at: Date.now() })); } catch (e) { /* ignore */ } }

// ---------- signing in ----------
async function signedIn() {
  const a = await loadApi();
  if (!a) return null;
  return a.getSession();
}
function askSignIn() {
  show('rd-signin');
  return new Promise((resolve) => {
    $('rd-form').onsubmit = async (e) => {
      e.preventDefault();
      $('rd-err').textContent = '';
      try { await api.signIn($('rd-email').value.trim(), $('rd-pass').value); resolve(await api.getSession()); }
      catch (err) { $('rd-err').textContent = /invalid/i.test(err.message) ? 'Wrong email or password.' : err.message; }
    };
  });
}

// ---------- the list ----------
async function cachedBooks() {
  const out = new Map();
  try {
    const cache = await caches.open(BOOKS);
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      const id = decodeURIComponent(req.url.split('/rl-book/')[1] || '');
      out.set(id, { size: Number(res.headers.get('Content-Length')) || 0, title: decodeURIComponent(res.headers.get('X-Title') || ''), fileId: res.headers.get('X-File-Id') });
    }
  } catch (e) { /* no Cache Storage */ }
  return out;
}

async function showList() {
  show('rd-list');
  document.title = 'Reader · Reading Ledger';
  const saved = await cachedBooks();
  let files = [];
  if (api) {
    try { files = await api.filesWithBooks(); rememberFiles(files.map((f) => f.book_id)); }
    catch (e) { $('rd-books').innerHTML = `<p class="err">${esc(e.message)}</p>`; }
  } else $('rd-books').innerHTML = '<p class="hint">No connection: only the books kept on this phone can be opened.</p>';
  if (files.length) {
    $('rd-books').innerHTML = `<ul class="rd-shelf">${files.map((f) => {
      const b = f.books || {}; const cover = coverOf(b);
      const pos = localPos(f.book_id); const pct = pos && pos.fraction != null ? `${Math.round(pos.fraction * 100)}%` : '';
      return `<li><a href="#${esc(f.book_id)}">${cover ? `<img src="${esc(cover)}" alt="" loading="lazy">` : '<span class="rd-nocover"></span>'}
        <span class="rd-meta"><b>${esc(b.title || 'Untitled')}</b><span>${esc(b.author || '')}</span>
        <span class="hint">${f.kind.toUpperCase()} · ${mb(f.size)}${saved.has(f.book_id) ? ' · on this phone' : ''}${pct ? ` · ${pct}` : ''}</span></span></a></li>`;
    }).join('')}</ul>`;
  } else if (api && !$('rd-books').querySelector('.err')) $('rd-books').innerHTML = '<p class="hint">No books have a file yet. Add one from the dashboard: Edit book → Reader file.</p>';

  $('rd-saved').innerHTML = saved.size
    ? `<ul class="rd-saved">${[...saved].map(([id, s]) => `<li><a href="#${esc(id)}">${esc(s.title || id)}</a><span class="hint">${mb(s.size)}</span><button class="btn" type="button" data-drop="${esc(id)}">Remove from this phone</button></li>`).join('')}</ul>
       <p class="hint">Total ${mb([...saved.values()].reduce((n, s) => n + s.size, 0))}. Removing only frees space here; the book stays in your library.</p>`
    : '<p class="hint">Nothing yet. Books you open are kept here for reading offline.</p>';

  const s = api ? await api.getSession() : null;
  $('rd-who').innerHTML = s ? `Signed in as ${esc(s.user.email)} · <button class="linkbtn" type="button" id="rd-signout">Sign out</button>` : '';
}

document.addEventListener('click', async (e) => {
  const drop = e.target.closest('[data-drop]');
  if (drop) {
    const cache = await caches.open(BOOKS);
    await cache.delete(keyFor(drop.dataset.drop));
    showList();
  }
  if (e.target.id === 'rd-signout') { await api.signOut(); location.reload(); }
});

// ---------- getting the file ----------
// The copy on this phone is used when it is the same upload as the one in the library (or when offline).
async function getFile(id, info) {
  const cache = await caches.open(BOOKS).catch(() => null);
  const saved = cache ? await cache.match(keyFor(id)) : null;
  if (saved && (!info || saved.headers.get('X-File-Id') === info.file_id)) return saved.blob();
  if (!info) throw new Error('This book is not on this phone, and there is no connection to get it.');

  $('rd-load-msg').textContent = 'Getting the book…';
  const link = await api.bookFileAction('open', id);
  const res = await fetch(link.url);
  if (!res.ok) throw new Error(`The file could not be downloaded (${res.status}).`);
  const total = Number(res.headers.get('Content-Length')) || info.size || 0;
  const reader = res.body.getReader(); const parts = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    if (total) { $('rd-load-bar').style.width = `${Math.min(100, (got / total) * 100)}%`; $('rd-load-msg').textContent = `Getting the book… ${mb(got)} of ${mb(total)}`; }
  }
  const type = { epub: 'application/epub+zip', pdf: 'application/pdf', cbz: 'application/vnd.comicbook+zip' }[info.kind] || 'application/octet-stream';
  const blob = new Blob(parts, { type });
  if (cache) {
    await cache.put(keyFor(id), new Response(blob, { headers: {
      'Content-Type': type, 'Content-Length': String(blob.size), 'X-File-Id': info.file_id, 'X-Kind': info.kind,
      'X-Title': encodeURIComponent(book ? book.title : ''), 'X-Saved': new Date().toISOString(),
    } })).catch(() => toast('The book could not be kept on this phone (not enough space?).'));
    navigator.storage?.persist?.().catch(() => {});
  }
  return blob;
}

// ---------- opening a book ----------
async function openBook(id) {
  openId = id;
  show('rd-load');
  $('rd-load-err').textContent = ''; $('rd-load-back').hidden = true; $('rd-load-bar').style.width = '0';
  $('rd-load-title').textContent = '';
  let info = null, serverPos = null;
  try {
    let offline = !api;
    if (api) {
      try { [book, info, owner, serverPos] = await Promise.all([api.bookById(id), api.fileOf(id), api.amOwner(), api.positionOf(id).catch(() => null)]); }
      catch (e) { if (navigator.onLine && !/fetch|network/i.test(e.message)) throw e; offline = true; book = null; info = null; owner = false; }
      if (book) $('rd-load-title').textContent = book.title;
      if (!offline && !info) throw new Error('This book has no file yet.');
    }
    const blob = await getFile(id, info);
    const kind = info ? info.kind : (blob.type.includes('pdf') ? 'pdf' : 'epub');
    if (kind !== 'epub') throw new Error('Only EPUB books can be opened for now. PDF comes next.');
    $('rd-load-msg').textContent = 'Opening…';

    // The later of the two saved places wins: the one on this phone or the one in the database.
    const mine = localPos(id);
    const pos = [mine, serverPos].filter((p) => p && p.location).sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0];
    await showEpub(id, new File([blob], 'book.epub', { type: 'application/epub+zip' }), pos ? pos.location : null);
  } catch (e) {
    $('rd-load-err').textContent = e.message || String(e);
    $('rd-load-msg').textContent = '';
    $('rd-load-back').hidden = false;
  }
}

async function showEpub(id, file, location) {
  view?.close?.(); view?.remove();
  view = document.createElement('foliate-view');
  $('rd-view').append(view);
  await view.open(file);
  view.renderer.setAttribute('flow', 'paginated');
  view.renderer.setAttribute('margin', '44px');
  view.renderer.setAttribute('gap', '6%');
  view.renderer.setAttribute('max-inline-size', '680px');
  view.addEventListener('load', (e) => wireDoc(e.detail.doc));
  view.addEventListener('relocate', (e) => onMove(id, e.detail));
  applyLook();

  const title = book ? book.title : (typeof view.book.metadata?.title === 'string' ? view.book.metadata.title : '');
  $('rd-title').textContent = title; document.title = `${title} · Reader`;
  buildToc(view.book.toc || []);
  show('rd-book');
  shelfReady = false;
  await view.init({ lastLocation: location || null });
  setTimeout(() => { shelfReady = true; }, 1500);
  flashBars();
  keepAwake();
  maybeAskStart();
  // First time in the reader, but the shelf already has a progress (typed by hand): offer to go there.
  if (!location && owner && book && readingNow(book) && Number(book.progress) > 0) {
    const p = Number(book.progress);
    ask(`Your shelf says ${p}%. Go there?`, () => view.goToFraction(p / 100));
  }
}

// Taps inside the page: left third back, right third forward, middle shows or hides the bars.
function wireDoc(doc) {
  doc.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.target.closest('a[href]')) return;
    if (doc.getSelection && String(doc.getSelection()).trim()) return;   // selecting text
    const frame = doc.defaultView.frameElement;
    const x = (frame ? frame.getBoundingClientRect().left : 0) + e.clientX;
    const r = $('rd-view').getBoundingClientRect();
    const f = (x - r.left) / r.width;
    if (f < 0.3) view.goLeft(); else if (f > 0.7) view.goRight(); else toggleBars();
  });
  doc.addEventListener('keydown', onKey);
}
function onKey(e) {
  if (!view || $('rd-book').hidden) return;
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') { view.goLeft(); e.preventDefault(); }
  else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { view.goRight(); e.preventDefault(); }
  else if (e.key === 'Escape') closePanels();
}
document.addEventListener('keydown', onKey);

let barsTimer;
function toggleBars(force) {
  const on = force ?? !document.body.classList.contains('rd-bars');
  document.body.classList.toggle('rd-bars', on);
  if (!on) closePanels();
}
function flashBars() { toggleBars(true); clearTimeout(barsTimer); barsTimer = setTimeout(() => { if (!$('rd-toc').hidden || !$('rd-aa').hidden) return; toggleBars(false); }, 2500); }
function closePanels() { $('rd-toc').hidden = true; $('rd-aa').hidden = true; $('rd-toc-btn').setAttribute('aria-expanded', 'false'); $('rd-aa-btn').setAttribute('aria-expanded', 'false'); }

function buildToc(toc) {
  const item = (t) => `<li><button type="button" data-href="${esc(t.href)}">${esc(t.label)}</button>${t.subitems && t.subitems.length ? `<ol>${t.subitems.map(item).join('')}</ol>` : ''}</li>`;
  $('rd-toc-list').innerHTML = toc.length ? toc.map(item).join('') : '<li class="hint">This book has no contents list.</li>';
}

// ---------- where you are ----------
let saveTimer = null, pending = null, lastPct = null;
let shelfReady = false;   // the shelf's progress is only changed by moving in the book, not by opening it
function onMove(id, d) {
  const frac = Number(d.fraction) || 0;
  $('rd-slider').value = String(frac);
  $('rd-pct').textContent = `${Math.round(frac * 100)}%`;
  $('rd-chapter').textContent = d.tocItem?.label ? `${d.tocItem.label} ·` : '';
  if (!d.cfi) return;
  pending = { location: d.cfi, fraction: Math.round(frac * 10000) / 10000, updated_at: new Date().toISOString() };
  setLocalPos(id, pending);
  clearTimeout(saveTimer); saveTimer = setTimeout(() => flush(id), 2500);
  if (frac >= 0.995) maybeAskFinish();
}
async function flush(id) {
  clearTimeout(saveTimer);
  if (!pending || !api) return;
  const p = pending; pending = null;
  try {
    await api.savePosition(id, p.location, p.fraction, p.updated_at);
    // Your own progress on the shelf, while the book is being read (not for a finished book).
    const pct = Math.round(p.fraction * 100);
    if (shelfReady && owner && book && readingNow(book) && pct !== lastPct && pct !== Number(book.progress)) {
      lastPct = pct;
      const patch = { progress: pct, progress_mark: null, progress_on: today() };
      await api.patchBook(id, patch); Object.assign(book, patch);
    }
  } catch (e) { pending = pending || p; /* offline: kept on the phone, sent next time */ }
}
const currentId = () => decodeURIComponent(location.hash.slice(1));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(openId); else keepAwake(); });
addEventListener('pagehide', () => flush(openId));

// The screen stays on while a book is open.
let wake = null;
async function keepAwake() {
  if ($('rd-book').hidden || !('wakeLock' in navigator) || (wake && !wake.released)) return;
  try { wake = await navigator.wakeLock.request('screen'); } catch (e) { /* not allowed now */ }
}

// ---------- the two questions (owner only) ----------
function ask(text, onYes) {
  $('rd-ask-text').textContent = text; $('rd-ask').hidden = false;
  $('rd-ask-no').onclick = () => { $('rd-ask').hidden = true; };
  $('rd-ask-yes').onclick = async () => {
    $('rd-ask').hidden = true;
    try { await onYes(); } catch (e) { toast(`Could not save: ${e.message}`); }
  };
}
function maybeAskStart() {
  if (!owner || !book || book.status !== 'want') return;
  ask(`Mark “${book.title}” as ${STATUS.reading}?`, async () => {
    const patch = { status: 'reading' };
    if (!book.started_at) patch.started_at = today();
    await api.patchBook(book.id, patch); Object.assign(book, patch);
    toast(`Now ${STATUS.reading}.`);
  });
}
let askedFinish = false;
function maybeAskFinish() {
  if (askedFinish || !owner || !book || !readingNow(book)) return;
  askedFinish = true;
  ask(`Finished “${book.title}”? Mark it as ${STATUS.read}.`, async () => {
    // The same rules as the dashboard's status menu: a finished reread counts as one more read.
    const rereading = book.status === 'read' && !!book.rereading;
    const patch = { status: 'read', progress: null, progress_mark: null, progress_on: null };
    if (!book.finished_at) patch.finished_at = today();
    const prior = rereading ? readsOf(book) : (Array.isArray(book.reads) ? book.reads : []);
    if (prior.length) { patch.reads = [...prior, { d: today() }]; patch.finished_at = today(); }
    if (book.rereading) Object.assign(patch, { rereading: false, started_at: null });
    await api.patchBook(book.id, patch); Object.assign(book, patch);
    toast('Marked as Read. Well done!');
  });
}

// ---------- bars and panels ----------
$('rd-back').addEventListener('click', async () => {
  const id = openId; await flush(id);
  if (document.referrer && new URL(document.referrer).origin === location.origin && history.length > 1) history.back();
  else location.href = id ? `./#/book/${encodeURIComponent(id)}` : './reader.html';
});
$('rd-toc-btn').addEventListener('click', () => {
  const open = $('rd-toc').hidden; closePanels(); $('rd-toc').hidden = !open; $('rd-toc-btn').setAttribute('aria-expanded', String(open)); clearTimeout(barsTimer);
});
$('rd-aa-btn').addEventListener('click', () => {
  const open = $('rd-aa').hidden; closePanels(); $('rd-aa').hidden = !open; $('rd-aa-btn').setAttribute('aria-expanded', String(open)); clearTimeout(barsTimer);
});
$('rd-toc-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-href]'); if (!b) return;
  view.goTo(b.dataset.href).catch(() => {}); closePanels(); toggleBars(false);
});
$('rd-aa').addEventListener('click', (e) => {
  const size = e.target.closest('[data-size]'), space = e.target.closest('[data-space]'), pick = e.target.closest('[data-theme-pick]');
  if (size) prefs.size = Math.min(200, Math.max(70, prefs.size + 10 * Number(size.dataset.size)));
  if (space) prefs.space = Math.min(2.4, Math.max(1.1, Math.round((prefs.space + 0.1 * Number(space.dataset.space)) * 10) / 10));
  if (pick) prefs.theme = pick.dataset.themePick;
  if (size || space || pick) { savePrefs(); applyLook(); }
});
$('rd-slider').addEventListener('change', (e) => view?.goToFraction(Number(e.target.value)));
// Panels close when tapping outside them.
$('rd-view').addEventListener('click', closePanels);

// ---------- start ----------
async function start() {
  applyLook();
  const id = currentId();
  let session = await signedIn();
  if (api && !session) session = await askSignIn();
  if (api && session) {
    const ok = await api.amReader().catch(() => null);   // null: no connection, decided later
    if (ok === false) { show('rd-signin'); $('rd-err').textContent = 'This account is not allowed to read books here.'; return; }
  }
  if (id) openBook(id); else showList();
}
addEventListener('hashchange', async () => { await flush(openId); location.reload(); });
start();

// The same service worker as the shelf: keeps the reader's own files for opening with no connection.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
