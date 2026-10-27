// Dashboard: login, counts, book list, add/edit form with cover upload.
import {
  configured, fetchBooks, coverOf, ytId, ytThumb, saveBook, deleteBook, uploadCover, removeCover,
  signIn, signOut, getSession, onAuth, esc, norm, initTheme, STATUS, OWN,
} from './api.js';
import { initImport } from './import.js';

const $ = (id) => document.getElementById(id);

// Same ownership badge as the public site.
const svg = (inner) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICON = {
  check: svg('<path d="M3 8.5l3.2 3L13 4.5"/>'),
  book: svg('<path d="M8 4.2C6.6 3.1 4.6 2.8 2.5 3.3V12c2.1-.5 4.1-.2 5.5 1"/><path d="M8 4.2c1.4-1.1 3.4-1.4 5.5-.9V12c-2.1-.5-4.1-.2-5.5 1"/><path d="M8 4.2V13"/>'),
  done: svg('<circle cx="8" cy="8" r="6"/><path d="M5.3 8.3l1.9 1.9 3.5-4"/>'),
  bookmark: svg('<path d="M4.5 2.5h7v11L8 10.7 4.5 13.5z"/>'),
  phones: svg('<path d="M2.5 10V8a5.5 5.5 0 0 1 11 0v2"/><rect x="2" y="9.5" width="3" height="4.5" rx="1.2"/><rect x="11" y="9.5" width="3" height="4.5" rx="1.2"/>'),
  edit: svg('<path d="M3 13l.7-3L11 2.7a1.4 1.4 0 0 1 2 0l.3.3a1.4 1.4 0 0 1 0 2L6 12.3z"/><path d="M9.8 3.9l2.3 2.3"/>'),
  trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8h5.8l.6-8M7 7v3.5M9 7v3.5"/>'),
  hardcopy: svg('<path d="M4 2.5h7.5a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4z"/><path d="M4 2.5A1.5 1.5 0 0 0 2.5 4v8A1.5 1.5 0 0 0 4 13.5"/><path d="M6.5 5.5h4"/>'),
  ebook: svg('<rect x="3.5" y="1.8" width="9" height="12.4" rx="1.6"/><path d="M7 12h2"/>'),
  bag: svg('<path d="M3 5.5h10l-.8 8H3.8z"/><path d="M5.5 5.5v-1a2.5 2.5 0 0 1 5 0v1"/>'),
};
const statusBadge = (b) => `<span class="badge st-${esc(b.status)}">${{ reading: ICON.book, read: ICON.done, want: ICON.bookmark }[b.status] || ''}${esc(STATUS[b.status])}</span>`;
const badge = (b) => `<span class="badge ${b.ownership === 'owned' ? 'owned' : 'buy'}">${b.ownership === 'owned' ? ICON.check : ICON.bag}${esc(OWN[b.ownership])}</span>`;
initTheme($('theme'));

let books = [];
let editing = null;      // the book being edited, or null when adding
let newBlob = null;      // processed cover waiting to be uploaded
let removeFlag = false;  // true when the owner removed the existing cover
let previewUrl = '';
let shown = false;       // is the dashboard visible?

// ---------- small helpers ----------
function toast(message, bad) {
  const t = $('toast');
  t.textContent = message;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3500);
}

function setErr(id, message) {
  const el = $('e-' + id);
  if (el) el.textContent = message || '';
  const input = $('f-' + id);
  if (input) input.setAttribute('aria-invalid', message ? 'true' : 'false');
}

// Called for any failed request. Expired sessions go back to the login screen.
function handleErr(err) {
  const m = String((err && err.message) || err);
  if (/jwt|expired|not authenticated/i.test(m) || (err && err.status === 401)) {
    signOut().finally(() => showLogin('Your session expired. Please sign in again.'));
    return;
  }
  if (/row-level security|permission denied/i.test(m)) {
    toast('This account is not allowed to change books. Check the user ID inside schema.sql.', true);
    return;
  }
  toast('Something went wrong: ' + m, true);
}

