// Goodreads import (dashboard only).
// The exported CSV is read here in the browser. Nothing is saved until you press "Import".
import {
  esc, norm, probeCover, importBooks, setCoverUrl,
  ytId, ytThumb, youtubeConfigured, playlistId, fetchPlaylist, fmtDuration,
} from './api.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BENGALI = /[\u0980-\u09FF]/;

let hooks = null;   // { getBooks, refresh, toast, statusBadge, badge } given by admin.js
let S = null;       // the import in progress

// ---------- reading the CSV ----------
// Handles quoted cells, commas and line breaks inside quotes (Goodreads reviews have them).
export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);       // byte-order mark
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

const cleanTitle = (t) => t.replace(/\s*\([^()]*#\d+[^()]*\)\s*$/, '').replace(/\s+/g, ' ').trim();   // drops "(Series, #2)"
const cleanIsbn = (v) => String(v || '').replace(/[^0-9Xx]/g, '').toUpperCase();                         // Goodreads writes ="978..."
const STATUS_OF = { read: 'read', 'currently-reading': 'reading', 'to-read': 'want' };
const PLAIN_SHELVES = ['read', 'to-read', 'currently-reading'];

// Turn the Goodreads file into a list of books we can show and edit.
export function readGoodreads(text, existing) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('That file is empty.');
  const head = {};
  rows[0].forEach((name, i) => { head[name.trim().toLowerCase()] = i; });
  if (head.title === undefined || head.author === undefined) {
    throw new Error('This does not look like a Goodreads export (no Title and Author columns).');
  }
  const seen = new Set(existing.map((b) => `${norm(b.title)}|${norm(b.author)}`));
  const out = [];
  rows.slice(1).forEach((r) => {
    const g = (k) => (head[k] === undefined ? '' : String(r[head[k]] ?? '').trim());
    const title = cleanTitle(g('title'));
    if (!title) return;
    const author = g('author') || 'Unknown';
    const binding = g('binding').toLowerCase();
    const year = parseInt(g('original publication year'), 10) || parseInt(g('year published'), 10) || null;
    const pages = parseInt(g('number of pages'), 10) || null;
    const status = STATUS_OF[g('exclusive shelf').toLowerCase()] || 'want';
    const read = g('date read').match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
    out.push({
      title, author, binding, status,
      isbn: cleanIsbn(g('isbn13')) || cleanIsbn(g('isbn')),
      year: year && year >= 1000 && year <= 2999 ? year : null,
      pages,
      format: /audio/.test(binding) ? 'Audiobook' : 'Book',
      language: BENGALI.test(title + author) ? 'Bengali' : 'English',
      finished: status === 'read' && read ? `${read[1]}-${read[2]}-${read[3]}` : null,
      genres: g('bookshelves').split(',').map((x) => x.trim()).filter((x) => x && !PLAIN_SHELVES.includes(x.toLowerCase()))
        .map((x) => { const t = x.replace(/[-_]+/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); })
        .filter((x) => x.length <= 40).slice(0, 8),
      review: g('my review'),
      ownedCopies: parseInt(g('owned copies'), 10) || 0,
      dup: seen.has(`${norm(title)}|${norm(author)}`),
    });
  });
  out.forEach((r, i) => { r.i = i; r.sel = !r.dup; });
  return out;
}

// ---------- turning a row into a book record ----------
function ownershipOf(r, mode) {
  if (mode === 'owned') return 'owned';
  if (mode === 'buy') return 'buy';
  return r.ownedCopies > 0 || r.status !== 'want' ? 'owned' : 'buy';      // smart
}
function copiesOf(r, ownership) {
  if (ownership !== 'owned' || r.format !== 'Book') return [];
  if (/kindle|e-?book|nook|digital|epub|pdf/.test(r.binding)) return ['ebook'];
  if (/hard|paper|mass market|board|library binding|spiral|leather|flexi/.test(r.binding)) return ['hardcopy'];
  return [];
}
function toRecord(r, opts) {
  const ownership = ownershipOf(r, opts.owner);
  return {
    id: crypto.randomUUID(),
    title: r.title, author: r.author,
    pub_year: r.year, pages: r.format === 'Book' ? r.pages : null, duration: null,
    language: r.language, format: r.format, status: r.status, ownership,
    youtube_url: null,
    description: opts.reviews && r.review ? r.review : null,
    genres: opts.shelves ? r.genres : [],
    copies: copiesOf(r, ownership),
    finished_at: r.finished,
    isbn: r.isbn || null,
    cover_path: null,
    cover_url: r.cover || null,
  };
}

// ---------- the dialog ----------
const dlg = () => $('import-panel');
const selectedRows = () => S.rows.filter((r) => r.sel);

function show(title, body, actions) {
  $('imp-title').textContent = title;
  $('imp-body').innerHTML = body;
  $('imp-actions').innerHTML = actions;
  $('imp-body').scrollTop = 0;
}

function stepChoose(message) {
  show('Import from Goodreads', `
    <ol class="imp-steps">
      <li>On a computer, open <b>Goodreads</b> and go to <b>My Books</b>.</li>
      <li>Under <b>Tools</b>, choose <b>Import and export</b>.</li>
      <li>Click <b>Export Library</b> and download the file.</li>
      <li>Choose that file here.</li>
    </ol>
    <p class="hint">The Goodreads phone app can&rsquo;t export, so use the website. Your file is only read on this device. Nothing is saved until you press Import.</p>
    <div class="drop" id="imp-drop" tabindex="0" role="button"><span>Tap to choose your Goodreads file (.csv)</span></div>
    <input type="file" id="imp-file" accept=".csv,text/csv" hidden>
    <p class="err" id="imp-err" role="alert">${esc(message || '')}</p>`,
    '<button class="btn" type="button" id="imp-back">Back</button>');
  const pick = () => $('imp-file').click();
  $('imp-drop').addEventListener('click', pick);
  $('imp-drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
  ['dragenter', 'dragover'].forEach((ev) => $('imp-drop').addEventListener(ev, (e) => { e.preventDefault(); $('imp-drop').classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => $('imp-drop').addEventListener(ev, (e) => { e.preventDefault(); $('imp-drop').classList.remove('over'); }));
  $('imp-drop').addEventListener('drop', (e) => loadFile(e.dataTransfer.files[0]));
  $('imp-file').addEventListener('change', () => { loadFile($('imp-file').files[0]); $('imp-file').value = ''; });
  $('imp-back').addEventListener('click', stepSource);
}

async function loadFile(file) {
  if (!file) return;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error('That file is too large to be a Goodreads export.');
    S.rows = readGoodreads(await file.text(), hooks.getBooks());
    if (!S.rows.length) throw new Error('No books were found in that file.');
    stepReview();
  } catch (err) {
    $('imp-err').textContent = err.message || 'Could not read that file.';
  }
}

const optsNow = () => ({
  owner: $('imp-own') ? $('imp-own').value : S.opts.owner,
  covers: $('imp-covers') ? $('imp-covers').checked : S.opts.covers,
  shelves: $('imp-shelves') ? $('imp-shelves').checked : S.opts.shelves,
  reviews: $('imp-reviews') ? $('imp-reviews').checked : S.opts.reviews,
});

function stepReview() {
  const total = S.rows.length, dups = S.rows.filter((r) => r.dup).length;
  show('Review your books', `
    <p class="imp-sum"><b>${total}</b> books found &middot; <b>${total - dups}</b> new${dups ? ` &middot; <b>${dups}</b> already in your shelf` : ''}</p>
    <div class="imp-opts">
      <div class="field">
        <label for="imp-own">Ownership</label>
        <select id="imp-own">
          <option value="smart">Smart (recommended)</option>
          <option value="owned">Mark all as Owned</option>
          <option value="buy">Mark all as Want to Buy</option>
        </select>
        <p class="hint">Smart: books you read or are reading are Owned, books on your to-read list are Want to Buy.</p>
      </div>
      <label class="imp-opt"><input type="checkbox" id="imp-covers" checked><span>Find covers automatically<span class="hint">Looks each book up by ISBN on Open Library. Many Bengali books won&rsquo;t be found; you can upload those yourself.</span></span></label>
      <label class="imp-opt"><input type="checkbox" id="imp-shelves" checked><span>Use my Goodreads shelves as genres</span></label>
      <label class="imp-opt"><input type="checkbox" id="imp-reviews"><span>Use my reviews as notes</span></label>
    </div>
    <p class="hint">Goodreads doesn&rsquo;t say which language a book is in. Tap <b>Bengali</b> on the books that are Bengali; Bengali script is detected automatically.</p>
    <div class="imp-bar"><span id="imp-count"></span><span><button class="btn" type="button" id="imp-all">Select all</button> <button class="btn" type="button" id="imp-none">None</button></span></div>
    <div class="imp-list" id="imp-list"></div>`,
    '<button class="btn" type="button" id="imp-back">Back</button><button class="btn primary" type="button" id="imp-go"></button>');
  $('imp-own').value = S.opts.owner;
  $('imp-covers').checked = S.opts.covers; $('imp-shelves').checked = S.opts.shelves; $('imp-reviews').checked = S.opts.reviews;
  renderList();
  $('imp-own').addEventListener('change', () => { S.opts = optsNow(); renderList(); });
  ['imp-covers', 'imp-shelves', 'imp-reviews'].forEach((id) => $(id).addEventListener('change', () => { S.opts = optsNow(); }));
  $('imp-all').addEventListener('click', () => { S.rows.forEach((r) => { r.sel = true; }); renderList(); });
  $('imp-none').addEventListener('click', () => { S.rows.forEach((r) => { r.sel = false; }); renderList(); });
  $('imp-back').addEventListener('click', () => stepChoose());
  $('imp-go').addEventListener('click', runImport);
  $('imp-list').addEventListener('change', (e) => {
    const box = e.target.closest('input[type=checkbox][data-i]');
    if (!box) return;
    S.rows[+box.dataset.i].sel = box.checked;
    box.closest('.imp-row').classList.toggle('off', !box.checked);
    updateCount();
  });
  $('imp-list').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-lang]');
    if (!chip) return;
    e.preventDefault();
    const r = S.rows[+chip.dataset.lang];
    r.language = r.language === 'Bengali' ? 'English' : 'Bengali';
    chip.setAttribute('aria-pressed', String(r.language === 'Bengali'));
    chip.closest('.imp-row').querySelectorAll('.imp-title, .imp-author').forEach((el) => el.classList.toggle('bn', r.language === 'Bengali'));
  });
}

