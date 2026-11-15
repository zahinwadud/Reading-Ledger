// Public site: home rows, shelf pages, book detail, live search.
import { configured, fetchShelf, fetchSettings, readShelfCache, writeShelfCache, coverOf, ytThumb, esc, norm, authorsOf, initTheme, STATUS, OWN } from './core.js';

const app = document.getElementById('app');
const qEl = document.getElementById('q');
initTheme(document.getElementById('theme'));

let books = [];
let state = configured ? 'loading' : 'setup'; // loading | ready | error | setup
let filters = { lang: '', own: '', fmt: '', copies: '', type: '' };   // read from the address each time a page is drawn
let sortKey = '';                                            // ditto ("?sort=title")
let settings = null;     // shared settings from the database (null = that table is not set up, or not loaded yet)
try { settings = JSON.parse(localStorage.getItem('rl-settings') || 'null'); } catch (e) { /* storage blocked */ }
let offline = false;      // true while we are showing the saved copy because the fresh one could not load

// ---------- small icons (inline SVG so nothing extra is downloaded) ----------
const svg = (inner) =>
  `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const ICON = {
  check: svg('<path d="M3 8.5l3.2 3L13 4.5"/>'),
  bag: svg('<path d="M3 5.5h10l-.8 8H3.8z"/><path d="M5.5 5.5v-1a2.5 2.5 0 0 1 5 0v1"/>'),
  book: svg('<path d="M8 4.2C6.6 3.1 4.6 2.8 2.5 3.3V12c2.1-.5 4.1-.2 5.5 1"/><path d="M8 4.2c1.4-1.1 3.4-1.4 5.5-.9V12c-2.1-.5-4.1-.2-5.5 1"/><path d="M8 4.2V13"/>'),
  done: svg('<circle cx="8" cy="8" r="6"/><path d="M5.3 8.3l1.9 1.9 3.5-4"/>'),
  bookmark: svg('<path d="M4.5 2.5h7v11L8 10.7 4.5 13.5z"/>'),
  play: svg('<path d="M5 3v10l8-5z"/>'),
  filter: svg('<path d="M2.5 4h11M4.5 8h7M6.5 12h3"/>'),
  tick: svg('<path d="M3.5 8.5l3 3 6-6.5"/>'),
  edit: svg('<path d="M3 13l.7-3L11 2.7a1.4 1.4 0 0 1 2 0l.3.3a1.4 1.4 0 0 1 0 2L6 12.3z"/><path d="M9.8 3.9l2.3 2.3"/>'),
  left: svg('<path d="M10 3L5 8l5 5"/>'),
  right: svg('<path d="M6 3l5 5-5 5"/>'),
  hardcopy: svg('<path d="M4 2.5h7.5a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4z"/><path d="M4 2.5A1.5 1.5 0 0 0 2.5 4v8A1.5 1.5 0 0 0 4 13.5"/><path d="M6.5 5.5h4"/>'),
  ebook: svg('<rect x="3.5" y="1.8" width="9" height="12.4" rx="1.6"/><path d="M7 12h2"/>'),
  phones: svg('<path d="M2.5 10V8a5.5 5.5 0 0 1 11 0v2"/><rect x="2" y="9.5" width="3" height="4.5" rx="1.2"/><rect x="11" y="9.5" width="3" height="4.5" rx="1.2"/>'),
};

// Does this book carry the "comics" genre? Case-insensitive, and also matches Manga / Graphic novels
// if you'd like them grouped — change the regex to /^comics$/i to keep it strict.
const isComics = (b) => (b.genres || []).some((g) => /comic|manga|graphic novel/i.test(g));
// How many titles each row on the home page shows ("See all" opens the full shelf).
const HOME_ROW_LIMIT = 5;

// Normalize a genre string for URL slugs and matching. Both sides must use this.
const genreKey = (s) => String(s || '').toLowerCase().trim()
  .replace(/&/g, ' and ')          // keep "&" meaning: "Mystery & thriller" -> "mystery and thriller"
  .replace(/[^\w\u0980-\u09FF]+/g, '-')  // any run of non-word chars -> single hyphen
  .replace(/^-+|-+$/g, '');         // trim leading/trailing hyphens

// ---------- the address: page + options ----------
// "#/shelf/read?lang=Bengali&sort=title" -> parts ['shelf', 'read'] and options { lang, sort }.
// Filters, sorting and the search text all live in the address, so a refresh, a shared link and the
// Back button bring the same view back.
const safeDecode = (text) => { try { return decodeURIComponent(text); } catch (e) { return text; } };
function route() {
  const [path, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  return { path, parts: path.split('/').map(safeDecode), params: new URLSearchParams(query) };
}
// Change one option in the address without adding a step to the Back history.
function setOption(name, value) {
  const r = route();
  if (value) r.params.set(name, value); else r.params.delete(name);
  const query = r.params.toString();
  history.replaceState(history.state, '', `#/${r.path}${query ? '?' + query : ''}`);
  lastHash = location.hash;
}

// ---------- sorting ----------
// Titles and names are compared the way a reader expects in both Bengali and English ("Book 2" before "Book 10").
const collator = new Intl.Collator(['bn', 'en'], { numeric: true, sensitivity: 'base' });
const byTitle = (a, b) => collator.compare(a.title, b.title);
const byAdded = (a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''));
// Finished date, newest first; books with no date go last (newest added first among themselves).
const byFinished = (a, b) => (b.finished_at ? 1 : 0) - (a.finished_at ? 1 : 0)
  || String(b.finished_at || '').localeCompare(String(a.finished_at || '')) || byAdded(a, b);
const SORTS = {
  added: ['Recently added', byAdded],
  finished: ['Recently finished', byFinished],
  title: ['Title', byTitle],
  author: ['Author', (a, b) => collator.compare(a.author, b.author) || byTitle(a, b)],
  newest: ['Year, newest first', (a, b) => (b.pub_year || -Infinity) - (a.pub_year || -Infinity) || byTitle(a, b)],
  oldest: ['Year, oldest first', (a, b) => (a.pub_year || Infinity) - (b.pub_year || Infinity) || byTitle(a, b)],
};
// options = the sort keys this page offers; the first one is its default.
function sortList(list, options) {
  const key = options.includes(sortKey) ? sortKey : options[0];
  return list.sort(SORTS[key][1]);
}
function sortSelect(options) {
  const key = options.includes(sortKey) ? sortKey : options[0];
  return `<label class="sortbox"><span class="cg-l">Sort by</span><select data-sort data-default="${options[0]}">${
    options.map((k) => `<option value="${k}"${k === key ? ' selected' : ''}>${SORTS[k][0]}</option>`).join('')}</select></label>`;
}
const SORT_DEFAULT = ['added', 'title', 'author', 'newest', 'oldest'];
const SORT_READ = ['finished', 'added', 'title', 'author', 'newest', 'oldest'];
const SORT_AUTHOR = ['title', 'newest', 'oldest', 'added'];
SORTS.series = ['Series order', (a, b) => (a.series_no ?? Infinity) - (b.series_no ?? Infinity) || byTitle(a, b)];
const SORT_SERIES = ['series', 'title', 'newest', 'oldest'];
const seriesHref = (name) => `#/series/${encodeURIComponent(name)}`;
const inSeries = (name) => { const key = norm(name); return books.filter((b) => b.series && norm(b.series) === key); };
// Story arcs (comics): a named story that runs through some issues of one series, or of several.
SORTS.arc = ['Reading order', (a, b) => (a.arc_no ?? Infinity) - (b.arc_no ?? Infinity) || collator.compare(a.series || '', b.series || '') || SORTS.series[1](a, b)];
const SORT_ARC = ['arc', 'title', 'newest', 'oldest'];
const arcHref = (name) => `#/arc/${encodeURIComponent(name)}`;
const inArc = (name) => { const key = norm(name); return books.filter((b) => b.arc && norm(b.arc) === key); };
const hasBn = (text) => /[\u0980-\u09FF]/.test(text || '');

// Is the owner signed in on this device? (The dashboard leaves its sign-in in the browser's storage.)
// This only decides whether to show the "Edit" shortcut; the database still checks every change.
function ownerHere() {
  try { for (let i = 0; i < localStorage.length; i += 1) if (/^sb-.+-auth-token$/.test(localStorage.key(i))) return true; } catch (e) { /* storage blocked */ }
  return false;
}
const authorHref = (name) => `#/author/${encodeURIComponent(name)}`;
// Is this person one of the book's authors? (A book with two authors appears on both authors' pages.)
const wroteIt = (b, key) => authorsOf(b.author).some((a) => norm(a) === key);

// ---------- shelves ----------
// Reading-status shelves hold Books. Audiobooks have their own shelf. "All" shows everything.
const SHELVES = [
  { key: 'reading', label: 'Currently Reading', test: (b) => b.format === 'Book' && b.status === 'reading' },
  { key: 'read', label: 'Read', test: (b) => b.format === 'Book' && b.status === 'read' },
  { key: 'want', label: 'Want to Read', test: (b) => b.format === 'Book' && b.status === 'want' },
  { key: 'audio', label: 'Audiobooks', test: (b) => b.format === 'Audiobook' },
  { key: 'buy', label: 'Want to Buy', test: (b) => b.ownership === 'buy' },   // books and audiobooks
  { key: 'all', label: 'All titles', test: () => true },
];

// ---------- building blocks: cover first, then title, then author ----------
const lc = (b) => (b.language === 'Bengali' ? 'bn' : '');