// ---------- login / logout ----------
function showLogin(message) {
  shown = false;
  $('dash').hidden = true;
  $('login').hidden = false;
  $('login-msg').textContent = message || '';
}

async function showDash() {
  if (shown) return;
  shown = true;
  $('login').hidden = true;
  $('dash').hidden = false;
  await refresh();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!configured) { $('login-msg').textContent = 'Open js/config.js and add your Supabase URL and key first.'; return; }
  const btn = $('login-btn');
  btn.disabled = true;
  $('login-msg').textContent = '';
  try {
    await signIn($('email').value.trim(), $('password').value);
    $('password').value = '';
    await showDash();
  } catch (err) {
    $('login-msg').textContent = /invalid login/i.test(err.message)
      ? 'Wrong email or password.' : 'Could not sign in: ' + err.message;
  } finally { btn.disabled = false; }
});

$('logout').addEventListener('click', async () => { await signOut(); showLogin(); });

// ---------- list + counts ----------
async function refresh() {
  $('list-msg').textContent = 'Loading books\u2026';
  try { books = await fetchBooks(); renderAll(); }
  catch (err) { $('list-msg').textContent = ''; handleErr(err); }
}

function renderAll() { renderStats(); renderRows(); }

// [full label, short label for small phones, count]
function renderStats() {
  const c = (f) => books.filter(f).length;
  const items = [
    ['Total books', 'Total', books.length],
    ['Currently Reading', 'Reading', c((b) => b.status === 'reading')],
    ['Read', 'Read', c((b) => b.status === 'read')],
    ['Want to Read', 'To read', c((b) => b.status === 'want')],
    ['Audiobooks', 'Audio', c((b) => b.format === 'Audiobook')],
  ];
  $('stats').innerHTML = items.map(([full, short, n]) =>
    `<div class="stat"><b>${n}</b><span class="l-full">${full}</span><span class="l-short" aria-hidden="true">${short}</span></div>`).join('');
}

// A big library is shown 100 at a time (drawing thousands of rows would make phones slow).
const PAGE_SIZE = 100;
let listLimit = PAGE_SIZE;

function renderRows() {
  const q = norm($('s').value);
  const st = $('sf').value;
  const list = books.filter((b) =>
    (!st || (st === 'nocover' ? !coverOf(b) : b.status === st)) && (!q || norm(b.title).includes(q) || norm(b.author).includes(q)));
  const matches = list.length;
  list.length = Math.min(list.length, listLimit);     // draw only the first batch
  const actions = (b) => `
        <button class="btn" type="button" data-act="edit" data-id="${esc(b.id)}">${ICON.edit}Edit</button>
        <button class="btn danger" type="button" data-act="del" data-id="${esc(b.id)}">${ICON.trash}Delete</button>`;
  const info = (b) => {
    const audio = b.format === 'Audiobook';
    return {
      audio,
      bn: b.language === 'Bengali' ? 'bn' : '',
      url: (audio && ytThumb(b.youtube_url, 'mqdefault')) || coverOf(b),
    };
  };
  // Wide screens: a table.
  $('rows').innerHTML = list.map((b) => {
    const { audio, bn, url } = info(b);
    return `<tr>
      <td><div class="thumb${audio ? ' wide' : ''}">${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : ''}</div></td>
      <td class="${bn}">${esc(b.title)}</td>
      <td class="${bn}">${esc(b.author)}</td>
      <td>${esc(b.format)}</td>
      <td>${statusBadge(b)}</td>
      <td>${badge(b)}</td>
      <td class="acts">${actions(b)}
      </td></tr>`;
  }).join('');
  // Phones: one card per book (cover, title, author, tags, then big Edit / Delete buttons).
  $('cards').innerHTML = list.map((b) => {
    const { audio, bn, url } = info(b);
    return `<article class="bcard">
      <div class="bc-main">
        <div class="thumb${audio ? ' wide' : ''}">${url ? `<img src="${esc(url)}" alt="" loading="lazy">` : ''}</div>
        <div class="bc-info">
          <h3 class="bc-title ${bn}">${esc(b.title)}</h3>
          <p class="bc-author ${bn}">${esc(b.author)}</p>
          <div class="bc-tags">
            <span class="badge fmt">${audio ? ICON.phones : ICON.book}${esc(b.format)}</span>
            ${statusBadge(b)}
            ${badge(b)}
          </div>
        </div>
      </div>
      <div class="bc-actions">${actions(b)}
      </div>
    </article>`;
  }).join('');
  // "Showing 100 of 2,443" + a button for the next 100
  const more = matches - list.length;
  $('more-wrap').hidden = more <= 0;
  if (more > 0) {
    $('more-text').textContent = `Showing ${list.length.toLocaleString()} of ${matches.toLocaleString()}`;
    $('more-btn').textContent = `Show ${Math.min(PAGE_SIZE, more)} more`;
  }
  $('list-msg').textContent = list.length ? '' :
    (books.length ? 'No books match your search.' : 'No books yet. Use \u201cAdd book\u201d (the + button) to add your first one.');
}