function renderList() {
  const mode = S.opts.owner;
  $('imp-list').innerHTML = S.rows.map((r) => {
    const ownership = ownershipOf(r, mode);
    const bn = r.language === 'Bengali' ? ' bn' : '';
    const meta = [r.pages && r.format === 'Book' ? `${r.pages} pages` : '', r.year || ''].filter(Boolean).join(' \u00b7 ');
    return `<label class="imp-row${r.sel ? '' : ' off'}">
      <input type="checkbox" data-i="${r.i}" ${r.sel ? 'checked' : ''} aria-label="Import ${esc(r.title)}">
      <div>
        <div class="imp-title${bn}">${esc(r.title)}</div>
        <div class="imp-author${bn}">${esc(r.author)}${meta ? ` \u00b7 ${esc(meta)}` : ''}</div>
        <div class="imp-tags">
          ${hooks.statusBadge({ status: r.status })}${hooks.badge({ ownership })}
          ${r.format === 'Audiobook' ? '<span class="badge fmt">Audiobook</span>' : ''}
          ${r.dup ? '<span class="badge fmt">Already in your shelf</span>' : ''}
          <button type="button" class="chip" data-lang="${r.i}" aria-pressed="${r.language === 'Bengali'}">Bengali</button>
        </div>
      </div>
    </label>`;
  }).join('');
  updateCount();
}