// Books show an uploaded 2:3 cover. Audiobooks show the YouTube thumbnail in a 16:9 frame
// (or an uploaded image, cropped to widescreen, if there is no YouTube link).
// No picture for this title? Draw a cover from its title and author. The colour comes from the author's
// name, so one author's books share a colour family; the title shifts the shade a little.
function hash(text) {
  let h = 0;
  for (const ch of String(text || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}
// A small emblem on the drawn cover, chosen from the book's genres (the first rule that matches wins).
const MOTIFS = [
  [/comic|manga|graphic/i, '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/>'],
  [/mystery|thriller|detective|crime/i, '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2l3.3 3.3"/>'],
  [/science fiction|sci-fi/i, '<circle cx="8" cy="8" r="3.2"/><path d="M2 10.6c1.6 1.2 5.2.5 8.3-1.3 3-1.8 4.8-4.2 3.7-5.3"/>'],
  [/fantasy/i, '<path d="M8 2l1.4 4.600L14 8l-4.6 1.400L8 14l-1.4-4.600L2 8l4.6-1.400z"/>'],
  [/horror|ghost/i, '<path d="M3.5 13.500V7.500a4.5 4.5 0 0 1 9 0v6l-1.5-1.2-1.5 1.200L8 12.300l-1.5 1.200L5 12.300z"/><path d="M6.5 7.500h.01M9.5 7.500h.01"/>'],
  [/poetry|poem/i, '<path d="M13 2.500C8 3 4.5 6.5 3.5 13.500M13 2.500c0 4-2 7-6.5 7.500M3.5 13.500l2-3"/>'],
  [/histor/i, '<path d="M4 2.500h8M4 13.500h8M5 2.500c0 3 6 3.5 6 5.500s-6 2.5-6 5.500M11 2.500c0 3-6 3.5-6 5.500s6 2.5 6 5.5"/>'],
  [/biograph|memoir/i, '<circle cx="8" cy="5.5" r="2.7"/><path d="M3 13.500c.500-3 2.5-4.5 5-4.500s4.5 1.5 5 4.5"/>'],
  [/romance/i, '<path d="M8 13.200S2.5 9.8 2.5 6.200A2.8 2.8 0 0 1 8 5a2.8 2.8 0 0 1 5.5 1.200c0 3.6-5.5 7-5.5 7z"/>'],
  [/travel|adventure/i, '<circle cx="8" cy="8" r="5.5"/><path d="M10.3 5.700L9 9l-3.3 1.300L7 7z"/>'],
  [/children|humou?r/i, '<circle cx="8" cy="8" r="5.5"/><path d="M5.8 9.300c.600.9 1.3 1.3 2.2 1.300s1.6-.400 2.2-1.300M6.2 6.500h.01M9.8 6.500h.01"/>'],
  [/science|philosoph|psycholog/i, '<circle cx="8" cy="8" r="1.2"/><ellipse cx="8" cy="8" rx="6" ry="2.5"/><ellipse cx="8" cy="8" rx="6" ry="2.5" transform="rotate(60 8 8)"/><ellipse cx="8" cy="8" rx="6" ry="2.5" transform="rotate(120 8 8)"/>'],
];
function motif(b) {
  const genres = (b.genres || []).join(' | ');
  const hit = genres && MOTIFS.find(([test]) => test.test(genres));
  return hit ? `<span class="gc-m">${svg(hit[1])}</span>` : '';
}

function genCover(b) {
  const hue = (hash(norm(b.author)) % 360 + (hash(norm(b.title)) % 25) - 12 + 360) % 360;
  const shade = hash(norm(b.title)) % 3;
  return `<div class="gencover${b.format === 'Audiobook' ? ' wide' : ''}" data-s="${shade}" style="--h:${hue}" aria-hidden="true"><span class="gc-t ${lc(b)}">${esc(b.title)}</span><span class="gc-a ${lc(b)}">${esc(b.author)}</span>${motif(b)}</div>`;
}

function coverHtml(b, eager) {
  const audio = b.format === 'Audiobook';
  const yurl = audio ? ytThumb(b.youtube_url, eager ? 'maxresdefault' : 'hqdefault') : '';
  const url = yurl || coverOf(b);
  const fallback = yurl && eager ? ytThumb(b.youtube_url, 'hqdefault') : ''; // if maxres is missing
  const dims = audio ? 'width="320" height="180"' : 'width="200" height="300"';
  const img = url
    ? `<img src="${esc(url)}" ${fallback ? `data-fb="${esc(fallback)}"` : ''} alt="${audio ? 'Thumbnail' : 'Cover'} of ${esc(b.title)}" ${dims} ${eager ? '' : 'loading="lazy"'}>`
    : genCover(b);
  const play = yurl ? `<span class="play" aria-hidden="true">${ICON.play}</span>` : '';
  const hp = audio
    ? `<span class="hp" role="img" aria-label="Audiobook" title="Audiobook">${ICON.phones}</span>` : '';
  return `<div class="cover${audio ? ' wide' : ''}" data-b="${esc(b.id)}">${img}${play}${hp}</div>`;
}

// Reading status pill: Currently Reading / Read / Want to Read.
const STATUS_ICON = { reading: ICON.book, read: ICON.done, want: ICON.bookmark };
function statusBadge(b) {
  return `<span class="badge st-${esc(b.status)}">${STATUS_ICON[b.status] || ''}${esc(STATUS[b.status])}</span>`;
}

// Which copies I have of a book: Hardcopy, Ebook or both. Shown on the book page only.
const COPY = { hardcopy: 'Hardcopy', ebook: 'Ebook' };
function copyBadges(b) {
  return (b.format === 'Audiobook' ? [] : (b.copies || [])).filter((c) => COPY[c])
    .map((c) => `<span class="badge cp-${c}">${ICON[c]}${COPY[c]}</span>`).join('');
}

function badge(b) {
  const owned = b.ownership === 'owned';
  return `<span class="badge ${owned ? 'owned' : 'buy'}">${owned ? ICON.check : ICON.bag}${esc(OWN[b.ownership])}</span>`;
}

// Cards show cover, title and author only. The reading-status and ownership tags live on the book's
// detail page (and in the dashboard). Pass withTags = true to bring them back on cards.
function cardBase(b, withTags, extra = '', cls = '') {
  return `<a class="card${b.format === 'Audiobook' ? ' wide' : ''}${cls}" href="#/book/${esc(b.id)}">
    ${coverHtml(b)}
    ${withTags ? `<p class="cstat">${statusBadge(b)}</p>` : ''}
    <h3 class="ct ${lc(b)}">${esc(b.title)}</h3>
    <p class="ca ${lc(b)}">${esc(b.author)}</p>
    ${withTags ? badge(b) : ''}${extra}
  </a>`;
}
const card = (b) => cardBase(b, false);
const homeCard = (b) => cardBase(b, false);

// "Do we have it?" in plain words, for search results and the copies pages.
function haveLabel(b) {
  if (b.format === 'Audiobook') return ['audio', 'Audiobook'];
  const c = b.copies || [];
  if (c.includes('hardcopy')) return ['shelf', c.includes('ebook') ? 'On our shelf \u00b7 also ebook' : 'On our shelf'];
  if (c.includes('ebook')) return ['ebook', 'Ebook only'];
  return b.ownership === 'owned' ? ['owned', 'Owned'] : ['none', 'Not owned \u00b7 want to buy'];
}
const haveCard = (b) => { const [k, t] = haveLabel(b); return cardBase(b, false, `<p class="chave have-${k}">${t}</p>`); };
// In a series: the number on the cover, and a tick once it is read.
const seriesCard = (b) => cardBase(b, false,
  `${b.series_no != null ? `<span class="cno">#${esc(b.series_no)}</span>` : ''}${b.status === 'read' ? `<span class="ctick" role="img" aria-label="Read">${ICON.tick}</span>` : b.status === 'reading' ? '<span class="cnow">Reading</span>' : ''}`,
  ' numbered');

const stateBox = (html) => `<div class="wrap"><div class="state">${html}</div></div>`;
const notFound = () => stateBox('<p>We couldn\u2019t find that page.</p><a class="btn primary" href="#/">Back to the shelf</a>');

// ---------- grids are drawn a batch at a time ----------
// A shelf can hold thousands of titles. Drawing them all at once makes the page slow, so each grid
// starts with one batch and adds the next one as you scroll near its end (or press "Show more").
const BATCH = 60;
let grids = {};     // the full list behind each grid on the page being shown: { bk: {...}, au: {...} }
let shown = {};     // how many cards each grid shows so far (kept when only the data refreshes)

function gridBlock(key, list, wide, cardFn, heading = '') {
  grids[key] = { list, cardFn };
  const n = shown[key] = Math.min(list.length, Math.max(shown[key] || 0, BATCH));
  const more = n < list.length
    ? `<div class="more" data-more="${key}"><button class="btn" type="button">Show more <small>${n} of ${list.length}</small></button></div>` : '';
  return `${heading}<div class="grid${wide ? ' wide' : ''}" data-grid="${key}">${list.slice(0, n).map(cardFn).join('')}</div>${more}`;
}

// Books (portrait covers) and audiobooks (wide thumbnails) never share one grid.
// When a page has both, the audiobooks follow once every book is on screen.
function gridHtml(list, cardFn = card) {
  const bk = list.filter((b) => b.format !== 'Audiobook');
  const au = list.filter((b) => b.format === 'Audiobook');
  if (bk.length && au.length) {
    const audio = () => gridBlock('au', au, true, cardFn, `<h2 class="sec-h">Audiobooks <small>${au.length}</small></h2>`);
    const books = gridBlock('bk', bk, false, cardFn, `<h2 class="sec-h">Books <small>${bk.length}</small> <a class="sec-jump" href="#" data-jump="au">Audiobooks <small>${au.length}</small> \u2193</a></h2>`);
    grids.bk.then = audio;
    return books + (shown.bk >= bk.length ? audio() : '');
  }
  return gridBlock(au.length ? 'au' : 'bk', list, au.length > 0, cardFn);
}

// Add the next batch to a grid (all = every remaining card).
function showMore(key, all = false) {
  const g = grids[key];
  const grid = document.querySelector(`[data-grid="${key}"]`);
  const more = document.querySelector(`[data-more="${key}"]`);
  if (!g || !grid) return;
  const from = shown[key];
  const to = shown[key] = all ? g.list.length : Math.min(g.list.length, from + BATCH);
  grid.insertAdjacentHTML('beforeend', g.list.slice(from, to).map(g.cardFn).join(''));
  if (more) {
    if (to >= g.list.length) {
      more.remove();
      if (g.then) { grid.insertAdjacentHTML('afterend', g.then()); g.then = null; watchMore(); }
    } else {
      more.querySelector('small').textContent = `${to} of ${g.list.length}`;
      moreWatcher && moreWatcher.unobserve(more); moreWatcher && moreWatcher.observe(more);   // still in view? load again
    }
  }
}

const moreWatcher = 'IntersectionObserver' in window
  ? new IntersectionObserver((entries) => {
      entries.forEach((en) => { if (en.isIntersecting) showMore(en.target.dataset.more); });
    }, { rootMargin: '900px 0px' })
  : null;
function watchMore() {
  if (!moreWatcher) return;
  moreWatcher.disconnect();
  document.querySelectorAll('[data-more]').forEach((el) => moreWatcher.observe(el));
}

// ---------- hero: recently finished books in a coverflow ----------
let heroActive = 0;
let swipeX = null, swiped = false;

// Newest finished first. (Needs a "finished_at" date; falls back to the date the book was added.)
function heroItems() {
  const when = (b) => String(b.finished_at || b.created_at || '');
  return books.filter((b) => b.format === 'Book' && b.status === 'read')
    .sort((a, b) => when(b).localeCompare(when(a))).slice(0, 8);
}

// Position of card i relative to the centre card, wrapping around: ..., -2, -1, 0, 1, 2, ...
function heroOffset(i, n) {
  let off = (((i - heroActive) % n) + n) % n;
  if (off > n / 2) off -= n;
  return Math.abs(off) <= 2 ? off : 'far';
}

function heroHtml() {
  const head = '<h1>Reading Ledger</h1><p class="sub">A personal collection of my books</p>';
  const items = heroItems();
  const n = items.length;
  if (!n) return `<section class="hero">${head}<p class="empty">Books you finish will appear here.</p></section>`;
  if (heroActive >= n) heroActive = 0;
  const cur = items[heroActive];
  const cards = items.map((b, i) => {
    const url = coverOf(b);
    const o = heroOffset(i, n);
    return `<a class="cf-card" href="#/book/${esc(b.id)}" data-b="${esc(b.id)}" data-i="${i}" data-o="${o}" ${o === 0 ? '' : 'tabindex="-1"'} aria-label="${esc(b.title)}, ${esc(b.author)}">${
      url ? `<img src="${esc(url)}" alt="" width="230" height="345" draggable="false">` : genCover(b)}</a>`;
  }).join('');
  const buttons = n > 1
    ? `<div class="cf-btns"><button class="cf-btn" type="button" data-cf="prev" aria-label="Previous book">${ICON.left}</button><button class="cf-btn next" type="button" data-cf="next" aria-label="Next book">${ICON.right}</button></div>` : '';
  return `<section class="hero" aria-label="Recently finished books">
    ${head}
    <div class="cf-cap" aria-live="polite"><small>Recently finished</small><h2 id="cf-title" class="${lc(cur)}">${esc(cur.title)}</h2><p id="cf-author" class="${lc(cur)}">${esc(cur.author)}</p></div>
    <div class="cf" id="cf" tabindex="0" role="group" aria-roledescription="carousel" aria-label="Recently finished books. Use the left and right arrow keys.">${cards}</div>
    ${buttons}
  </section>`;
}

// Move the cards (CSS animates the change) and update the caption above the centre card.
function placeHero() {
  const items = heroItems();
  const n = items.length;
  if (!n) return;
  document.querySelectorAll('.cf-card').forEach((el, i) => {
    const o = heroOffset(i, n);
    el.dataset.o = o;
    if (o === 0) el.removeAttribute('tabindex'); else el.tabIndex = -1;
  });
  const cur = items[heroActive];
  const t = document.getElementById('cf-title'), a = document.getElementById('cf-author');
  if (t && a) {
    t.textContent = cur.title; a.textContent = cur.author;
    t.className = a.className = lc(cur);
  }
}

function heroMove(step) {
  const n = heroItems().length;
  if (!n) return;
  heroActive = (heroActive + step + n) % n;
  placeHero();
}
// Stats design
// function statsHtml() {
//   const count = (key) => books.filter(SHELVES.find((s) => s.key === key).test).length;
//   const copies = (kind) => books.filter((b) => (b.copies || []).includes(kind)).length;
//   const items = [
//     ['Total in shelf', books.length, '#/all'],
//     ['Currently reading', count('reading'), '#/shelf/reading'],
//     ['Read', count('read'), '#/shelf/read'],
//     ['Want to read', count('want'), '#/shelf/want'],
//     ['Audiobooks', count('audio'), '#/shelf/audio'],
//     ['Hardcopy', copies('hardcopy'), '#/copies/hardcopy'],
//     ['Ebook', copies('ebook'), '#/copies/ebook'],
//     ['Comics', books.filter(isComics).length, '#/genre/comics'],
//     ['Want to buy', count('buy'), '#/shelf/buy'],
//   ];
//   return `<section class="pstats" aria-label="Library statistics">${
//     items.map(([label, n, href]) => `<a class="pstat" href="${href}"><b>${n}</b><span>${label}</span></a>`).join('')}</section>`;
// }
// a scrollable row of tiny covers
function statsHtml() {
  const c = (f) => books.filter(f).length;
  // The shelf tiles use the same rules as the shelves they open, so the numbers always agree.
  // (Reading / Read / Want to read count books; audiobooks have their own tile.)
  const shelf = (key) => c(SHELVES.find((s) => s.key === key).test);

  const items = [
    ['Total in shelf', books.length, '#/all'],
    ['Currently reading', shelf('reading'), '#/shelf/reading'],
    ['Read', shelf('read'), '#/shelf/read'],
    ['Want to read', shelf('want'), '#/shelf/want'],
    ['Audiobooks', shelf('audio'), '#/shelf/audio'],
    ['Hardcopy', c(b => (b.copies || []).includes('hardcopy')), '#/copies/hardcopy'],
    ['Ebook', c(b => (b.copies || []).includes('ebook')), '#/copies/ebook'],
    ['Comics', c(isComics), '#/comics'],
    ['Want to buy', shelf('buy'), '#/shelf/buy'],
  ];

  return `<section class="pstats" aria-label="Library statistics">
    ${items.map(([label, n, href]) => `
      <a class="pstat-folder" href="${href}">
        <span class="pf-tab" aria-hidden="true"></span>
        <span class="pf-content">
          <span class="pf-label">${label}</span>
          <b class="pf-num">${n}</b>
        </span>
      </a>
    `).join('')}
  </section>`;
}


// ---------- pages ----------
function homePage() {
  const rows = SHELVES.filter((s) => s.key !== 'all').map((s) => {
    const all = books.filter(s.test);
    
    // --- SORT READ SHELF BLOCK DESCENDING ---
    if (s.key === 'read') {
      all.sort((a, b) => {
        // 1. Check if they have a finish date (1 = has date, 0 = no date)
        const hasA = a.finished_at ? 1 : 0;
        const hasB = b.finished_at ? 1 : 0;

        // 2. Push books without a finish date to the bottom
        if (hasA !== hasB) {
          return hasB - hasA; 
        }

        // 3. If both have a finish date, sort newest first
        if (hasA === 1 && hasB === 1) {
          return new Date(b.finished_at) - new Date(a.finished_at);
        }

        // 4. If neither has a finish date, fallback to newest added first
        return new Date(b.created_at || 0) - new Date(a.created_at || 0);
      });
    }
    // --- FOR AUDIOBOOKS BLOCK ---
    else if (s.key === 'audio') {
      all.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    }
    // ----------------------

    const list = all.slice(0, HOME_ROW_LIMIT);
    return `<section class="shelf-row" aria-label="${esc(s.label)}">
      <div class="row-head"><h2>${s.label}</h2><a href="#/shelf/${s.key}">See all (${all.length})</a></div>
      ${list.length ? `<div class="row">${list.map(homeCard).join('')}</div>` : '<p class="empty">Nothing on this shelf yet.</p>'}
    </section>`;
  }).join('');
  
  // ... (the rest of your homePage function, like document.title = ... and the return statement)
  document.title = 'Reading Ledger';
  return heroHtml() + `<div class="wrap">${statsHtml()}${rows}</div>`;
}

// The filters every shelf-like page shares.
const FILTER_LABELS = {
  lang: ['Language', [['', 'All'], ['English', 'English'], ['Bengali', 'Bengali']]],
  own: ['Ownership', [['', 'All'], ['owned', 'Owned'], ['buy', 'Want to Buy']]],
  fmt: ['Format', [['', 'All'], ['Book', 'Books'], ['Audiobook', 'Audiobooks']]],
  copies: ['Copies', [['', 'All'], ['hardcopy', 'Hardcopy'], ['ebook', 'Ebook']]],
  type: ['Type', [['', 'All'], ['book', 'Books'], ['comic', 'Comics']]],
};
const passes = (b) =>
  (!filters.lang || b.language === filters.lang) &&
  (!filters.own || b.ownership === filters.own) &&
  (!filters.fmt || b.format === filters.fmt) &&
  (!filters.copies || (b.copies || []).includes(filters.copies)) &&
  (!filters.type || (filters.type === 'comic') === isComics(b));

// groups = which filters this page offers. On a phone they sit in a panel behind one "Filters" button
// (with the ones in use shown as small removable chips); on a wide screen they are all in view.
let filtersOpen = false;
function chips(groups, sorts, count) {
  const group = (id) => {
    const [label, opts] = FILTER_LABELS[id];
    return `<div class="chipgroup" role="group" aria-label="${label}"><span class="cg-l">${label}</span>${
      opts.map(([v, t]) => `<button type="button" class="chip" data-g="${id}" data-v="${v}" aria-pressed="${filters[id] === v}">${t}</button>`).join('')
    }</div>`;
  };
  const active = groups.filter((id) => filters[id]);
  const activeChips = active.map((id) => {
    const text = (FILTER_LABELS[id][1].find(([v]) => v === filters[id]) || [])[1] || filters[id];
    return `<button type="button" class="chip on" data-g="${id}" data-v="" aria-label="Remove filter: ${text}">${text} <span aria-hidden="true">\u00d7</span></button>`;
  }).join('');
  return `<div class="filters${filtersOpen ? ' open' : ''}">
    <button type="button" class="btn filt-btn" data-filt="open" aria-expanded="${filtersOpen}">${ICON.filter}Filters${active.length ? `<span class="filt-n">${active.length}</span>` : ''}</button>
    <div class="filt-sheet">
      <div class="filt-head"><b>Filters</b>${active.length ? '<button type="button" class="btn" data-filt="clear">Clear all</button>' : ''}</div>
      ${groups.map(group).join('')}
      <button type="button" class="btn primary filt-done" data-filt="close">Show ${count} ${count === 1 ? 'title' : 'titles'}</button>
    </div>
    ${sortSelect(sorts)}
    ${activeChips ? `<div class="filt-active">${activeChips}</div>` : ''}
  </div><div class="filt-backdrop" data-filt="close"></div>`;
}

// "Open the app on this page": remembered on this device only (handy for a phone that mostly checks one shelf).
function startSwitch() {
  let on = false;
  try { on = localStorage.getItem('rl-start') === location.hash; } catch (e) { /* storage blocked */ }
  return `<label class="startsw"><input type="checkbox" data-start${on ? ' checked' : ''}><span>Open the app on this page <small>(on this device)</small></span></label>`;
}

function shelfPage(key) {
  const shelf = SHELVES.find((s) => s.key === key);
  if (!shelf) return notFound();
  const list = books.filter(shelf.test).filter(passes);
  const sorts = key === 'read' ? SORT_READ : SORT_DEFAULT;
  sortList(list, sorts);
  const groups = ['lang', ...(key === 'buy' ? [] : ['own']), ...(key === 'all' || key === 'buy' ? ['fmt'] : []), 'copies', ...(key === 'audio' ? [] : ['type'])];

  const bar = SHELVES.map((s) =>
    `<a class="shelf-pill" href="${s.key === 'all' ? '#/all' : '#/shelf/' + s.key}" ${s.key === key ? 'aria-current="page"' : ''}>${s.label}<span class="n">${books.filter(s.test).length}</span></a>`
  ).join('');
  document.title = `${shelf.label} \u2013 Reading Ledger`;
  return `<nav class="shelfbar" aria-label="Shelves"><div class="shelfbar-in">${bar}</div></nav>
  <div class="wrap">
    <h1>${shelf.label}</h1>
    ${chips(groups, sorts, list.length)}
    ${list.length ? gridHtml(list, key === 'buy' ? haveCard : card) : '<p class="empty">No titles match these filters yet.</p>'}
    ${key === 'buy' ? startSwitch() : ''}
  </div>`;
}

// The copies we have: Hardcopy or Ebook. This is the page for "do we have it at home?".
function copiesPage(kind) {
  const LABELS = { hardcopy: 'Hardcopy books', ebook: 'Ebooks' };
  const label = LABELS[kind];
  if (!label) return notFound();
  const have = (k) => books.filter((b) => (b.copies || []).includes(k));
  const list = sortList(have(kind).filter(passes), SORT_DEFAULT);
  const pill = (href, text, n, on) => `<a class="shelf-pill" href="${href}" ${on ? 'aria-current="page"' : ''}>${text}<span class="n">${n}</span></a>`;
  document.title = `${label} \u2013 Reading Ledger`;
  return `<nav class="shelfbar" aria-label="Copies"><div class="shelfbar-in">
      ${pill('#/copies/hardcopy', 'Hardcopy', have('hardcopy').length, kind === 'hardcopy')}
      ${pill('#/copies/ebook', 'Ebook', have('ebook').length, kind === 'ebook')}
      ${pill('#/shelf/buy', 'Want to Buy', books.filter((b) => b.ownership === 'buy').length, false)}
    </div></nav>
  <div class="wrap">
    <h1>${label}</h1>
    ${chips(['lang', 'type'], SORT_DEFAULT, list.length)}
    ${list.length ? gridHtml(list) : '<p class="empty">No titles match these filters yet.</p>'}
    ${startSwitch()}
  </div>`;
}

// Human labels for the genre pages we link to. Anything not here falls back to the raw slug.
const GENRE_PAGES = { comics: 'Comics', manga: 'Manga', 'graphic-novels': 'Graphic novels' };

function genrePage(slug) {
  const list = slug === 'comics'
    ? books.filter(isComics)
    : books.filter((b) => (b.genres || []).some((g) => genreKey(g) === slug));
  // Prefer the human-written genre from a matching book; fall back to a title-cased slug.
  const found = list.flatMap((b) => b.genres || []).find((g) => genreKey(g) === slug);
  const label = GENRE_PAGES[slug] || found || slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  sortList(list, SORT_DEFAULT);
  document.title = `${label} \u2013 Reading Ledger`;
  return `<div class="wrap">
    <h1>${esc(label)}</h1>
    <p class="lede">${list.length} ${list.length === 1 ? 'title' : 'titles'}</p>
    <div class="filters">${sortSelect(SORT_DEFAULT)}</div>
    ${list.length ? gridHtml(list) : '<p class="empty">Nothing here yet.</p>'}
  </div>`;
}

// ---------- series and comics ----------
// What a series looks like as a whole: how far through it I am, and what comes next.
function seriesInfo(list, order = SORTS.series[1], name = '') {
  const ordered = list.slice().sort(order);
  const read = ordered.filter((b) => b.status === 'read').length;
  const reading = ordered.find((b) => b.status === 'reading');
  const started = read > 0 || Boolean(reading);
  // Next up: the one being read now, otherwise the first unread one after the last one read.
  const lastRead = ordered.map((b) => b.status).lastIndexOf('read');
  const next = reading || ordered.slice(lastRead + 1).find((b) => b.status !== 'read') || ordered.find((b) => b.status !== 'read') || null;
  return { name: name || ordered[0].series, list: ordered, total: ordered.length, read, started, done: read === ordered.length, next };
}
const arcInfo = (list) => seriesInfo(list, SORTS.arc[1], list[0].arc);
// "#608" inside its own series; "Batman #608" where issues of several series can meet (a story arc).
const issueLabel = (b) => (b.series && b.series_no != null ? `${b.series} #${b.series_no}` : b.title);
const progressBar = (read, total) => `<span class="pbar" role="img" aria-label="${read} of ${total} read"><i style="width:${total ? Math.round((read / total) * 100) : 0}%"></i></span>`;
const numberOf = (b) => (b.series_no != null ? `#${b.series_no}` : b.title);

// Every title in one series, in series order.
function seriesPage(name) {
  const all = inSeries(name);
  if (!all.length) return notFound();
  const info = seriesInfo(all);
  const list = sortList(all, SORT_SERIES);
  const label = info.name;
  const comics = all.some(isComics);
  setNav(comics ? 'comics' : 'books');
  document.title = `${label} – Reading Ledger`;
  const nextLine = info.done ? 'All read.' : info.next
    ? `${info.started ? 'Next' : 'Start with'}: <a href="#/book/${esc(info.next.id)}">${esc(numberOf(info.next))}</a>` : '';
  return `<div class="wrap">
    <p class="eyebrow">${comics ? 'Comics series' : 'Series'}</p>
    <h1 class="${/[ঀ-৿]/.test(label) ? 'bn' : ''}">${esc(label)}</h1>
    <div class="sprog">${progressBar(info.read, info.total)}<span><b>${info.read} of ${info.total}</b> read${nextLine ? ` · ${nextLine}` : ''}</span></div>
    <div class="filters">${sortSelect(SORT_SERIES)}</div>
    ${arcGroups(list) || gridHtml(list, seriesCard)}
  </div>`;
}

// A series in series order, split where the story arc changes: each run of issues gets a small heading
// with the arc's name and progress. Returns '' when the series has no arcs (or another sort is chosen).
function arcGroups(list) {
  const key = SORT_SERIES.includes(sortKey) ? sortKey : SORT_SERIES[0];
  if (key !== 'series' || !list.some((b) => b.arc)) return '';
  const runs = [];
  list.forEach((b) => {
    const arc = b.arc || '';
    const last = runs[runs.length - 1];
    if (last && norm(last.arc) === norm(arc)) last.list.push(b); else runs.push({ arc, list: [b] });
  });
  return runs.map((run, i) => {
    const nums = run.list.map((b) => b.series_no).filter((n) => n != null);
    const span = nums.length ? (nums[0] === nums[nums.length - 1] ? `#${nums[0]}` : `#${nums[0]} to #${nums[nums.length - 1]}`) : '';
    const read = run.list.filter((b) => b.status === 'read').length;
    const head = `<div class="arc-head"><h2>${run.arc ? `<a class="${hasBn(run.arc) ? 'bn' : ''}" href="${esc(arcHref(run.arc))}">${esc(run.arc)}</a>` : (runs.length > 1 ? 'Other issues' : 'Issues')}</h2>
      <span>${[span, `${read} of ${run.list.length} read`].filter(Boolean).join(' \u00b7 ')}</span>${progressBar(read, run.list.length)}</div>`;
    return gridBlock(`g${i}`, run.list, false, seriesCard, head);
  }).join('');
}

// One story arc, in reading order. Its issues can come from more than one series.
function arcPage(name) {
  const all = inArc(name);
  if (!all.length) return notFound();
  const info = arcInfo(all);
  const list = sortList(all, SORT_ARC);
  const label = info.name;
  const seriesNames = [...new Set(all.map((b) => b.series).filter(Boolean))];
  setNav('comics');
  document.title = `${label} \u2013 Reading Ledger`;
  const nextLine = info.done ? 'All read.' : info.next
    ? `${info.started ? 'Next' : 'Start with'}: <a href="#/book/${esc(info.next.id)}">${esc(issueLabel(info.next))}</a>` : '';
  return `<div class="wrap">
    <p class="eyebrow">Story arc${seriesNames.length ? ` \u00b7 in ${seriesNames.map((s) => `<a href="${esc(seriesHref(s))}">${esc(s)}</a>`).join(', ')}` : ''}</p>
    <h1 class="${hasBn(label) ? 'bn' : ''}">${esc(label)}</h1>
    <div class="sprog">${progressBar(info.read, info.total)}<span><b>${info.read} of ${info.total}</b> read${nextLine ? ` \u00b7 ${nextLine}` : ''}</span></div>
    <div class="filters">${sortSelect(SORT_ARC)}</div>
    ${gridHtml(list, seriesCard)}
  </div>`;
}

// The comics section: the same entries as on the shelves, arranged by series.
function comicsPage() {
  const comics = books.filter(isComics);
  document.title = 'Comics – Reading Ledger';
  if (!comics.length) return `<div class="wrap"><h1>Comics</h1><p class="empty">No comics yet. Give a title the genre “Comics”, “Manga” or “Graphic novels” in the dashboard and it appears here.</p></div>`;
  const groups = new Map();
  const singles = [];
  comics.forEach((b) => {
    if (!b.series) { singles.push(b); return; }
    const key = norm(b.series);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  });
  const all = [...groups.values()].map((list) => seriesInfo(list));
  const show = route().params.get('show') || '';
  const kept = all.filter((x) => (show === 'reading' ? x.started && !x.done : show === 'done' ? x.done : show === 'new' ? !x.started : true))
    .sort((a, b) => (b.started && !b.done ? 1 : 0) - (a.started && !a.done ? 1 : 0) || collator.compare(a.name, b.name));
  // Story arcs among the comics.
  const arcMap = new Map();
  comics.forEach((b) => { if (!b.arc) return; const key = norm(b.arc); if (!arcMap.has(key)) arcMap.set(key, []); arcMap.get(key).push(b); });
  const arcs = [...arcMap.values()].map(arcInfo).map((x) => ({ ...x, isArc: true }));
  // Continue reading: an arc that is under way stands for its series; a series shows only when its next issue is in no arc.
  const arcsNow = arcs.filter((x) => x.started && !x.done && x.next);
  const inProgress = [...arcsNow, ...all.filter((x) => x.started && !x.done && x.next && !x.next.arc)];
  const bnOf = (text) => (/[ঀ-৿]/.test(text) ? 'bn' : '');
  const stack = (x) => {
    // Up to three covers fanned out: the next issue on top.
    const top = x.next || x.list[0];
    const under = x.list.filter((b) => b !== top).slice(0, 2);
    return `<a class="stack" href="${esc(x.isArc ? arcHref(x.name) : seriesHref(x.name))}">
      <div class="stack-covers n${under.length + 1}">${under.reverse().map((b) => coverHtml(b)).join('')}${coverHtml(top)}</div>
      <h3 class="ct ${bnOf(x.name)}">${esc(x.name)}</h3>
      <p class="ca">${x.read} of ${x.total} read</p>
      ${progressBar(x.read, x.total)}
    </a>`;
  };
  const cont = inProgress.length ? `<section class="shelf-row" aria-label="Continue reading">
      <div class="row-head"><h2>Continue reading</h2></div>
      <div class="row">${inProgress.map((x) => `<a class="card" href="#/book/${esc(x.next.id)}">
        ${coverHtml(x.next)}
        <h3 class="ct ${bnOf(x.name)}">${esc(x.name)}</h3>
        <p class="ca">Next: ${esc(x.isArc ? issueLabel(x.next) : numberOf(x.next))} \u00b7 ${x.read} of ${x.total} read</p>
        ${progressBar(x.read, x.total)}
      </a>`).join('')}</div>
    </section>` : '';
  const chip = (v, t) => `<button type="button" class="chip" data-g="show" data-v="${v}" aria-pressed="${show === v}">${t}</button>`;
  const read = comics.filter((b) => b.status === 'read').length;
  return `<div class="wrap">
    <h1>Comics</h1>
    <p class="lede">${comics.length} ${comics.length === 1 ? 'issue' : 'issues and books'} · ${all.length} series${arcs.length ? ` \u00b7 ${arcs.length} ${arcs.length === 1 ? 'story arc' : 'story arcs'}` : ''} \u00b7 ${read} read</p>
    ${cont}
    ${arcs.length ? `<section class="shelf-row"><div class="row-head"><h2>Story arcs</h2></div>
      <div class="grid stacks">${arcs.slice().sort((a, b) => (b.started && !b.done ? 1 : 0) - (a.started && !a.done ? 1 : 0) || collator.compare(a.name, b.name)).map(stack).join('')}</div>
    </section>` : ''}
    ${all.length ? `<section class="shelf-row"><div class="row-head"><h2>Series</h2></div>
      <div class="filters"><div class="chipgroup" role="group" aria-label="Show">${chip('', 'All')}${chip('reading', 'In progress')}${chip('new', 'Not started')}${chip('done', 'Finished')}</div></div>
      ${kept.length ? `<div class="grid stacks">${kept.map(stack).join('')}</div>` : '<p class="empty">No series here.</p>'}
    </section>` : ''}
    ${singles.length ? `<section class="shelf-row"><div class="row-head"><h2>${all.length ? 'Single issues and one-offs' : 'All comics'}</h2></div>${gridHtml(sortList(singles, SORT_DEFAULT))}</section>` : ''}
    ${all.length ? '' : '<p class="hint">To group issues into series, give them a series name in the dashboard (Tools → Series can read it from the titles).</p>'}
  </div>`;
}

// ---------- stats ----------
// Books, comics and audiobooks are counted together everywhere; the charts only show the split.
const KINDS = [['book', 'Books'], ['comic', 'Comics'], ['audio', 'Audiobooks']];
const kindOf = (b) => (b.format === 'Audiobook' ? 'audio' : isComics(b) ? 'comic' : 'book');
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const num = (n) => Number(n).toLocaleString('en');
const emptyCount = () => ({ book: 0, comic: 0, audio: 0, total: 0 });
function tally(list) {
  const c = emptyCount();
  list.forEach((b) => { c[kindOf(b)] += 1; c.total += 1; });
  return c;
}
const splitText = (c) => KINDS.filter(([k]) => c[k]).map(([k, label]) => `${num(c[k])} ${c[k] === 1 ? label.slice(0, -1).toLowerCase() : label.toLowerCase()}`).join(', ');

// A stacked column chart: one column per label, one segment per kind.
// columns = [{ label, long, count: {book, comic, audio, total}, key?, on? }]
function columnChart(columns, title, fit = false) {
  const max = Math.max(1, ...columns.map((c) => c.count.total));
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((v) => max / v <= 4) || 1000;
  const top = Math.ceil(max / step) * step;
  const peak = columns.reduce((best, c) => (c.count.total > best.count.total ? c : best), columns[0]);
  const lines = [];
  for (let v = 0; v <= top; v += step) lines.push(`<span class="vz-line" style="bottom:${(v / top) * 100}%"><i>${num(v)}</i></span>`);
  const cols = columns.map((c) => {
    const segs = KINDS.filter(([k]) => c.count[k]).map(([k]) => `<i class="vz-seg k-${k}" style="height:${(c.count[k] / top) * 100}%"></i>`).join('');
    const tip = `${c.long}: ${num(c.count.total)} finished${c.count.total ? ` (${splitText(c.count)})` : ''}${c.more || ''}`;
    const label = (c.on || c === peak) && c.count.total ? `<b class="vz-val" style="bottom:${(c.count.total / top) * 100}%">${num(c.count.total)}</b>` : '';
    const inner = `${label}<span class="vz-stack">${segs}</span><span class="vz-x">${esc(c.label)}</span>`;
    return c.attr
      ? `<button type="button" class="vz-col${c.on ? ' on' : ''}" ${c.attr} data-tip="${esc(tip)}" aria-pressed="${Boolean(c.on)}" aria-label="${esc(tip)}">${inner}</button>`
      : `<div class="vz-col" data-tip="${esc(tip)}" tabindex="0" role="img" aria-label="${esc(tip)}">${inner}</div>`;
  }).join('');
  const used = KINDS.filter(([k]) => columns.some((c) => c.count[k]));
  const table = `<details class="vz-table"><summary>Show as a table</summary><table class="facts"><thead><tr><th scope="col">${esc(title)}</th>${used.map(([, l]) => `<th scope="col">${l}</th>`).join('')}<th scope="col">Total</th></tr></thead><tbody>${
    columns.map((c) => `<tr><th scope="row">${esc(c.long)}</th>${used.map(([k]) => `<td>${num(c.count[k])}</td>`).join('')}<td>${num(c.count.total)}</td></tr>`).join('')}</tbody></table></details>`;
  return `<div class="vz">
    <div class="vz-legend">${used.map(([k, l]) => `<span><i class="k-${k}"></i>${l}</span>`).join('')}</div>
    <div class="vz-scroll"><div class="vz-plot${fit ? ' fit' : ''}" style="--n:${columns.length}"><div class="vz-grid">${lines.join('')}</div><div class="vz-cols">${cols}</div></div></div>
    ${table}
  </div>`;
}

// One bar split into parts, each labelled directly: [[label, count, kind class], ...]
function shareBar(title, parts) {
  const total = parts.reduce((sum, [, n]) => sum + n, 0);
  if (!total) return '';
  const live = parts.filter(([, n]) => n);
  return `<div class="share"><h3>${title}</h3>
    <div class="share-bar">${live.filter(([, n]) => n / total >= 0.01).map(([label, n, k]) => `<i class="k-${k}" style="flex:${n}" data-tip="${esc(`${label}: ${num(n)} (${Math.round((n / total) * 100)}%)`)}"></i>`).join('')}</div>
    <ul class="share-key">${live.map(([label, n, k]) => `<li><i class="k-${k}"></i>${label} <b>${num(n)}</b> <span>${n / total < 0.01 ? 'under 1' : Math.round((n / total) * 100)}%</span></li>`).join('')}</ul>
  </div>`;
}

function goalCard(year, finished) {
  // With the "settings" table set up, the goal is shared by every device and is changed in the dashboard.
  // Without it, each device keeps its own goal.
  const shared = settings !== null;
  let goal = 0;
  if (shared) goal = Number(settings[`goal-${year}`]) || 0;
  else { try { goal = Number(localStorage.getItem(`rl-goal-${year}`)) || 0; } catch (e) { /* storage blocked */ } }
  if (shared) {
    const change = ownerHere() ? `<p class="goal-edit"><a href="admin.html#goal">${goal ? 'Change the goal' : 'Set a goal in the dashboard'}</a></p>` : '';
    if (!goal) return change ? `<section class="goal"><h2>${year} reading goal</h2><p class="lede">You have finished ${num(finished)} so far this year.</p>${change}</section>` : '';
    return goalMeter(year, finished, goal, change);
  }
  const form = (label) => `<form class="goal-form" data-goal="${year}"><label>${label} <input type="number" name="goal" min="1" max="2000" inputmode="numeric" value="${goal || ''}" placeholder="e.g. 60" required></label><button class="btn primary" type="submit">Save</button>${goal ? '<button class="btn" type="button" data-goal-clear>Remove goal</button>' : ''}</form>`;
  if (!goal) return `<section class="goal"><h2>${year} reading goal</h2><p class="lede">You have finished ${num(finished)} so far this year. Set a goal and this page tracks it.</p>${form('Titles to finish this year')}<p class="hint">The goal is saved on this device only.</p></section>`;
  return goalMeter(year, finished, goal, `<details class="goal-edit"><summary>Change the goal</summary>${form('Titles to finish this year')}<p class="hint">The goal is saved on this device only.</p></details>`);
}
function goalMeter(year, finished, goal, footer) {
  const now = new Date();
  const start = new Date(year, 0, 1), end = new Date(Number(year) + 1, 0, 1);
  const expected = Math.round(goal * Math.min(1, (now - start) / (end - start)));
  const diff = finished - expected;
  const pace = finished >= goal ? 'Goal reached.' : diff > 0 ? `${diff} ahead of pace.` : diff < 0 ? `${-diff} behind pace.` : 'Right on pace.';
  const pct = Math.min(100, Math.round((finished / goal) * 100));
  // what it takes from here, and where the year ends if the rest goes like the start
  const left = goal - finished, daysLeft = Math.max(1, Math.ceil((end - now) / 864e5)), part = (now - start) / (end - start);
  const rate = (n) => (n >= 10 ? num(Math.round(n)) : String(Math.round(n * 10) / 10));
  const needText = now >= end || now < start ? '' : daysLeft >= 14 ? `, about ${rate(left / (daysLeft / 7))} a week from here` : `, about ${rate(left / daysLeft)} a day from here`;
  const endText = part > 0.1 && part < 1 && finished ? ` At this year’s pace the year ends on about ${num(Math.round(finished / part))}.` : '';
  return `<section class="goal"><h2>${year} reading goal</h2>
    <p class="goal-n"><b>${num(finished)}</b> of ${num(goal)} titles <span>${pct}%</span></p>
    <div class="goal-bar" role="img" aria-label="${finished} of ${goal} finished"><i style="width:${pct}%"></i>${finished < goal ? `<u style="left:${Math.round((expected / goal) * 100)}%" title="Where you would be today at an even pace"></u>` : ''}</div>
    <p class="lede">${pace}${finished < goal ? ` ${num(goal - finished)} to go${needText}.${endText}` : ''}</p>
    ${footer}
  </section>`;
}

function statsPage() {
  document.title = 'Stats – Reading Ledger';
  const read = books.filter((b) => b.status === 'read');
  const dated = read.filter((b) => /^\d{4}-\d{2}/.test(b.finished_at || ''));
  if (!read.length) return `<div class="wrap"><h1>Stats</h1><p class="empty">Stats appear once some books are marked as read.</p></div>`;
  const thisYear = String(new Date().getFullYear());
  const byYear = new Map();
  dated.forEach((b) => { const y = b.finished_at.slice(0, 4); if (!byYear.has(y)) byYear.set(y, []); byYear.get(y).push(b); });
  const years = [...byYear.keys()].sort();
  const asked = route().params.get('year') || '';
  const year = byYear.has(asked) ? asked : byYear.has(thisYear) ? thisYear : years[years.length - 1] || thisYear;
  const inYear = byYear.get(year) || [];
  const count = tally(inYear);

  const params = route().params;
  const month = /^(0[1-9]|1[0-2])$/.test(params.get('month') || '') ? params.get('month') : '';
  const pick = ['book', 'comic'].includes(params.get('kind')) ? params.get('kind') : '';

  // Years: the last eight stand on their own; older ones share one column until asked for.
  // Inside that range every year is drawn, so a quiet year shows as a gap rather than vanishing.
  const first = Number(years[0] || thisYear);
  const cut = Number(thisYear) - 7;
  const fold = params.get('years') !== 'all' && first < cut - 1 && Number(year) >= cut;
  const yearCols = [];
  if (fold) {
    yearCols.push({ label: `to ’${String(cut - 1).slice(2)}`, long: `${first} to ${cut - 1}`, count: tally(dated.filter((b) => Number(b.finished_at.slice(0, 4)) < cut)),
      attr: 'data-statopt="years" data-val="all"', more: '. Pick it to show every year' });
  }
  for (let y = fold ? cut : first; y <= Number(thisYear); y += 1) {
    const key = String(y);
    yearCols.push({ label: `’${key.slice(2)}`, long: key, count: tally(byYear.get(key) || []), attr: byYear.has(key) ? `data-year="${key}"` : '', on: key === year });
  }
  const inMonth = (mm) => inYear.filter((b) => b.finished_at.slice(5, 7) === mm);
  const monthCols = MONTH_SHORT.map((m, i) => {
    const mm = String(i + 1).padStart(2, '0'), list = inMonth(mm);
    return { label: m, long: `${MONTHS[i]} ${year}`, count: tally(list), attr: list.length ? `data-month="${mm}"` : '', on: mm === month };
  });

  const withPages = inYear.filter((b) => b.pages);
  const pages = withPages.reduce((sum, b) => sum + b.pages, 0);
  const longest = withPages.slice().sort((a, b) => b.pages - a.pages)[0];
  const link = (b) => `<a class="${lc(b)}" href="#/book/${esc(b.id)}">${esc(b.title)}</a>`;
  const all = tally(read);
  const tile = (n, label, sub = '') => `<div class="stile"><b>${n}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const undated = read.length - dated.length;

  // the year before, for comparison: up to today's date when looking at the current year
  const now = new Date();
  const prev = String(Number(year) - 1);
  let against = '';
  if (byYear.has(prev)) {
    if (year === thisYear) {
      const today = `${prev}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      against = `${num(byYear.get(prev).filter((b) => b.finished_at.slice(0, 10) <= today).length)} by this date in ${prev}`;
    } else against = `${num(byYear.get(prev).length)} in ${prev}`;
  }
  // months so far (this year) or twelve (a past year), and the busiest month
  const monthsIn = year === thisYear ? Math.max(1 / 12, (now - new Date(now.getFullYear(), 0, 1)) / (new Date(now.getFullYear() + 1, 0, 1) - new Date(now.getFullYear(), 0, 1))) * 12 : 12;
  const perMonth = count.total / monthsIn;
  const busiest = monthCols.reduce((best, c) => (c.count.total > best.count.total ? c : best), monthCols[0]);
  const perYm = new Map();
  dated.forEach((b) => { const k = b.finished_at.slice(0, 7); perYm.set(k, (perYm.get(k) || 0) + 1); });
  const bestEver = [...perYm.entries()].sort((a, b) => b[1] - a[1])[0];

  // the row of covers: one month if a month is picked, otherwise the latest of the year; the same title is shown once
  const seen = new Set();
  const shown = (month ? inMonth(month) : inYear).slice().sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at)))
    .filter((b) => { const k = `${norm(b.title)}|${norm(b.author)}`; if (seen.has(k)) return false; seen.add(k); return true; });
  const recent = shown.slice(0, month ? 60 : 14);
  const rowTitle = month ? `Finished in ${MONTHS[Number(month) - 1]} ${year}` : `Finished in ${year}`;

  // rankings: everything, or only books, or only comics
  const pool = pick ? read.filter((b) => kindOf(b) === pick) : read;
  const top = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || collator.compare(a[0], b[0])).slice(0, 10);
  const bump = (map, k) => map.set(k, (map.get(k) || 0) + 1);
  const authors = new Map(), genres = new Map(), series = new Map();   // a book by two authors counts once for each of them
  pool.forEach((b) => {
    authorsOf(b.author).forEach((a) => bump(authors, a));
    (b.genres || []).forEach((g) => { if (g) bump(genres, g); });
    if (b.series) bump(series, b.series);
  });
  const rank = (title, entries, href) => {
    const max = entries.length ? entries[0][1] : 1;
    return `<div class="rank-col"><h3>${title}</h3>${entries.length
      ? `<ol class="rank">${entries.map(([name, n]) => `<li><a class="${/[ঀ-৿]/.test(name) ? 'bn' : ''}" href="${esc(href(name))}">${esc(name)}</a><b>${num(n)}</b><span class="rank-bar"><i style="width:${(n / max) * 100}%"></i></span></li>`).join('')}</ol>`
      : '<p class="hint">Nothing here yet.</p>'}</div>`;
  };
  const seg = [['', 'Everything'], ['book', 'Books'], ['comic', 'Comics']].map(([v, label]) => `<button type="button" data-statopt="kind" data-val="${v}" aria-pressed="${v === pick}">${label}</button>`).join('');

  const copies = { hard: 0, ebook: 0, both: 0, none: 0 };
  read.filter((b) => b.format === 'Book').forEach((b) => {
    const c = b.copies || [];
    copies[c.includes('hardcopy') && c.includes('ebook') ? 'both' : c.includes('hardcopy') ? 'hard' : c.includes('ebook') ? 'ebook' : 'none'] += 1;
  });
  const older = first < cut - 1;
  const undatedNote = undated ? `<p class="hint vz-note">${num(undated)} finished ${undated === 1 ? 'title has' : 'titles have'} no finish date, so ${undated === 1 ? 'it is' : 'they are'} not in these charts.${ownerHere() ? ' <a href="admin.html#missing=finished">Add the dates in the dashboard</a>' : ''}</p>` : '';

  return `<div class="wrap statpage">
    <h1>Stats</h1>
    ${goalCard(thisYear, (byYear.get(thisYear) || []).length)}
    <section class="stiles">
      ${tile(num(count.total), `Finished in ${year}`, `${splitText(count)}${against ? `. ${against}` : ''}`)}
      ${tile(perMonth >= 10 ? num(Math.round(perMonth)) : String(Math.round(perMonth * 10) / 10), `A month on average in ${year}`, busiest.count.total ? `Busiest: ${busiest.long.split(' ')[0]}, with ${num(busiest.count.total)}` : '')}
      ${tile(pages ? num(pages) : '–', `Pages in ${year}`, pages ? `Across the ${num(withPages.length)} of ${num(inYear.length)} with a page count${longest ? `. Longest: ${link(longest)} (${num(longest.pages)})` : ''}` : 'None of these have a page count yet')}
      ${tile(num(read.length), 'Finished, all time', `${splitText(all)}${bestEver ? `. Best month: ${MONTHS[Number(bestEver[0].slice(5)) - 1]} ${bestEver[0].slice(0, 4)}, with ${num(bestEver[1])}` : ''}`)}
    </section>
    <section class="vz-card"><h2>Finished each year</h2><p class="hint">Pick a year to see its months.</p>${columnChart(yearCols, 'Year', fold)}
      ${older ? `<p class="vz-more"><button type="button" data-statopt="years" data-val="${fold ? 'all' : ''}">${fold ? `Show every year since ${first}` : 'Show the last eight years only'}</button></p>` : ''}
      ${undatedNote}
    </section>
    <section class="vz-card"><h2>${year}, month by month</h2><p class="hint">Pick a month to see what was finished in it.</p>
      ${columnChart(monthCols, 'Month', true)}
    </section>
    ${recent.length ? `<section class="shelf-row" id="stat-row"><div class="row-head"><h2>${rowTitle}</h2>${month ? '<button type="button" data-month="">Show the whole year</button>' : '<a href="#/shelf/read">See the Read shelf</a>'}</div><div class="row">${recent.map(homeCard).join('')}</div>${shown.length > recent.length ? `<p class="hint">Showing the latest ${num(recent.length)} of ${num(shown.length)}.</p>` : ''}</section>` : ''}
    <section class="vz-card"><h2>Everything read so far</h2>
      ${shareBar('Kind', [['Books', all.book, 'book'], ['Comics', all.comic, 'comic'], ['Audiobooks', all.audio, 'audio']])}
      ${shareBar('Language', [['Bengali', read.filter((b) => b.language === 'Bengali').length, 's1'], ['English', read.filter((b) => b.language === 'English').length, 's2']])}
      ${shareBar('Copy of the books read', [['Hardcopy', copies.hard, 's1'], ['Ebook', copies.ebook, 's2'], ['Both', copies.both, 's3'], ['Not recorded', copies.none, 'none']])}
    </section>
    <section class="vz-card"><div class="rank-head"><h2>Most read</h2><div class="seg" role="group" aria-label="Count">${seg}</div></div>
      <div class="rank-cols">
        ${rank('Authors', top(authors), authorHref)}
        ${rank('Genres', top(genres), (g) => `#/genre/${genreKey(g)}`)}
        ${rank('Series', top(series), seriesHref)}
      </div>
    </section>
  </div>`;
}

// Every title by one author. The name in the address must match the author's name exactly
// (ignoring capitals and extra spaces).
function authorPage(name) {
  const key = norm(name);
  const list = sortList(books.filter((b) => wroteIt(b, key)), SORT_AUTHOR);
  if (!key || !list.length) return notFound();
  const label = authorsOf(list[0].author).find((a) => norm(a) === key) || name;
  document.title = `${label} \u2013 Reading Ledger`;
  return `<div class="wrap">
    <p class="eyebrow">Author</p>
    <h1 class="${/[\u0980-\u09FF]/.test(label) ? 'bn' : ''}">${esc(label)}</h1>
    <p class="lede">${list.length} ${list.length === 1 ? 'title' : 'titles'}</p>
    <div class="filters">${sortSelect(SORT_AUTHOR)}</div>
    ${gridHtml(list)}
  </div>`;
}

// "2024-03-11" -> "11 March 2024" (built by hand so time zones can never shift the day)
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function fmtDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
}

function detailPage(id) {
  const b = books.find((x) => String(x.id) === id);
  if (!b) return notFound();
  const audio = b.format === 'Audiobook';
  const size = audio ? b.duration : (b.pages ? `${b.pages} pages` : '');
  const meta = [size, b.pub_year, b.language].filter(Boolean).map(esc).join(' \u00b7 ');
  const link = audio && b.youtube_url && /^https?:\/\//i.test(b.youtube_url) ? b.youtube_url : '';
  const yt = link
    ? `<a class="btn primary block" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${ICON.play}Listen on YouTube</a>` : '';
  const facts = [
    ['Format', b.format],
    [audio ? 'Duration' : 'Pages', audio ? b.duration : b.pages],
    ['Published', b.pub_year],
    ['Language', b.language],
    ['Status', STATUS[b.status]],
    ...(b.status === 'read' ? [['Date finished', fmtDate(b.finished_at)]] : []),
    ['Ownership', OWN[b.ownership]],
    ...(audio ? [] : [['Copies', (b.copies || []).filter((c) => COPY[c]).map((c) => COPY[c]).join(' and ')]]),
  ].map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v || v === 0 ? esc(v) : '\u2014'}</td></tr>`).join('');
  const seriesNo = b.series_no != null ? ` #${esc(b.series_no)}` : '';
  const bnSeries = /[\u0980-\u09FF]/.test(b.series || '') ? 'bn' : '';
  const arcPart = b.arc ? `${b.series ? ' \u00b7 part of ' : 'Part of '}<a href="${esc(arcHref(b.arc))}">${esc(b.arc)}</a>` : '';
  const seriesLine = b.series || b.arc ? `<p class="series-line">${b.series ? `<a class="${bnSeries}" href="${esc(seriesHref(b.series))}">${esc(b.series)}</a>${seriesNo}` : ''}${arcPart}</p>` : '';
  // In a story arc, the row under the book follows the arc; otherwise it follows the series.
  const arcMates = b.arc ? inArc(b.arc).sort(SORTS.arc[1]) : [];
  const siblings = arcMates.length > 1 ? arcMates : b.series ? inSeries(b.series).sort(SORTS.series[1]) : [];
  const rowName = arcMates.length > 1 ? b.arc : b.series;
  const rowHref = arcMates.length > 1 ? arcHref(b.arc) : b.series ? seriesHref(b.series) : '';
  // Show the books around this one in the series (the one before it first).
  const at = Math.max(0, siblings.findIndex((x) => x.id === b.id) - 1);
  const nearby = siblings.slice(Math.min(at, Math.max(0, siblings.length - 12)), Math.min(at, Math.max(0, siblings.length - 12)) + 12).filter((x) => x.id !== b.id);
  const moreSeries = nearby.length ? `<section class="shelf-row more-by" aria-label="More in ${esc(rowName)}">
      <div class="row-head"><h2>More in <span class="${hasBn(rowName) ? 'bn' : ''}">${esc(rowName)}</span></h2><a href="${esc(rowHref)}">See all (${siblings.length})</a></div>
      <div class="row">${nearby.map(seriesCard).join('')}</div>
    </section>` : '';
  // One "More by ..." row per author (at most three), each with that author's other titles.
  const writers = authorsOf(b.author);
  const moreBy = writers.slice(0, 3).map((name) => {
    const others = books.filter((x) => x.id !== b.id && wroteIt(x, norm(name))).sort(byTitle);
    return others.length ? `<section class="shelf-row more-by" aria-label="More by ${esc(name)}">
      <div class="row-head"><h2>More by <span class="${hasBn(name) ? 'bn' : ''}">${esc(name)}</span></h2><a href="${esc(authorHref(name))}">See all (${others.length + 1})</a></div>
      <div class="row">${others.slice(0, 12).map(homeCard).join('')}</div>
    </section>` : '';
  }).join('');
  const edit = ownerHere() ? `<a class="btn editbtn" href="admin.html#edit=${esc(b.id)}">${ICON.edit}Edit</a>` : '';
  document.title = `${b.title} \u2013 Reading Ledger`;
  return `<div class="wrap">
    <div class="detail-top"><a class="backbtn" href="${esc(backHash)}" data-back>${ICON.left}Back to ${esc(backLabel)}</a>${edit}</div>
    <article class="detail${audio ? ' audio' : ''}">
      <div class="detail-side">
        ${link ? `<a class="ytlink" href="${esc(link)}" target="_blank" rel="noopener noreferrer" aria-label="Watch ${esc(b.title)} on YouTube">${coverHtml(b, true)}</a>` : coverHtml(b, true)}
        ${yt}
      </div>
      <div>
        <div class="dtags">${statusBadge(b)}${badge(b)}${copyBadges(b)}</div>
        <h1 class="${lc(b)}">${esc(b.title)}</h1>
        <p class="author ${lc(b)}">${writers.map((name) => `<a href="${esc(authorHref(name))}">${esc(name)}</a>`).join(', ') || esc(b.author)}</p>
        ${seriesLine}
        <p class="meta">${meta}</p>
        ${(b.genres || []).length ? `<ul class="genres" aria-label="Genres">${b.genres.map((g) => {
          const slug = genreKey(g);
          const bn = /[\u0980-\u09FF]/.test(g) ? ' bn' : '';
          return slug
            ? `<li class="gchip${bn}"><a href="#/genre/${esc(slug)}">${esc(g)}</a></li>`
            : `<li class="gchip${bn}">${esc(g)}</li>`;
        }).join('')}</ul>` : ''}
        ${b.description ? `<p class="desc ${lc(b)}">${esc(b.description)}</p>` : ''}
        <h2 class="h3">Book details</h2>
        <table class="facts"><tbody>${facts}</tbody></table>
      </div>
    </article>
    ${moreSeries}
    ${moreBy}
  </div>`;
}