$('s').addEventListener('input', () => { listLimit = PAGE_SIZE; renderRows(); });

// A shorter hint on phones, so it is not cut off in the narrow search box.
const phoneQuery = matchMedia('(max-width: 760px)');
const setHint = () => { $('s').placeholder = phoneQuery.matches ? 'Search books' : 'Search title or author \u00b7 \u09ac\u0987 \u09ac\u09be \u09b2\u09c7\u0996\u0995'; };
setHint();
phoneQuery.addEventListener('change', setHint);

// Phones: the search bar sticks to the top, but slides away while you scroll down (more room for the
// list) and returns as soon as you scroll up. It stays put while you are typing in it.
let lastY = window.scrollY;
window.addEventListener('scroll', () => {
  const bar = $('tools');
  const y = window.scrollY;
  if (!matchMedia('(max-width: 760px)').matches || document.activeElement === $('s')) { bar.classList.remove('away'); lastY = y; return; }
  if (y > lastY + 6 && y > 160) bar.classList.add('away');
  else if (y < lastY - 6) bar.classList.remove('away');
  lastY = y;
}, { passive: true });
$('sf').addEventListener('change', () => { listLimit = PAGE_SIZE; renderRows(); });
$('more-btn').addEventListener('click', () => { listLimit += PAGE_SIZE; renderRows(); });

async function onRowAction(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const book = books.find((b) => String(b.id) === btn.dataset.id);
  if (!book) return;
  if (btn.dataset.act === 'edit') { openPanel(book); return; }
  if (!confirm(`Delete \u201c${book.title}\u201d? This also removes its cover image.`)) return;
  btn.disabled = true;
  try { await deleteBook(book); toast('Book deleted'); await refresh(); }
  catch (err) { btn.disabled = false; handleErr(err); }
}
$('rows').addEventListener('click', onRowAction);
$('cards').addEventListener('click', onRowAction);

// ---------- copies I have: Hardcopy, Ebook or both (books only; shown on the book page only) ----------
const COPIES = [['hardcopy', 'Hardcopy'], ['ebook', 'Ebook']];
let haveCopies = [];
function renderCopies() {
  $('copy-picks').innerHTML = COPIES.map(([key, label]) =>
    `<button type="button" class="chip" data-copy="${key}" aria-pressed="${haveCopies.includes(key)}">${ICON[key]}${label}</button>`).join('');
}
$('copy-picks').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-copy]');
  if (!chip) return;
  const k = chip.dataset.copy;
  haveCopies = haveCopies.includes(k) ? haveCopies.filter((x) => x !== k) : [...haveCopies, k];
  renderCopies();
});