function updateCount() {
  const n = selectedRows().length;
  $('imp-count').textContent = `${n} of ${S.rows.length} selected`;
  const go = $('imp-go');
  go.textContent = n ? `Import ${n} ${n === 1 ? 'book' : 'books'}` : 'Nothing selected';
  go.disabled = n === 0;
}

// ---------- working ----------
function stepWork(title, message) {
  show(title, `<div class="imp-center"><p id="imp-msg">${esc(message)}</p><div class="progress"><i id="imp-prog"></i></div></div>`,
    '<button class="btn" type="button" id="imp-skip">Skip covers</button>');
  $('imp-skip').addEventListener('click', () => { if (S.ctl) S.ctl.stop = true; });
}
function tick(done, total, label) {
  const msg = $('imp-msg'), bar = $('imp-prog');
  if (msg) msg.textContent = `${label} ${done} of ${total}`;
  if (bar) bar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
}

// Look up covers three at a time, with a short pause, to stay polite to Open Library.
async function findCovers(rows, label) {
  S.ctl = { stop: false };
  let next = 0, done = 0;
  const worker = async () => {
    while (!S.ctl.stop) {
      const k = next++;
      if (k >= rows.length) return;
      rows[k].cover = await probeCover(rows[k].isbn);
      tick(++done, rows.length, label);
      await sleep(120);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

async function runImport() {
  const opts = (S.opts = optsNow());
  const picked = selectedRows();
  S.picked = picked; S.saved = 0; S.error = '';
  if (opts.covers) {
    const todo = picked.filter((r) => r.isbn);
    if (todo.length) {
      stepWork('Finding covers', 'Finding covers\u2026');
      tick(0, todo.length, 'Finding covers');
      await findCovers(todo, 'Finding covers');
      if (S.cancelled) return;                  // the dialog was closed while looking up covers
    }
  }
  stepWork('Saving your books', 'Saving\u2026');
  $('imp-skip').hidden = true;
  const records = picked.map((r) => { const rec = toRecord(r, opts); r.dbId = rec.id; return rec; });
  try {
    S.saved = await importBooks(records);
  } catch (err) {
    S.saved = err.saved || 0;
    S.error = err.message || 'Something went wrong while saving.';
  }
  await hooks.refresh();
  stepDone();
}

function stepDone() {
  const saved = S.saved, picked = S.picked;
  const savedRows = picked.slice(0, saved);
  const withCover = savedRows.filter((r) => r.cover).length;
  const noIsbn = savedRows.filter((r) => !r.isbn).length;
  const retry = savedRows.filter((r) => !r.cover && r.isbn);
  const skipped = S.rows.filter((r) => !r.sel).length;
  show(S.error ? 'Import stopped' : 'Import finished', `
    <div class="imp-center">
      <div class="imp-big">${S.error ? '!' : '\u2713'}</div>
      <h3 style="margin:0 0 4px">${saved} ${saved === 1 ? 'book' : 'books'} imported</h3>
      ${S.error ? `<p class="err" role="alert">${esc(S.error)} ${saved ? 'The books before this point were saved.' : ''}</p>` : ''}
    </div>
    <div class="imp-stats">
      ${S.opts.covers ? `<div class="imp-stat"><span>Covers found</span><b>${withCover}</b></div>` : ''}
      <div class="imp-stat"><span>Without a cover</span><b>${saved - withCover}</b></div>
      ${noIsbn ? `<div class="imp-stat"><span>No ISBN, so no automatic cover</span><b>${noIsbn}</b></div>` : ''}
      ${skipped ? `<div class="imp-stat"><span>Not imported (unticked or already there)</span><b>${skipped}</b></div>` : ''}
    </div>
    <p class="hint">Books without a cover show &ldquo;No cover&rdquo;. In the list, choose <b>No cover</b> in the filter to find them and upload your own.</p>`,
    `${retry.length && S.opts.covers ? '<button class="btn" type="button" id="imp-retry">Try covers again</button>' : ''}<button class="btn primary" type="button" id="imp-done">Done</button>`);
  $('imp-done').addEventListener('click', () => { dlg().close(); if (saved) hooks.toast(`${saved} ${saved === 1 ? 'book' : 'books'} imported`); });
  const again = $('imp-retry');
  if (again) again.addEventListener('click', async () => {
    stepWork('Finding covers', 'Finding covers\u2026');
    tick(0, retry.length, 'Finding covers');
    await findCovers(retry, 'Finding covers');
    for (const r of retry) { if (r.cover) { try { await setCoverUrl(r.dbId, r.cover); } catch (e) { r.cover = ''; } } }
    await hooks.refresh();
    stepDone();
  });
}

// ---------- choosing where the books come from ----------
const SVG = (inner) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICON_BOOK = SVG('<path d="M8 4.2C6.6 3.1 4.6 2.8 2.5 3.3V12c2.1-.5 4.1-.2 5.5 1"/><path d="M8 4.2c1.4-1.1 3.4-1.4 5.5-.9V12c-2.1-.5-4.1-.2-5.5 1"/><path d="M8 4.2V13"/>');
const ICON_PLAY = SVG('<rect x="1.5" y="3.5" width="13" height="9" rx="2.5"/><path d="M6.6 6v4l3.4-2z"/>');

function stepSource() {
  show('Import books', `
    <p style="margin-top:0">Where are the books you want to bring in?</p>
    <div class="imp-sources">
      <button type="button" class="imp-source" id="src-gr">${ICON_BOOK}<span><b>Goodreads</b><small>Your list from a Goodreads export (a CSV file).</small></span></button>
      <button type="button" class="imp-source" id="src-yt">${ICON_PLAY}<span><b>YouTube playlist</b><small>Audiobooks from a Public or Unlisted playlist.</small></span></button>
    </div>`,
    '<button class="btn" type="button" id="imp-cancel">Cancel</button>');
  $('src-gr').addEventListener('click', stepChoose);
  $('src-yt').addEventListener('click', () => stepPlaylist());
  $('imp-cancel').addEventListener('click', () => dlg().close());
}

function stepBusy(title, message) {
  show(title, `<div class="imp-center"><p id="imp-msg">${esc(message)}</p><div class="progress busy"><i></i></div></div>`, '');
}

// ---------- YouTube playlist: guessing a title and an author from a video title ----------
// YouTube knows the uploader, not the book's author, so this is only a guess for you to check.
const NOISE = /(?:bangla|bengali)\s+audio\s*books?|(?:full\s+)?audio\s*books?|unabridged|full\s+audio|\bhd\b|অডিও\s*বুক|অডিওবুক|সম্পূর্ণ|\bfull\b/gi;
const NARRATOR = /^\s*(?:narrat\w*|read(?:\s+by)?|reader|voic\w*|presented|performed)\b|^\s*(?:পাঠে|কণ্ঠে|ভয়েস)/i;
const trimMarks = (t) => t.replace(/^[\s\-\u2013\u2014|:,.\u0964"'\u201c\u201d\u2018\u2019]+|[\s\-\u2013\u2014|:,.\u0964"'\u201c\u201d\u2018\u2019]+$/g, '').trim();

export function guessTitleAuthor(raw) {
  let t = String(raw || '').replace(/\s+/g, ' ').trim();
  // brackets that only hold noise words, e.g. "(Full Audiobook)" or "[Audiobook]", are removed
  t = t.replace(/[(\[{]([^)\]}]*)[)\]}]/g, (m, inner) => (trimMarks(inner.replace(NOISE, '')) && !NARRATOR.test(inner) ? m : ''));
  const parts = t.split(/\s*[|\u2013\u2014\u0964]\s*|\s+-\s+|\s+:\s+/)
    .map((p) => trimMarks(p.replace(NOISE, '')))
    .filter((p) => p && !NARRATOR.test(p));
  if (!parts.length) return { title: trimMarks(String(raw || '')) || 'Untitled', author: '' };
  for (const p of parts) {
    const by = p.match(/^(.+?)\s+by\s+(.+)$/i);
    if (by) return { title: trimMarks(by[1]), author: trimMarks(by[2].split(/\s+(?:narrated|read|voiced|performed)\s+by\s+/i)[0]) };
    const label = p.match(/^\u09b2\u09c7\u0996\u0995\s*[:\-\u2013]?\s*(.+)$/);        // "লেখক: ..."
    if (label) return { title: parts.find((x) => x !== p) || p, author: trimMarks(label[1]) };
  }
  return { title: parts[0], author: parts[1] || '' };
}

// ---------- YouTube playlist: the screens ----------
let Y = null;

function stepPlaylist(message, keep) {
  const ready = youtubeConfigured;
  show('Import a YouTube playlist', `
    <p style="margin-top:0">Paste the link to a playlist of audiobooks. It must be <b>Public</b> or <b>Unlisted</b>.</p>
    ${ready ? '' : `<div class="imp-warn" role="alert"><b>One-time setup needed.</b> Reading playlists needs a free YouTube API key. Add it to <code>js/config.js</code> and reload this page. The README (&ldquo;YouTube playlists&rdquo;) has the steps.</div>`}
    <div class="field"><label for="yt-url">Playlist link</label>
      <input id="yt-url" type="url" inputmode="url" placeholder="https://www.youtube.com/playlist?list=&hellip;" autocomplete="off" ${ready ? '' : 'disabled'}></div>
    <p class="hint">You get each video&rsquo;s title, length and link. The cover is the video&rsquo;s own thumbnail, so nothing to upload. YouTube doesn&rsquo;t know a book&rsquo;s author, so you&rsquo;ll check a guess for each one.</p>
    <p class="err" id="yt-err" role="alert">${esc(message || '')}</p>`,
    `<button class="btn" type="button" id="imp-back">Back</button><button class="btn primary" type="button" id="yt-go" ${ready ? '' : 'disabled'}>Read playlist</button>`);
  if (keep) $('yt-url').value = keep;
  $('imp-back').addEventListener('click', stepSource);
  $('yt-go').addEventListener('click', readPlaylist);
  $('yt-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); readPlaylist(); } });
}

async function readPlaylist() {
  const url = $('yt-url').value;
  const id = playlistId(url);
  if (!id) { $('yt-err').textContent = 'That does not look like a playlist link. It should contain \u201clist=\u201d.'; return; }
  stepBusy('Reading the playlist', 'Reading the playlist\u2026');
  try {
    const pl = await fetchPlaylist(id);
    if (S.cancelled) return;
    if (!pl.items.length) throw new Error('That playlist has no videos we can read.');
    buildYt(pl);
    stepYtReview();
  } catch (err) {
    if (!S.cancelled) stepPlaylist(err.message || 'Could not read that playlist.', url);
  }
}

function buildYt(pl) {
  const have = new Set(hooks.getBooks().map((b) => ytId(b.youtube_url)).filter(Boolean));
  const rows = pl.items.map((it, i) => {
    const g = guessTitleAuthor(it.title);
    const dup = have.has(it.id);
    return { i, id: it.id, title: g.title, author: g.author, seconds: it.seconds, language: BENGALI.test(it.title) ? 'Bengali' : 'English', dup, sel: !dup };
  });
  const g = guessTitleAuthor(pl.title);
  if (g.title.length < 3) g.title = pl.title;          // a name that was mostly noise words: keep the original
  Y = {
    pl, rows, mode: 'each', opts: { status: 'want', ownership: 'owned' },
    one: { title: g.title, author: g.author || (rows[0] ? rows[0].author : ''), language: BENGALI.test(pl.title) ? 'Bengali' : 'English', total: rows.reduce((n, r) => n + r.seconds, 0), dup: rows[0].dup },
  };
}

const ytOpts = () => ({ status: $('yt-status').value, ownership: $('yt-own').value });
const MODE_HINT = {
  each: 'Each video becomes its own audiobook, with its own length.',
  one: 'The parts become one audiobook. Lengths are added up, and the link opens the first part inside the playlist, so the next parts play on.',
};

function stepYtReview() {
  const total = Y.rows.reduce((n, r) => n + r.seconds, 0);
  show('Review the playlist', `
    <p class="imp-sum"><b>${esc(Y.pl.title)}</b><br><b>${Y.rows.length}</b> videos &middot; ${esc(fmtDuration(total))} in total${Y.pl.skipped ? ` &middot; ${Y.pl.skipped} private or deleted skipped` : ''}${Y.pl.capped ? ' &middot; only the first 500 were read' : ''}</p>
    <div class="imp-opts">
      <div class="field">
        <label for="yt-mode">What is in this playlist?</label>
        <select id="yt-mode"><option value="each">Many audiobooks</option><option value="one">One audiobook, in parts</option></select>
        <p class="hint" id="yt-mode-hint"></p>
      </div>
      <div class="two">
        <div class="field"><label for="yt-status">Reading status</label>
          <select id="yt-status"><option value="want">Want to Read</option><option value="reading">Currently Reading</option><option value="read">Read</option></select></div>
        <div class="field"><label for="yt-own">Ownership</label>
          <select id="yt-own"><option value="owned">Owned</option><option value="buy">Want to Buy</option></select></div>
      </div>
    </div>
    <div id="yt-list"></div>`,
    '<button class="btn" type="button" id="imp-back">Back</button><button class="btn primary" type="button" id="imp-go"></button>');
  $('yt-mode').value = Y.mode; $('yt-status').value = Y.opts.status; $('yt-own').value = Y.opts.ownership;
  $('yt-mode').addEventListener('change', () => { Y.mode = $('yt-mode').value; renderYt(); });
  $('yt-status').addEventListener('change', () => { Y.opts = ytOpts(); });
  $('yt-own').addEventListener('change', () => { Y.opts = ytOpts(); });
  $('imp-back').addEventListener('click', () => stepPlaylist());
  $('imp-go').addEventListener('click', runYtImport);
  $('yt-list').addEventListener('change', (e) => {
    const box = e.target.closest('input[type=checkbox][data-yi]');
    if (!box) return;
    Y.rows[+box.dataset.yi].sel = box.checked;
    box.closest('.imp-row').classList.toggle('off', !box.checked);
    updateYtCount();
  });
  $('yt-list').addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.ytitle !== undefined) Y.rows[+t.dataset.ytitle].title = t.value;
    else if (t.dataset.yauthor !== undefined) Y.rows[+t.dataset.yauthor].author = t.value;
    else if (t.dataset.one) Y.one[t.dataset.one] = t.value;
  });
  $('yt-list').addEventListener('click', (e) => {
    if (e.target.closest('#yt-all')) { Y.rows.forEach((r) => { r.sel = true; }); renderYt(); return; }
    if (e.target.closest('#yt-none')) { Y.rows.forEach((r) => { r.sel = false; }); renderYt(); return; }
    const chip = e.target.closest('[data-ylang]');
    if (!chip) return;
    const target = chip.dataset.ylang === 'one' ? Y.one : Y.rows[+chip.dataset.ylang];
    target.language = target.language === 'Bengali' ? 'English' : 'Bengali';
    chip.setAttribute('aria-pressed', String(target.language === 'Bengali'));
    chip.closest('.imp-row').querySelectorAll('.imp-in').forEach((el) => el.classList.toggle('bn', target.language === 'Bengali'));
  });
  renderYt();
}