// Search looks at the title, the author, the series and the genres. Every word you type must appear somewhere,
// in any order ("ray feluda" finds Feluda books by Satyajit Ray). Title matches come first.
const hayCache = new WeakMap();
function hay(b) {
  if (!hayCache.has(b)) hayCache.set(b, norm(`${b.title} ${b.author} ${b.series || ''} ${b.arc || ''} ${(b.genres || []).join(' ')}`));
  return hayCache.get(b);
}
function searchPage(text) {
  const q = norm(text);
  document.title = `Search \u2013 Reading Ledger`;
  if (!q) return `<div class="wrap"><h1>Search</h1><p class="empty">Type a title, an author or a genre.</p></div>`;
  const words = q.split(' ');
  const hits = books.filter((b) => words.every((w) => hay(b).includes(w)));
  const rank = (b) => (norm(b.title).includes(q) ? 0 : norm(b.author).includes(q) ? 1 : 2);
  hits.sort((a, b) => rank(a) - rank(b));               // the sort is stable: newest first within each group
  return `<div class="wrap"><h1>Search results</h1>
    <p class="lede">${hits.length} ${hits.length === 1 ? 'title matches' : 'titles match'} \u201c${esc(text.trim())}\u201d</p>
    ${hits.length ? gridHtml(hits, haveCard) : '<p class="empty">Nothing found. Try a different spelling or part of the name.</p>'}
  </div>`;
}