// ---------- genres (many per book; set in the form, shown only on the book page) ----------
const GENRES = ['Fiction', 'Non-fiction', 'Novel', 'Short stories', 'Poetry', 'Drama', 'Classic', 'Mystery & thriller',
  'Fantasy', 'Science fiction', 'Romance', 'Historical', 'Biography & memoir', 'History', 'Science', 'Philosophy',
  'Psychology', 'Self-help', 'Business', 'Religion', 'Travel', 'Children', 'Humor', 'Essays', 'Horror', 'Comics', 'Graphic novels', 'Manga'];
let picked = [];                                   // genres chosen for the book in the form
const sameGenre = (a, b) => a.toLowerCase() === b.toLowerCase();

// Choices = the common list + every genre already used on other books + anything typed in this form.
function renderGenres() {
  const all = [];
  [...GENRES, ...books.flatMap((b) => b.genres || []), ...picked].forEach((g) => { if (!all.some((x) => sameGenre(x, g))) all.push(g); });
  $('genre-picks').innerHTML = all.map((g) =>
    `<button type="button" class="chip${/[\u0980-\u09FF]/.test(g) ? ' bn' : ''}" data-genre="${esc(g)}" aria-pressed="${picked.some((p) => sameGenre(p, g))}">${esc(g)}</button>`).join('');
}
function addGenre(text) {
  const g = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!g) return;
  if (!picked.some((p) => sameGenre(p, g))) picked.push(g);
  $('f-genre-new').value = '';
  renderGenres();
}
$('genre-picks').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-genre]');
  if (!chip) return;
  const g = chip.dataset.genre;
  picked = picked.some((p) => sameGenre(p, g)) ? picked.filter((p) => !sameGenre(p, g)) : [...picked, g];
  renderGenres();
});
$('genre-add-btn').addEventListener('click', () => addGenre($('f-genre-new').value));
$('f-genre-new').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addGenre($('f-genre-new').value); } });

// ---------- add / edit panel ----------
const dlg = $('panel');
const FIELDS = ['title', 'author', 'year', 'language', 'format', 'pages', 'duration', 'status', 'ownership', 'youtube', 'description'];

function syncStatus() { $('g-finished').hidden = $('f-status').value !== 'read'; }
$('f-status').addEventListener('change', syncStatus);

function syncFormat() {
  const audio = $('f-format').value === 'Audiobook';
  $('g-pages').hidden = audio;
  $('g-copies').hidden = audio;                    // audiobooks have no hardcopy / ebook
  $('g-duration').hidden = !audio;
  $('g-youtube').hidden = !audio;
  $('cover-hint').hidden = !audio;
  updateYtPreview();
}

// Live thumbnail preview as soon as a valid YouTube link is typed or pasted.
function updateYtPreview() {
  const src = $('f-format').value === 'Audiobook' ? ytThumb($('f-youtube').value, 'mqdefault') : '';
  $('yt-prev').hidden = !src;
  if (src) $('yt-prev-img').src = src; else $('yt-prev-img').removeAttribute('src');
}
$('f-youtube').addEventListener('input', updateYtPreview);
$('f-format').addEventListener('change', syncFormat);

function setPreview(src) {
  if (previewUrl.startsWith('blob:')) URL.revokeObjectURL(previewUrl);
  previewUrl = src || '';
  $('preview').hidden = !src;
  $('remove-cover').hidden = !src;
  if (src) $('preview-img').src = src; else $('preview-img').removeAttribute('src');
  const touch = matchMedia('(pointer: coarse)').matches;
  $('drop-text').textContent = src
    ? (touch ? 'Tap to replace the cover' : 'Click or drop to replace the cover')
    : (touch ? 'Tap to choose a cover image (max 5 MB)' : 'Drag and drop an image here, or click to choose one (max 5 MB)');
}