const ytThumbOf = (id) => ytThumb(`https://www.youtube.com/watch?v=${id}`, 'mqdefault');

function renderYt() {
  $('yt-mode-hint').textContent = MODE_HINT[Y.mode];
  if (Y.mode === 'one') {
    const o = Y.one, bn = o.language === 'Bengali' ? ' bn' : '';
    $('yt-list').innerHTML = `<div class="imp-row imp-yt" style="grid-template-columns:1fr">
      <div class="imp-yt-body">
        <div class="imp-yt-head"><img class="imp-thumb" src="${esc(ytThumbOf(Y.rows[0].id))}" alt="">
          <div class="imp-yt-meta"><b>${esc(fmtDuration(o.total))}</b><span class="badge fmt">${Y.rows.length} parts</span>
          ${o.dup ? '<span class="badge fmt">In your shelf</span>' : ''}
          <button type="button" class="chip" data-ylang="one" aria-pressed="${o.language === 'Bengali'}">Bengali</button></div></div>
        <input class="imp-in${bn}" data-one="title" value="${esc(o.title)}" placeholder="Title" aria-label="Title">
        <input class="imp-in${bn}" data-one="author" value="${esc(o.author)}" placeholder="Author (please add)" aria-label="Author">
      </div></div>`;
    $('imp-go').textContent = 'Import 1 audiobook'; $('imp-go').disabled = false;
    return;
  }
  $('yt-list').innerHTML = `<div class="imp-bar"><span id="imp-count"></span><span><button class="btn" type="button" id="yt-all">Select all</button> <button class="btn" type="button" id="yt-none">None</button></span></div>
    <div class="imp-list">${Y.rows.map((r) => {
      const bn = r.language === 'Bengali' ? ' bn' : '';
      return `<div class="imp-row imp-yt${r.sel ? '' : ' off'}">
        <input type="checkbox" data-yi="${r.i}" ${r.sel ? 'checked' : ''} aria-label="Import ${esc(r.title)}">
        <div class="imp-yt-body">
          <div class="imp-yt-head"><img class="imp-thumb" src="${esc(ytThumbOf(r.id))}" alt="" loading="lazy">
            <div class="imp-yt-meta"><b>${esc(fmtDuration(r.seconds))}</b>${r.dup ? '<span class="badge fmt">In your shelf</span>' : ''}
            <button type="button" class="chip" data-ylang="${r.i}" aria-pressed="${r.language === 'Bengali'}">Bengali</button></div></div>
          <input class="imp-in${bn}" data-ytitle="${r.i}" value="${esc(r.title)}" placeholder="Title" aria-label="Title">
          <input class="imp-in${bn}" data-yauthor="${r.i}" value="${esc(r.author)}" placeholder="Author (please add)" aria-label="Author">
        </div></div>`;
    }).join('')}</div>`;
  updateYtCount();
}