// ---------- "Back" button on the book page: returns to the page you came from ----------
let backHash = '#/all';
let backLabel = 'Books';
let lastHash = location.hash;
function rememberBack(from) {
  const [path] = String(from || '').replace(/^#\/?/, '').split('?');
  const [page, name] = path.split('/');
  if (page === 'book') return;                               // never go "back" to another book page
  backHash = from || '#/';
  backLabel = !page ? 'Home' : page === 'search' ? 'search results' : page === 'author' || page === 'series' || page === 'arc' ? safeDecode(name || '') || 'Books' : page === 'comics' ? 'Comics' : page === 'stats' ? 'Stats' : 'Books';
}

// ---------- router ----------
function setNav(active) {
  document.querySelectorAll('[data-nav]').forEach((a) => {
    if (a.dataset.nav === active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

function draw() {
  if (state === 'setup') { setNav(''); app.innerHTML = stateBox('<h1>Almost there</h1><p>Open <code>js/config.js</code> and paste your Supabase project URL and publishable key. The README explains how.</p>'); return; }
  if (state === 'loading') { app.innerHTML = stateBox('<p>Loading the shelf\u2026</p>'); return; }
  if (state === 'error') {
    app.innerHTML = stateBox('<h1>The shelf is out of reach</h1><p>We couldn\u2019t load the books. Check your connection, or your Supabase project may be paused.</p><button class="btn primary" type="button" data-retry>Try again</button>');
    return;
  }
  grids = {};
  const { parts, params } = route();
  const page = parts[0] || 'home';
  const opt = (name) => params.get(name) || '';
  filters = { lang: opt('lang'), own: opt('own'), fmt: opt('fmt'), copies: opt('copies'), type: opt('type') };
  sortKey = opt('sort');
  if (page === 'search') { setNav(''); app.innerHTML = searchPage(opt('q')); return; }
  if (page === 'book') { setNav('books'); app.innerHTML = detailPage(parts[1] || ''); return; }
  if (page === 'shelf') {
    setNav('books');
    app.innerHTML = shelfPage(parts[1]);
    return;
  }
  if (page === 'copies') {
    setNav('books');
    app.innerHTML = copiesPage(parts[1]);
    return;
  } 
  if (page === 'genre') {
    setNav('books');
    app.innerHTML = genrePage(parts[1] || '');
    return;
  }
  if (page === 'series') { setNav('books'); app.innerHTML = seriesPage(parts.slice(1).join('/')); return; }
  if (page === 'arc') { setNav('comics'); app.innerHTML = arcPage(parts.slice(1).join('/')); return; }
  if (page === 'comics') { setNav('comics'); app.innerHTML = comicsPage(); return; }
  if (page === 'stats') { setNav('stats'); app.innerHTML = statsPage(); return; }
  if (page === 'author') { setNav('books'); app.innerHTML = authorPage(parts.slice(1).join('/')); return; }
  if (page === 'all') { setNav('books'); app.innerHTML = shelfPage('all'); return; }
  if (page === 'home') { setNav('home'); app.innerHTML = homePage(); return; }
  setNav(''); app.innerHTML = notFound();
}

// Draw the page, then scroll the shelf bar so the current shelf is in view (matters on phones).
function render() {
  draw();
  watchMore();
  const note = document.getElementById('offline-note');
  if (offline && state === 'ready' && !note) {
    app.insertAdjacentHTML('beforebegin', '<p id="offline-note" class="offline-note" role="status">No connection. Showing the shelf as it was last saved on this device.</p>');
  } else if (!offline && note) note.remove();
  const bar = document.querySelector('.shelfbar-in');
  const cur = bar && bar.querySelector('[aria-current]');
  if (cur) bar.scrollLeft = cur.offsetLeft - (bar.clientWidth - cur.offsetWidth) / 2;
  // A chart wider than the screen opens on the picked year, not on the oldest one.
  for (const on of app.querySelectorAll('.vz-scroll .vz-col.on')) {
    const sc = on.closest('.vz-scroll');
    if (sc.scrollWidth > sc.clientWidth) sc.scrollLeft = on.offsetLeft + on.closest('.vz-plot').offsetLeft - (sc.clientWidth - on.offsetWidth) / 2;
  }
}

// Redraw the stats page after a choice, without the page or a sideways-scrolled chart jumping.
function redrawStats(focus, keepSideways) {
  const y = window.scrollY;
  const sideways = [...app.querySelectorAll('.vz-scroll')].map((el) => el.scrollLeft);
  render();
  window.scrollTo({ top: y, behavior: 'instant' });
  if (keepSideways) app.querySelectorAll('.vz-scroll').forEach((el, i) => { if (sideways[i] != null) el.scrollLeft = sideways[i]; });
  const again = focus && app.querySelector(focus);
  if (again) again.focus({ preventScroll: true });
}

// Show the saved copy of the shelf at once (if this browser has one), then fetch the current shelf
// and redraw only if something changed. With no connection, the saved copy stays on screen.
async function load() {
  if (!configured) { state = 'setup'; render(); return; }
  const saved = state === 'ready' ? books : readShelfCache();
  if (saved && saved.length) { books = saved; state = 'ready'; } else state = 'loading';
  render();
  try {
    const [fresh, freshSettings] = await Promise.all([fetchShelf(), fetchSettings().catch(() => settings)]);
    const settingsChanged = JSON.stringify(freshSettings) !== JSON.stringify(settings);
    settings = freshSettings;
    try { localStorage.setItem('rl-settings', JSON.stringify(settings)); } catch (e) { /* storage blocked */ }
    const changed = settingsChanged || state !== 'ready' || JSON.stringify(fresh) !== JSON.stringify(books);
    offline = false;
    if (changed) { books = fresh; state = 'ready'; writeShelfCache(fresh); }
    if (changed || document.getElementById('offline-note')) render();
  } catch (err) {
    console.error(err);
    if (state === 'ready') { offline = true; render(); } else { state = 'error'; render(); }
  }
}
window.addEventListener('online', () => { if (offline) load(); });

// ---------- events ----------
// Search icon: click to expand the field, Escape / icon again / click elsewhere (while empty) to close.
const topBar = document.querySelector('.top');
const setNavHeight = () => document.documentElement.style.setProperty('--nav-h', topBar.offsetHeight + 'px');
setNavHeight();
window.addEventListener('resize', setNavHeight);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(setNavHeight);
const sw = document.getElementById('sw');
const sBtn = document.getElementById('search-btn');
function collapseSearch() {
  sw.classList.remove('open'); topBar.classList.remove('searching'); sBtn.setAttribute('aria-expanded', 'false');
}
function openSearch() {
  sw.classList.add('open'); topBar.classList.add('searching'); sBtn.setAttribute('aria-expanded', 'true');
}
const onSearchPage = () => route().parts[0] === 'search';
// Leave the search page: step back to where the search started, or go home if it was opened from a link.
function leaveSearch() { if (visit && visit.pushed) history.back(); else location.hash = '#/'; }
function closeSearch() {
  qEl.value = ''; collapseSearch();
  if (onSearchPage()) leaveSearch();
}
sBtn.addEventListener('click', () => {
  if (sw.classList.contains('open')) { closeSearch(); return; }
  openSearch();
  qEl.focus();
});
qEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSearch(); sBtn.focus(); } });
document.addEventListener('pointerdown', (e) => {
  if (sw.classList.contains('open') && !qEl.value && !e.target.closest('#sw')) { collapseSearch(); if (onSearchPage()) leaveSearch(); }
});
// A shorter hint on phones, so it is not cut off in the narrow search box.
const phoneQuery = matchMedia('(max-width: 600px)');
const longHint = qEl.placeholder;
const setHint = () => { qEl.placeholder = phoneQuery.matches ? 'Search books' : longHint; };
setHint();
phoneQuery.addEventListener('change', setHint);

// Typing searches at once. The first letter opens the search page (one step in the Back history);
// the letters after it only update that page's address.
qEl.addEventListener('input', () => {
  const target = `#/search${qEl.value ? '?q=' + encodeURIComponent(qEl.value) : ''}`;
  if (onSearchPage()) {
    history.replaceState(history.state, '', target);
    lastHash = location.hash; shown = {};
    render();
    window.scrollTo({ top: 0, behavior: 'instant' });
  } else if (qEl.value) {
    const from = location.hash;
    history.pushState(null, '', target);
    enter(from);
    visit.pushed = true;
  }
});

// ---------- moving between pages ----------
// Each step in the browser's history gets a small record: how far it was scrolled and how many cards
// each grid had drawn. Coming back to a step (Back / Forward) restores both; a new step starts at the top.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
const visits = {};
let visit = null;
let visitSeq = 0;
function enter(from) {
  if (visit) visit.shown = { ...shown };                     // the page we are leaving
  filtersOpen = false; document.documentElement.classList.remove('sheet-open'); tipEl.hidden = true;
  let id = history.state && history.state.rl;
  const known = Boolean(id && visits[id]);
  if (!id) { id = `${Date.now()}-${visitSeq += 1}`; history.replaceState({ rl: id }, ''); }
  visit = visits[id] || (visits[id] = { y: 0, shown: {}, from: from || '#/' });
  shown = known ? { ...visit.shown } : {};
  rememberBack(from);
  lastHash = location.hash;
  if (onSearchPage()) {                                       // show the search text in the box (e.g. after Back or a shared link)
    const q = route().params.get('q') || '';
    if (document.activeElement !== qEl) qEl.value = q;
    openSearch();
  } else { qEl.value = ''; collapseSearch(); }
  const y = known ? visit.y : 0;
  render();
  window.scrollTo({ top: y, behavior: 'instant' });
}
window.addEventListener('scroll', () => { if (visit) visit.y = window.scrollY; }, { passive: true });
window.addEventListener('hashchange', () => enter(lastHash));

// The yearly goal on the Stats page (kept on this device).
app.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-goal]');
  if (!form) return;
  e.preventDefault();
  const goal = Math.round(Number(new FormData(form).get('goal')));
  if (!(goal > 0)) return;
  try { localStorage.setItem(`rl-goal-${form.dataset.goal}`, String(goal)); } catch (err) { /* storage blocked */ }
  render();
});