function openPanel(book) {
  editing = book || null;
  newBlob = null; removeFlag = false;
  FIELDS.forEach((f) => setErr(f, ''));
  setErr('cover', '');
  $('panel-title').textContent = book ? 'Edit book' : 'Add book';
  const b = book || { language: 'English', format: 'Book', status: 'want', ownership: 'buy' };
  $('f-title').value = b.title || '';
  $('f-author').value = b.author || '';
  $('f-year').value = b.pub_year || '';
  $('f-language').value = b.language;
  $('f-format').value = b.format;
  $('f-pages').value = b.pages || '';
  $('f-duration').value = b.duration || '';
  $('f-status').value = b.status;
  $('f-ownership').value = b.ownership;
  $('f-finished').value = b.finished_at || '';
  syncStatus();
  haveCopies = [...(b.copies || [])];
  renderCopies();
  picked = [...(b.genres || [])];
  $('f-genre-new').value = '';
  renderGenres();
  $('f-youtube').value = b.youtube_url || '';
  $('f-description').value = b.description || '';
  syncFormat();
  setPreview(book ? coverOf(book) : '');
  dlg.showModal();
  $('dlg-body').scrollTop = 0;
  $('f-title').focus();
}

$('add').addEventListener('click', () => openPanel(null));
$('fab').addEventListener('click', () => openPanel(null));
$('close-x').addEventListener('click', () => dlg.close());
$('cancel').addEventListener('click', () => dlg.close());

// ----- cover: choose or drop, shrink to max 600px wide, compress -----
const drop = $('drop');
const fileInput = $('file');
drop.addEventListener('click', (e) => { if (!e.target.closest('#remove-cover')) fileInput.click(); });
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));

// -----
drop.addEventListener('drop', async (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  
  // 1. Check if a real file was dropped (from desktop)
  if (e.dataTransfer.files.length > 0) {
    handleFile(e.dataTransfer.files[0]);
    return;
  }
  
  // 2. Check if a link/URL was dropped (from another browser tab)
  const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (url && /^https?:\/\//i.test(url)) {
    await handleImageUrl(url);
  }
});
// -----

fileInput.addEventListener('change', () => { handleFile(fileInput.files[0]); fileInput.value = ''; });
$('remove-cover').addEventListener('click', () => { newBlob = null; removeFlag = true; setPreview(''); });

async function handleFile(file) {
  if (!file) return;
  setErr('cover', '');
  if (!file.type.startsWith('image/')) { setErr('cover', 'Please choose an image file (JPG, PNG or WebP).'); return; }
  if (file.size > 5 * 1024 * 1024) { setErr('cover', 'That image is larger than 5 MB. Please choose a smaller one.'); return; }
  try {
    newBlob = await processImage(file);
    removeFlag = false;
    setPreview(URL.createObjectURL(newBlob));
  } catch (err) {
    console.error(err);
    setErr('cover', 'Could not read that image. Try a different file.');
  }
}

async function handleImageUrl(url) {
  setErr('cover', '');
  const dropText = $('drop-text');
  const originalText = dropText.textContent;
  dropText.textContent = 'Fetching image from web…';
  
  try {
    // Fetch the image from the external URL
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch');
    const blob = await res.blob();
    
    if (!blob.type.startsWith('image/')) {
      throw new Error('That link is not an image.');
    }
    
    // Create a File object so we can reuse the existing handleFile logic
    const file = new File([blob], 'cover.jpg', { type: blob.type });
    
    // Reuse your existing image processing (resizing, webp conversion, preview)
    newBlob = await processImage(file);
    removeFlag = false;
    setPreview(URL.createObjectURL(newBlob));
    
  } catch (err) {
    console.error(err);
    setErr('cover', 'Could not load the image from that link. (The site might block external access).');
  } finally {
    dropText.textContent = originalText;
  }
}

drop.addEventListener('paste', async (e) => {
  const text = e.clipboardData.getData('text');
  if (text && /^https?:\/\//i.test(text)) {
    e.preventDefault();
    await handleImageUrl(text);
  }
});