function updateYtCount() {
  const n = Y.rows.filter((r) => r.sel).length;
  $('imp-count').textContent = `${n} of ${Y.rows.length} selected`;
  $('imp-go').textContent = n ? `Import ${n} ${n === 1 ? 'audiobook' : 'audiobooks'}` : 'Nothing selected';
  $('imp-go').disabled = n === 0;
}

async function runYtImport() {
  const o = (Y.opts = ytOpts());
  stepBusy('Saving your books', 'Saving\u2026');
  const base = { pub_year: null, pages: null, description: null, genres: [], copies: [], finished_at: null, isbn: null, cover_path: null, cover_url: null,
    format: 'Audiobook', status: o.status, ownership: o.ownership };
  let records;
  if (Y.mode === 'one') {
    records = [{ ...base, id: crypto.randomUUID(), title: Y.one.title.trim() || Y.pl.title, author: Y.one.author.trim() || 'Unknown', language: Y.one.language,
      duration: fmtDuration(Y.one.total), youtube_url: `https://www.youtube.com/watch?v=${Y.rows[0].id}&list=${Y.pl.id}` }];
    Y.seconds = Y.one.total;
  } else {
    const picked = Y.rows.filter((r) => r.sel);
    records = picked.map((r) => ({ ...base, id: crypto.randomUUID(), title: r.title.trim() || 'Untitled', author: r.author.trim() || 'Unknown', language: r.language,
      duration: fmtDuration(r.seconds), youtube_url: `https://www.youtube.com/watch?v=${r.id}` }));
    Y.seconds = picked.reduce((n, r) => n + r.seconds, 0);
  }
  Y.noAuthor = records.filter((r) => r.author === 'Unknown').length;
  Y.saved = 0; Y.error = '';
  try { Y.saved = await importBooks(records); }
  catch (err) { Y.saved = err.saved || 0; Y.error = err.message || 'Something went wrong while saving.'; }
  await hooks.refresh();
  stepYtDone();
}