// A small label that follows the pointer (or keyboard focus) over a chart's bars.
const tipEl = document.createElement('div');
tipEl.className = 'vz-tip'; tipEl.hidden = true; tipEl.setAttribute('role', 'status');
document.body.appendChild(tipEl);
function showTip(el) {
  if (!el) { tipEl.hidden = true; return; }
  tipEl.textContent = el.dataset.tip;
  tipEl.hidden = false;
  const r = el.getBoundingClientRect();
  const w = tipEl.offsetWidth;
  tipEl.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
  tipEl.style.top = `${Math.max(8, r.top - tipEl.offsetHeight - 8) + window.scrollY}px`;
}
app.addEventListener('pointerover', (e) => showTip(e.target.closest('[data-tip]')));
app.addEventListener('pointerleave', () => showTip(null));
app.addEventListener('focusin', (e) => showTip(e.target.closest('[data-tip]')));
app.addEventListener('focusout', () => showTip(null));

// Redraw after a filter or sort change and put the keyboard focus back on the control that was used.
function redraw(focusSelector) {
  shown = {};
  render();
  const el = focusSelector && app.querySelector(focusSelector);
  if (el) el.focus({ preventScroll: true });
}
app.addEventListener('change', (e) => {
  const start = e.target.closest('[data-start]');
  if (start) {
    try { if (start.checked) localStorage.setItem('rl-start', location.hash); else localStorage.removeItem('rl-start'); } catch (err) { /* storage blocked */ }
    return;
  }
  const sel = e.target.closest('[data-sort]');
  if (!sel) return;
  setOption('sort', sel.value === sel.dataset.default ? '' : sel.value);
  redraw('[data-sort]');
});