async function processImage(file) {
  let img;
  try { img = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) {
    img = await new Promise((resolve, reject) => {
      const el = new Image();
      const u = URL.createObjectURL(file);
      el.onload = () => { URL.revokeObjectURL(u); resolve(el); };
      el.onerror = () => { URL.revokeObjectURL(u); reject(new Error('bad image')); };
      el.src = u;
    });
  }
  const w0 = img.naturalWidth || img.width;
  const h0 = img.naturalHeight || img.height;
  const scale = Math.min(1, 600 / w0);               // never enlarge
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w0 * scale);
  canvas.height = Math.round(h0 * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const toBlob = (type, q) => new Promise((r) => canvas.toBlob(r, type, q));
  let blob = await toBlob('image/webp', 0.85);
  if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg', 0.88); // older browsers
  if (!blob) throw new Error('could not compress');
  return blob;
}

// ----- validate + save -----
function validate() {
  let ok = true;
  const bad = (id, msg) => { setErr(id, msg); ok = false; };
  FIELDS.forEach((f) => setErr(f, ''));
  const audio = $('f-format').value === 'Audiobook';
  if (!$('f-title').value.trim()) bad('title', 'Please enter the title.');
  if (!$('f-author').value.trim()) bad('author', 'Please enter the author\u2019s name.');
  const year = $('f-year').value.trim();
  if (year && !/^\d{4}$/.test(year)) bad('year', 'Enter a 4-digit year, like 2018.');
  const pages = $('f-pages').value.trim();
  if (!audio && pages && !/^[1-9]\d*$/.test(pages)) bad('pages', 'Pages must be a whole number above 0.');
  const yt = $('f-youtube').value.trim();
  if (audio && yt) {
    if (!ytId(yt)) bad('youtube', 'Paste a YouTube video link, like https://www.youtube.com/watch?v=\u2026 or https://youtu.be/\u2026');
  }
  return ok;
}

function collect() {
  const audio = $('f-format').value === 'Audiobook';
  const val = (id) => $('f-' + id).value.trim();
  return {
    title: val('title'),
    author: val('author'),
    pub_year: val('year') ? Number(val('year')) : null,
    pages: !audio && val('pages') ? Number(val('pages')) : null,
    duration: audio && val('duration') ? val('duration') : null,
    language: $('f-language').value,
    format: $('f-format').value,
    status: $('f-status').value,
    ownership: $('f-ownership').value,
    copies: audio ? [] : haveCopies.slice(),
    genres: picked.slice(),
    youtube_url: audio && val('youtube') ? val('youtube') : null,
    description: val('description') || null,
    finished_at: $('f-status').value === 'read' && $('f-finished').value ? $('f-finished').value : null,
  };
}

$('book-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!validate()) return;
  addGenre($('f-genre-new').value);
  const saveBtn = $('save');
  saveBtn.disabled = true; saveBtn.textContent = 'Saving\u2026';
  let uploaded = null;
  try {
    const data = collect();
    const oldPath = editing ? editing.cover_path : null;
    if (newBlob) { uploaded = await uploadCover(newBlob); data.cover_path = uploaded; }
    else if (removeFlag) { data.cover_path = null; data.cover_url = null; }
    else data.cover_path = oldPath;
    await saveBook(data, editing ? editing.id : null);
    if (oldPath && (uploaded || removeFlag)) await removeCover(oldPath); // tidy the replaced file
    dlg.close();
    toast('Book saved');
    await refresh();
  } catch (err) {
    if (uploaded) removeCover(uploaded);  // do not leave an orphan file behind
    handleErr(err);
  } finally { saveBtn.disabled = false; saveBtn.textContent = 'Save book'; }
});

initImport({ getBooks: () => books, refresh, toast, statusBadge, badge });

// ---------- start ----------
(async function boot() {
  if (!configured) { showLogin('Open js/config.js and add your Supabase URL and key first.'); return; }
  const session = await getSession();
  if (session) await showDash(); else showLogin();
  onAuth((event, s) => { if (!s && shown) showLogin('You have been signed out.'); });
})();