function stepYtDone() {
  const n = Y.saved;
  show(Y.error ? 'Import stopped' : 'Import finished', `
    <div class="imp-center">
      <div class="imp-big">${Y.error ? '!' : '\u2713'}</div>
      <h3 style="margin:0 0 4px">${n} ${n === 1 ? 'audiobook' : 'audiobooks'} imported</h3>
      ${Y.error ? `<p class="err" role="alert">${esc(Y.error)} ${n ? 'The books before this point were saved.' : ''}</p>` : ''}
    </div>
    <div class="imp-stats">
      <div class="imp-stat"><span>Total listening time</span><b>${esc(fmtDuration(Y.seconds))}</b></div>
      <div class="imp-stat"><span>Covers</span><b>The video thumbnails</b></div>
      ${Y.noAuthor ? `<div class="imp-stat"><span>Author still to add</span><b>${Y.noAuthor}</b></div>` : ''}
    </div>
    ${Y.noAuthor ? '<p class="hint">Those show the author as &ldquo;Unknown&rdquo;. Type <b>Unknown</b> in the search box to find them and fill in the author.</p>' : ''}`,
    '<button class="btn" type="button" id="yt-more">Import another playlist</button><button class="btn primary" type="button" id="imp-done">Done</button>');
  $('imp-done').addEventListener('click', () => { dlg().close(); if (n) hooks.toast(`${n} ${n === 1 ? 'audiobook' : 'audiobooks'} imported`); });
  $('yt-more').addEventListener('click', () => stepPlaylist());
}

// ---------- start ----------
function openImport() {
  S = { rows: [], picked: [], opts: { owner: 'smart', covers: true, shelves: true, reviews: false }, ctl: null, saved: 0, error: '', cancelled: false };
  stepSource();
  if (!dlg().open) dlg().showModal();
}

export function initImport(h) {
  hooks = h;
  $('import-btn').addEventListener('click', openImport);
  $('imp-close').addEventListener('click', () => dlg().close());
  // Closing the dialog (X, Escape or Done) stops a cover search that is still running.
  dlg().addEventListener('close', () => { if (S) { S.cancelled = true; if (S.ctl) S.ctl.stop = true; } });
}