function useFallback(e) {
  const img = e.target;
  // A cover link that no longer works: draw the title-and-author cover instead of a broken picture.
  if (e.type === 'error' && img.tagName === 'IMG' && !img.dataset.fb && img.closest('.cover, .cf-card')) {
    const holder = img.closest('[data-b]');
    const b = holder && books.find((x) => String(x.id) === holder.dataset.b);
    if (b) img.outerHTML = genCover(b);
    else { const box = document.createElement('div'); box.className = 'nocover'; box.textContent = 'No cover'; img.replaceWith(box); }
    return;
  }
  if (img.tagName === 'IMG' && img.dataset.fb && (e.type === 'error' || img.naturalWidth <= 120)) {
    img.src = img.dataset.fb; img.removeAttribute('data-fb');
  }
}
app.addEventListener('load', useFallback, true);
app.addEventListener('error', useFallback, true);
app.addEventListener('keydown', (e) => {
  if (!e.target.closest('.cf')) return;
  if (e.key === 'ArrowRight') { e.preventDefault(); heroMove(1); }
  if (e.key === 'ArrowLeft') { e.preventDefault(); heroMove(-1); }
});
app.addEventListener('pointerdown', (e) => { swipeX = e.target.closest('.cf') ? e.clientX : null; swiped = false; });
app.addEventListener('pointerup', (e) => {
  if (swipeX === null) return;
  const dx = e.clientX - swipeX; swipeX = null;
  if (Math.abs(dx) > 45) { swiped = true; heroMove(dx < 0 ? 1 : -1); setTimeout(() => { swiped = false; }, 60); }
});
app.addEventListener('click', (e) => {
  const step = e.target.closest('[data-cf]');
  if (step) { heroMove(step.dataset.cf === 'next' ? 1 : -1); return; }
  const card = e.target.closest('.cf-card');
  if (card) { // side card: bring to the centre. centre card: open the book page.
    if (swiped) { e.preventDefault(); return; }
    const i = Number(card.dataset.i);
    if (i !== heroActive) { e.preventDefault(); heroActive = i; placeHero(); }
    return;
  }
  const chip = e.target.closest('.chip');
  if (chip) {
    setOption(chip.dataset.g, chip.dataset.v);
    redraw(`.chip[data-g="${chip.dataset.g}"][data-v="${chip.dataset.v}"]`);
    return;
  }
  const filt = e.target.closest('[data-filt]');
  if (filt) {   // the phone's filter panel
    if (filt.dataset.filt === 'clear') { Object.keys(FILTER_LABELS).forEach((id) => setOption(id, '')); redraw('[data-filt="close"].filt-done'); return; }
    filtersOpen = filt.dataset.filt === 'open';
    document.documentElement.classList.toggle('sheet-open', filtersOpen);
    const box = app.querySelector('.filters');
    if (box) box.classList.toggle('open', filtersOpen);
    const btn = app.querySelector('.filt-btn');
    if (btn) { btn.setAttribute('aria-expanded', String(filtersOpen)); if (!filtersOpen) btn.focus(); }
    return;
  }
  const yearBtn = e.target.closest('[data-year]');
  if (yearBtn) { setOption('year', yearBtn.dataset.year); setOption('month', ''); redrawStats(`[data-year="${yearBtn.dataset.year}"]`, true); return; }
  const monthBtn = e.target.closest('[data-month]');
  if (monthBtn) { const mm = route().params.get('month') === monthBtn.dataset.month ? '' : monthBtn.dataset.month; setOption('month', mm); redrawStats(mm ? `.vz-col[data-month="${mm}"]` : '.vz-col[data-month]', true); return; }
  const optBtn = e.target.closest('[data-statopt]');
  if (optBtn) {
    // going back to the recent years while an older year is picked: let go of that year too
    if (optBtn.dataset.statopt === 'years' && !optBtn.dataset.val && Number(route().params.get('year')) < new Date().getFullYear() - 7) { setOption('year', ''); setOption('month', ''); }
    setOption(optBtn.dataset.statopt, optBtn.dataset.val); redrawStats(`[data-statopt="${optBtn.dataset.statopt}"]${optBtn.dataset.statopt === 'kind' ? `[data-val="${optBtn.dataset.val}"]` : ''}`, optBtn.dataset.statopt === 'kind'); return; }
  if (e.target.closest('[data-goal-clear]')) {
    const form = e.target.closest('[data-goal]');
    try { localStorage.removeItem(`rl-goal-${form.dataset.goal}`); } catch (err) { /* storage blocked */ }
    render(); return;
  }
  // "Back to ..." on a book page: if that page is the previous step in the history, really go back,
  // so it returns exactly as it was left (same filters, same place in the list).
  if (e.target.closest('[data-back]') && visit && visit.from === backHash && history.length > 1 && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
    e.preventDefault(); history.back(); return;
  }
  const more = e.target.closest('[data-more]');
  if (more) { showMore(more.dataset.more); return; }
  const jump = e.target.closest('[data-jump]');
  if (jump) {   // "Audiobooks ↓" on a mixed page: put every book on screen, then scroll to the audiobooks
    e.preventDefault();
    showMore('bk', true);
    const target = document.querySelector('[data-grid="au"]');
    if (target) target.previousElementSibling.scrollIntoView();
    return;
  }
  if (e.target.closest('[data-retry]')) load();
});

// A device can choose its opening page (the "Open the app on this page" switch). It applies only when
// the app is opened at its plain address; the Home link still shows the home page.
try {
  const startAt = localStorage.getItem('rl-start');
  if (startAt && /^#\/./.test(startAt) && (location.hash === '' || location.hash === '#' || location.hash === '#/')) history.replaceState(null, '', startAt);
} catch (e) { /* storage blocked */ }
enter(location.hash);
load();

// ---------- installable app ----------
// The service worker (sw.js) keeps a copy of the pages and covers you have seen, so the shelf opens
// without a connection and Android offers "Install app". It only runs on https (or localhost).
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker not registered:', err)); });
}
