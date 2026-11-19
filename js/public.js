// Public site: home rows, shelf pages, book detail, live search.
import { configured, fetchShelf, fetchSettings, readShelfCache, writeShelfCache, coverOf, ytThumb, ytId, esc, norm, authorsOf, initTheme, STATUS, OWN, readsOf, readWhen, ordinal, readingNow } from './core.js';

const app = document.getElementById('app');
const qEl = document.getElementById('q');
initTheme(document.getElementById('theme'));
function markOwner() {
  const link = document.querySelector('.avatar-btn');
  if (!link || !ownerHere() || link.classList.contains('owner')) return;
  link.classList.add('owner');
  link.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg><span>Dashboard</span>';
}

let books = [];
let state = configured ? 'loading' : 'setup'; // loading | ready | error | setup
let filters = { lang: '', own: '', copies: '', kind: '' };   // read from the address each time a page is drawn
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
const HOME_ROW_LIMIT = 6;    // six per home row: all at once on a wide screen, swiped on a phone

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
// Currently Reading (added 18 November 2026): latest activity first, the same order as its row on the home page.
// Activity = the day progress was last updated, or else the day the read started; titles with neither follow, newest added first.
const activityOf = (b) => String(b.progress_on || b.started_at || '');
SORTS.updated = ['Recently updated', (a, b) => activityOf(b).localeCompare(activityOf(a)) || byAdded(a, b)];
const SORT_READING = ['updated', 'added', 'title', 'author', 'newest', 'oldest'];
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
  // { key: 'reading', label: 'Currently Reading', test: (b) => b.format === 'Book' && b.status === 'reading' },
  // A book being reread stays on Read (it has been read) and is also on Currently Reading.
  { key: 'reading', label: 'Currently Reading', test: (b) => b.format === 'Book' && readingNow(b) },
  { key: 'read', label: 'Read', test: (b) => b.format === 'Book' && b.status === 'read' },
  { key: 'want', label: 'Want to Read', test: (b) => b.format === 'Book' && b.status === 'want' },
  { key: 'audio', label: 'Audiobooks', test: (b) => b.format === 'Audiobook' },
  { key: 'buy', label: 'Want to Buy', test: (b) => b.ownership === 'buy' },   // books and audiobooks
  { key: 'all', label: 'All Titles', test: () => true },
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
const HEARD = { want: 'Want to Listen', reading: 'Listening', read: 'Listened' };
// const statusWord = (b) => (b.format === 'Audiobook' ? HEARD[b.status] : STATUS[b.status]) || '';
// A reread shows as "Rereading" ("Relistening" for an audiobook), with the same look as Currently Reading.
const rereadingNow = (b) => b.status === 'read' && !!b.rereading;
const statusWord = (b) => (rereadingNow(b) ? (b.format === 'Audiobook' ? 'Relistening' : 'Rereading')
  : (b.format === 'Audiobook' ? HEARD[b.status] : STATUS[b.status])) || '';
function statusBadge(b) {
  // return `<span class="badge st-${esc(b.status)}">${STATUS_ICON[b.status] || ''}${esc(statusWord(b))}</span>`;
  const st = rereadingNow(b) ? 'reading' : b.status;
  return `<span class="badge st-${esc(st)}">${STATUS_ICON[st] || ''}${esc(statusWord(b))}</span>`;
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
function cardBase(b, withTags, extra = '', cls = '', underCover = '') {
  return `<a class="card${b.format === 'Audiobook' ? ' wide' : ''}${cls}" href="#/book/${esc(b.id)}">
    ${coverHtml(b)}${underCover}
    ${withTags ? `<p class="cstat">${statusBadge(b)}</p>` : ''}
    <h3 class="ct ${lc(b)}">${esc(b.title)}</h3>
    <p class="ca ${lc(b)}">${esc(b.author)}</p>
    ${withTags ? badge(b) : ''}${extra}
  </a>`;
}
const card = (b) => cardBase(b, false);
const homeCard = (b) => cardBase(b, false);
// Currently Reading on the home page: a slim progress bar under the cover, once progress is recorded.
const progressCard = (b) => {
  const pct = pctOf(b);
  return pct == null ? homeCard(b)
    : cardBase(b, false, '', ' hasprog', `<span class="cprog">${pctBar(pct)}<small>${pct}%</small></span>`);
};

// Outside the Comics page, a comic series with several issues in one list is shown once, as a stack
// that opens the series; otherwise ten issues of one comic push everything else off the screen.
function stackSeries(list) {
  const groups = new Map();
  const keyOf = (b) => (b.format !== 'Audiobook' && isComics(b) && (b.series || b.arc) ? norm(b.series || `arc ${b.arc}`) : '');
  list.forEach((b) => { const k = keyOf(b); if (k) { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(b); } });
  const placed = new Set();
  return list.flatMap((b) => {
    const k = keyOf(b), g = k && groups.get(k);
    if (!g || g.length < 2) return [b];
    if (placed.has(k)) return [];
    placed.add(k);
    return [{ stack: g.slice().sort(g[0].series ? SORTS.series[1] : SORTS.arc[1]), name: g[0].series || g[0].arc, isArc: !g[0].series, format: 'Book', id: `series-${k}` }];
  });
}
function stackCard(x) {
  const top = x.stack[0], under = x.stack.slice(1, 3);
  return `<a class="card stack" href="${esc(x.isArc ? arcHref(x.name) : seriesHref(x.name))}">
    <div class="stack-covers n${under.length + 1}">${under.reverse().map((b) => coverHtml(b)).join('')}${coverHtml(top)}</div>
    <h3 class="ct ${/[\u0980-\u09ff]/.test(x.name) ? 'bn' : ''}">${esc(x.name)}</h3>
    <p class="ca">${num(x.stack.length)} issues</p>
  </a>`;
}
const orStack = (fn) => (x) => (x.stack ? stackCard(x) : fn(x));

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
    ? `<div class="more" data-more="${key}"><button class="btn" type="button">Show more <small>${num(n)} of ${num(list.length)}</small></button></div>` : '';
  return `${heading}<div class="grid${wide ? ' wide' : ''}" data-grid="${key}">${list.slice(0, n).map(cardFn).join('')}</div>${more}`;
}

// Books (portrait covers) and audiobooks (wide thumbnails) never share one grid.
// When a page has both, the audiobooks follow once every book is on screen.
function gridHtml(list, cardFn = card) {
  const bk = list.filter((b) => b.format !== 'Audiobook');
  const au = list.filter((b) => b.format === 'Audiobook');
  if (bk.length && au.length) {
    const audio = () => gridBlock('au', au, true, cardFn, `<h2 class="sec-h">Audiobooks <small>${num(au.length)}</small></h2>`);
    const books = gridBlock('bk', bk, false, cardFn, `<h2 class="sec-h">Books <small>${num(bk.length)}</small> <a class="sec-jump" href="#" data-jump="au">Audiobooks <small>${num(au.length)}</small> \u2193</a></h2>`);
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
      more.querySelector('small').textContent = `${num(to)} of ${num(g.list.length)}`;
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
  const items = heroItems();
  const n = items.length;
  if (!n) return '<section class="hero"><p class="empty">Books you finish will appear here.</p></section>';
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
// (A slimmer alternative to the folder tiles, kept in case it is wanted again; its styles are the ".ledger" rules.)
// // The library in figures: one ruled line, like a row in a ledger. Each figure opens its shelf,
// // and uses the same rule as that shelf, so the numbers always agree.
// function ledgerHtml() {
//   const c = (f) => books.filter(f).length;
//   const shelf = (key) => c(SHELVES.find((x) => x.key === key).test);
//   const items = [
//     ['titles', books.length, '#/all'],
//     ['reading', shelf('reading'), '#/shelf/reading'],
//     ['read', shelf('read'), '#/shelf/read'],
//     ['to read', shelf('want'), '#/shelf/want'],
//     ['audiobooks', shelf('audio'), '#/shelf/audio'],
//     ['comics', c(isComics), '#/comics'],
//     ['hardcopy', c((x) => (x.copies || []).includes('hardcopy')), '#/copies/hardcopy'],
//     ['ebook', c((x) => (x.copies || []).includes('ebook')), '#/copies/ebook'],
//     ['to buy', shelf('buy'), '#/shelf/buy'],
//   ];
//   return `<nav class="ledger" aria-label="The library in figures">${
//     items.map(([label, n, href]) => `<a href="${href}"><b>${Number(n).toLocaleString('en')}</b><span>${label}</span></a>`).join('')}</nav>`;
// }

// The folder tiles: the library in numbers. Each tile opens its shelf and uses the same rule as that shelf,
// so the numbers always agree.
function statsHtml() {
  const c = (f) => books.filter(f).length;
  const shelf = (key) => c(SHELVES.find((x) => x.key === key).test);
  const items = [
    ['Total in Shelf', books.length, '#/all'],
    ['Currently Reading', shelf('reading'), '#/shelf/reading'],
    ['Read', shelf('read'), '#/shelf/read'],
    ['Want to Read', shelf('want'), '#/shelf/want'],
    ['Audiobooks', shelf('audio'), '#/shelf/audio'],
    ['Hardcopy', c((x) => (x.copies || []).includes('hardcopy')), '#/copies/hardcopy'],
    ['Ebook', c((x) => (x.copies || []).includes('ebook')), '#/copies/ebook'],
    ['Comics', c(isComics), '#/comics'],
    ['Want to Buy', shelf('buy'), '#/shelf/buy'],
  ];
  return `<section class="pstats-sec" aria-labelledby="pstats-h"><div class="row-head"><h2 id="pstats-h"><span class="hi">${SI('bars')}</span>The Library in Numbers</h2><a href="#/stats">See the Stats${ICON.right}</a></div>
    <div class="pstats">${items.map(([label, n, href]) => `
      <a class="pstat-folder" href="${href}">
        <span class="pf-tab" aria-hidden="true"></span>
        <span class="pf-content">
          <span class="pf-label">${label}</span>
          <b class="pf-num">${num(n)}</b>
        </span>
      </a>`).join('')}</div>
  </section>`;
}

// The same icons as the badges on a book's page, so each one means one thing everywhere.
const HOME_ICON = { reading: ICON.book, read: ICON.done, want: ICON.bookmark, audio: ICON.phones, buy: ICON.bag };
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
    // --- CURRENTLY READING: latest activity first (progress updated, or the read started) ---
    else if (s.key === 'reading') {
      // const act = (b) => String(b.progress_on || b.started_at || '');
      // all.sort((a, b) => act(b).localeCompare(act(a)));       // the rest keep their order
      all.sort(SORTS.updated[1]);                               // the same order as the shelf page's default
    }
    // --- FOR AUDIOBOOKS BLOCK ---
    else if (s.key === 'audio') {
      all.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    }
    // ----------------------

    const list = (s.key === 'audio' ? all : stackSeries(all)).slice(0, HOME_ROW_LIMIT);
    return `<section class="shelf-row${s.key === 'reading' ? ' home-now' : ''}" aria-label="${esc(s.label)}">
      <div class="row-head"><h2><span class="hi">${HOME_ICON[s.key]}</span>${s.label}<small>${num(all.length)}</small></h2><a href="#/shelf/${s.key}" aria-label="See all ${num(all.length)} in ${esc(s.label)}">See all${ICON.right}</a></div>
      ${list.length ? `<div class="row fit${s.key === 'audio' ? ' wide' : ''}">${list.map(orStack(s.key === 'reading' ? progressCard : homeCard)).join('')}${all.length > list.length ? `<a class="card endcard" href="#/shelf/${s.key}"><b>${num(all.length)}</b><span>See all</span>${ICON.right}</a>` : ''}</div>` : '<p class="empty">Nothing on this shelf yet.</p>'}
    </section>`;
  });
  
  document.title = 'Reading Ledger';
  // The same order on every screen: title, carousel, shelves, then the numbers.
  return `<div class="home">
    <header class="hero-head"><h1>Reading Ledger</h1><p class="sub">A personal collection of my books</p></header>
    ${heroHtml()}
    <div class="wrap home-first">${rows[0]}</div>
    <div class="wrap home-rest">${rows.slice(1).join('')}${statsHtml()}</div>
  </div>`;
}

// The filters every shelf-like page shares.
const FILTER_LABELS = {
  lang: ['Language', [['', 'All'], ['English', 'English'], ['Bengali', 'Bengali']]],
  own: ['Ownership', [['', 'All'], ['owned', 'Owned'], ['buy', 'Want to Buy']]],
  copies: ['Copies', [['', 'All'], ['hardcopy', 'Hardcopy'], ['ebook', 'Ebook']]],
  kind: ['Kind', [['', 'All'], ['book', 'Books'], ['comic', 'Comics'], ['audio', 'Audiobooks']]],
};
// On a shelf that holds no audiobooks, "Kind" leaves that choice out.
const kindOptions = (withAudio) => FILTER_LABELS.kind[1].filter(([v]) => withAudio || v !== 'audio');
const passes = (b) =>
  (!filters.lang || b.language === filters.lang) &&
  (!filters.own || b.ownership === filters.own) &&
  (!filters.copies || (b.copies || []).includes(filters.copies)) &&
  (!filters.kind || kindOf(b) === filters.kind);

// groups = which filters this page offers. On a phone they sit in a panel behind one "Filters" button
// (with the ones in use shown as small removable chips); on a wide screen they are all in view.
let filtersOpen = false;
function chips(groups, sorts, count, withAudio = false) {
  const group = (id) => {
    const label = FILTER_LABELS[id][0];
    const opts = id === 'kind' ? kindOptions(withAudio) : FILTER_LABELS[id][1];
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
      <button type="button" class="btn primary filt-done" data-filt="close">Show ${num(count)} ${count === 1 ? 'title' : 'titles'}</button>
    </div>
    <div class="fbar">
      <span class="fbar-n">${num(count)} ${count === 1 ? 'title' : 'titles'}</span>
      ${groups.map((id) => { const label = FILTER_LABELS[id][0]; const opts = id === 'kind' ? kindOptions(withAudio) : FILTER_LABELS[id][1];
        return `<label class="fsel${filters[id] ? ' on' : ''}"><span>${label}</span><select data-fsel="${id}">${opts.map(([v, t]) => `<option value="${v}"${filters[id] === v ? ' selected' : ''}>${t}</option>`).join('')}</select></label>`; }).join('')}
      ${active.length ? '<button type="button" class="fbar-clear" data-filt="clear">Clear</button>' : ''}
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

// The tabs under "Books": every shelf, then the copies we have (Hardcopy, Ebook), which is the
// "do we have it at home?" view.
function booksTabs(current) {
  const TAB = { all: 'All', reading: 'Reading', read: 'Read', want: 'Want to Read', audio: 'Audiobooks', buy: 'Want to Buy' };
  const tab = (key, href, text, n) => `<a class="stab" href="${href}" ${key === current ? 'aria-current="page"' : ''}>${text}<span class="n">${num(n)}</span></a>`;
  const have = (k) => books.filter((b) => (b.copies || []).includes(k)).length;
  return [SHELVES.find((s) => s.key === 'all'), ...SHELVES.filter((s) => s.key !== 'all')]
    .map((s) => tab(s.key, s.key === 'all' ? '#/all' : `#/shelf/${s.key}`, TAB[s.key], books.filter(s.test).length)).join('')
    + tab('hardcopy', '#/copies/hardcopy', 'Hardcopy', have('hardcopy')) + tab('ebook', '#/copies/ebook', 'Ebook', have('ebook'));
}

function shelfPage(key) {
  const shelf = SHELVES.find((s) => s.key === key);
  if (!shelf) return notFound();
  const list = books.filter(shelf.test).filter(passes);
  // const sorts = key === 'read' ? SORT_READ : SORT_DEFAULT;
  const sorts = key === 'read' ? SORT_READ : key === 'reading' ? SORT_READING : SORT_DEFAULT;
  sortList(list, sorts);
  const groups = ['lang', ...(key === 'buy' ? [] : ['own']), 'copies', ...(key === 'audio' ? [] : ['kind'])];
  const shownList = filters.kind === 'comic' ? list : stackSeries(list);   // asking for comics shows every issue

  const bar = booksTabs(key);
  document.title = `${shelf.label} \u2013 Reading Ledger`;
  return `<div class="wrap">
    <h1>Books</h1>
    <nav class="stabs" aria-label="Shelves">${bar}</nav>
    ${chips(groups, sorts, list.length, key === 'all' || key === 'buy')}
${'' /* before 18 November 2026: orStack(key === 'buy' ? haveCard : card) */}
    ${list.length ? gridHtml(shownList, orStack(key === 'buy' ? haveCard : key === 'reading' ? progressCard : card)) : '<p class="empty">No titles match these filters yet.</p>'}
    ${key === 'buy' ? startSwitch() : ''}
  </div>`;
}

// The copies we have: Hardcopy or Ebook. This is the page for "do we have it at home?".
function copiesPage(kind) {
  const LABELS = { hardcopy: 'Hardcopy Books', ebook: 'Ebooks' };
  const label = LABELS[kind];
  if (!label) return notFound();
  const have = (k) => books.filter((b) => (b.copies || []).includes(k));
  const list = sortList(have(kind).filter(passes), SORT_DEFAULT);
  document.title = `${label} \u2013 Reading Ledger`;
  return `<div class="wrap">
    <h1>Books</h1>
    <nav class="stabs" aria-label="Shelves">${booksTabs(kind)}</nav>
    ${chips(['lang', 'kind'], SORT_DEFAULT, list.length)}
    ${list.length ? gridHtml(filters.kind === 'comic' ? list : stackSeries(list), orStack(card)) : '<p class="empty">No titles match these filters yet.</p>'}
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
    <p class="lede">${num(list.length)} ${list.length === 1 ? 'title' : 'titles'}</p>
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
// One title's progress, 0 to 100, while it is being read; null when none is recorded.
const pctOf = (b) => (readingNow(b) && b.progress != null && b.progress !== '' && !Number.isNaN(Number(b.progress))
  ? Math.max(0, Math.min(100, Math.round(Number(b.progress)))) : null);
const pctBar = (pct) => `<span class="pbar" role="img" aria-label="${pct}% done"><i style="width:${pct}%"></i></span>`;
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
    <div class="sprog">${progressBar(info.read, info.total)}<span><b>${num(info.read)} of ${num(info.total)}</b> read${nextLine ? ` · ${nextLine}` : ''}</span></div>
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
      <span>${[span, `${num(read)} of ${num(run.list.length)} read`].filter(Boolean).join(' \u00b7 ')}</span>${progressBar(read, run.list.length)}</div>`;
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
    <div class="sprog">${progressBar(info.read, info.total)}<span><b>${num(info.read)} of ${num(info.total)}</b> read${nextLine ? ` \u00b7 ${nextLine}` : ''}</span></div>
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
      <p class="ca">${num(x.read)} of ${num(x.total)} read</p>
      ${progressBar(x.read, x.total)}
    </a>`;
  };
  const cont = inProgress.length ? `<section class="shelf-row" aria-label="Continue Reading">
      <div class="row-head"><h2>Continue Reading</h2></div>
      <div class="row">${inProgress.map((x) => `<a class="card" href="#/book/${esc(x.next.id)}">
        ${coverHtml(x.next)}
        <h3 class="ct ${bnOf(x.name)}">${esc(x.name)}</h3>
        <p class="ca">Next: ${esc(x.isArc ? issueLabel(x.next) : numberOf(x.next))} \u00b7 ${num(x.read)} of ${num(x.total)} read</p>
        ${progressBar(x.read, x.total)}
      </a>`).join('')}</div>
    </section>` : '';
  const chip = (v, t) => `<button type="button" class="chip" data-g="show" data-v="${v}" aria-pressed="${show === v}">${t}</button>`;
  const read = comics.filter((b) => b.status === 'read').length;
  return `<div class="wrap">
    <h1>Comics</h1>
    <p class="lede">${num(comics.length)} ${comics.length === 1 ? 'issue' : 'issues and books'} · ${num(all.length)} series${arcs.length ? ` \u00b7 ${num(arcs.length)} ${arcs.length === 1 ? 'story arc' : 'story arcs'}` : ''} \u00b7 ${read} read</p>
    ${cont}
    ${arcs.length ? `<section class="shelf-row"><div class="row-head"><h2>Story Arcs</h2></div>
      <div class="grid stacks">${arcs.slice().sort((a, b) => (b.started && !b.done ? 1 : 0) - (a.started && !a.done ? 1 : 0) || collator.compare(a.name, b.name)).map(stack).join('')}</div>
    </section>` : ''}
    ${all.length ? `<section class="shelf-row"><div class="row-head"><h2>Series</h2></div>
      <div class="filters"><div class="chipgroup" role="group" aria-label="Show">${chip('', 'All')}${chip('reading', 'In progress')}${chip('new', 'Not started')}${chip('done', 'Finished')}</div></div>
      ${kept.length ? `<div class="grid stacks">${kept.map(stack).join('')}</div>` : '<p class="empty">No series here.</p>'}
    </section>` : ''}
    ${singles.length ? `<section class="shelf-row"><div class="row-head"><h2>${all.length ? 'Single Issues and One-Offs' : 'All Comics'}</h2></div>${gridHtml(sortList(singles, SORT_DEFAULT))}</section>` : ''}
    ${all.length ? '' : '<p class="hint">To group issues into series, give them a series name in the dashboard (Tools → Series can read it from the titles).</p>'}
  </div>`;
}

// ---------- stats ----------
const SI = (k) => `<svg class="si" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${STAT_ICON[k]}</svg>`;
const STAT_ICON = {'cal': '<rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M16 2.5v4M8 2.5v4M3 10h18"/>', 'peak': '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>', 'pages': '<path d="M14 2.5H6.5a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V8z"/><path d="M14 2.5V8h5.5M8.5 13h7M8.5 17h7"/>', 'book': '<path d="M2.5 4.5h6a3.5 3.5 0 0 1 3.5 3.5v12.5a3 3 0 0 0-3-3H2.5z"/><path d="M21.5 4.5h-6A3.5 3.5 0 0 0 12 8v12.5a3 3 0 0 1 3-3h6.5z"/>', 'target': '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>', 'bars': '<path d="M5 20v-6M12 20V4M19 20v-9"/>', 'phones': '<path d="M3.5 18v-6a8.5 8.5 0 0 1 17 0v6"/><rect x="3.5" y="14" width="4.5" height="7" rx="1.8"/><rect x="16" y="14" width="4.5" height="7" rx="1.8"/>', 'award': '<circle cx="12" cy="8.5" r="6"/><path d="M8.3 13.6 7 22l5-3 5 3-1.3-8.4"/>', 'stack': '<path d="M12 3 2.5 8 12 13l9.5-5z"/><path d="M2.5 12.5 12 17.5l9.5-5M2.5 17 12 22l9.5-5"/>', 'check': '<circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.8 2.8L16.2 9.5"/>'};

// Books, comics and audiobooks are counted together everywhere; the charts only show the split.
const KINDS = [['book', 'Books'], ['comic', 'Comics'], ['audio', 'Audiobooks']];
const kindOf = (b) => (b.format === 'Audiobook' ? 'audio' : isComics(b) ? 'comic' : 'book');
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const num = (n) => Number(n).toLocaleString('en');
const emptyCount = () => ({ book: 0, comic: 0, audio: 0, total: 0 });
// "4h 2m" or "31m" -> minutes (0 when no length is recorded), and back again
function minutesOf(b) {
  const m = String(b.duration || '').match(/(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?/);
  return m && (m[1] || m[2]) ? Number(m[1] || 0) * 60 + Number(m[2] || 0) : 0;
}
const fmtMinutes = (n) => (n >= 60 ? `${num(Math.floor(n / 60))}h ${Math.round(n % 60)}m` : `${Math.round(n)}m`);
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
    if (!goal) return change ? `<section class="goal"><h2>${year} Reading Goal</h2><p class="lede">You have finished ${num(finished)} so far this year.</p>${change}</section>` : '';
    return goalMeter(year, finished, goal, change);
  }
  const form = (label) => `<form class="goal-form" data-goal="${year}"><label>${label} <input type="number" name="goal" min="1" max="2000" inputmode="numeric" value="${goal || ''}" placeholder="e.g. 60" required></label><button class="btn primary" type="submit">Save</button>${goal ? '<button class="btn" type="button" data-goal-clear>Remove goal</button>' : ''}</form>`;
  if (!goal) return `<section class="goal"><h2>${year} Reading Goal</h2><p class="lede">You have finished ${num(finished)} so far this year. Set a goal and this page tracks it.</p>${form('Titles to finish this year')}<p class="hint">The goal is saved on this device only.</p></section>`;
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
  return `<section class="goal"><h2>${SI('target')}${year} Reading Goal</h2>
    <p class="goal-n"><b>${num(finished)}</b> of ${num(goal)} titles <span>${pct}%</span></p>
    <div class="goal-bar" role="img" aria-label="${finished} of ${goal} finished"><i style="width:${pct}%"></i>${finished < goal ? `<u style="left:${Math.round((expected / goal) * 100)}%" title="Where you would be today at an even pace"></u>` : ''}</div>
    <p class="lede">${pace}${finished < goal ? ` ${num(goal - finished)} to go${needText}.${endText}` : ''}</p>
    ${footer}
  </section>`;
}

function statsPage() {
  document.title = 'Stats – Reading Ledger';
  const read = books.filter((b) => b.status === 'read');
  // const dated = read.filter((b) => /^\d{4}-\d{2}/.test(b.finished_at || ''));
  // Every read counts, rereads too: one entry per read, carrying that read's date ('2024-03-14', or '2019'
  // when only the year is known). A year-only read counts in its year but in no month.
  const events = books.flatMap((b) => readsOf(b).map((r) => ({ ...b, finished_at: readWhen(r) || null })));
  const dated = events.filter((b) => /^\d{4}/.test(b.finished_at || ''));
  const fullDate = (b) => b.finished_at.length > 4;
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
  // const undated = read.length - dated.length;
  const undated = events.length - dated.length;

  // the year before, for comparison: up to today's date when looking at the current year
  const now = new Date();
  const prev = String(Number(year) - 1);
  let against = '';
  if (byYear.has(prev)) {
    if (year === thisYear) {
      const today = `${prev}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      against = `${num(byYear.get(prev).filter((b) => fullDate(b) && b.finished_at.slice(0, 10) <= today).length)} by this date in ${prev}`;
    } else against = `${num(byYear.get(prev).length)} in ${prev}`;
  }
  // months so far (this year) or twelve (a past year), and the busiest month
  const monthsIn = year === thisYear ? Math.max(1 / 12, (now - new Date(now.getFullYear(), 0, 1)) / (new Date(now.getFullYear() + 1, 0, 1) - new Date(now.getFullYear(), 0, 1))) * 12 : 12;
  const perMonth = count.total / monthsIn;
  const busiest = monthCols.reduce((best, c) => (c.count.total > best.count.total ? c : best), monthCols[0]);
  const perYm = new Map();
  dated.filter(fullDate).forEach((b) => { const k = b.finished_at.slice(0, 7); perYm.set(k, (perYm.get(k) || 0) + 1); });
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
  // listening time, from the lengths recorded on the audiobooks
  const audios = books.filter((x) => x.format === 'Audiobook');
  const timeOf = (list) => { const timed = list.filter((x) => minutesOf(x)); return { n: list.length, timed: timed.length, mins: timed.reduce((sum, x) => sum + minutesOf(x), 0) }; };
  const heard = timeOf(audios.filter((x) => x.status === 'read')), waiting = timeOf(audios.filter((x) => x.status !== 'read')), everyAudio = timeOf(audios);
  const gap = (t) => (t.timed === t.n ? '' : t.timed ? `. ${num(t.n - t.timed)} of them ${t.n - t.timed === 1 ? 'has' : 'have'} no length recorded, so the real total is higher` : '. None of these have a length recorded yet');
  const listening = audios.length ? `<section class="vz-card"><h2>${SI('phones')}Listening Time</h2>
      <div class="stiles in-card">
        ${tile(waiting.timed ? fmtMinutes(waiting.mins) : '\u2013', 'Waiting to Be Heard', `${num(waiting.n)} ${waiting.n === 1 ? 'audiobook' : 'audiobooks'}${gap(waiting)}`)}
        ${tile(heard.timed ? fmtMinutes(heard.mins) : '\u2013', 'Listened So Far', `${num(heard.n)} ${heard.n === 1 ? 'audiobook' : 'audiobooks'}${gap(heard)}`)}
        ${tile(everyAudio.timed ? fmtMinutes(everyAudio.mins / everyAudio.timed) : '\u2013', 'A Typical Audiobook', everyAudio.timed ? `The average of the ${num(everyAudio.timed)} with a length` : 'No lengths recorded yet')}
      </div>
      ${heard.timed < heard.n && ownerHere() ? '<p class="hint vz-note">Add the length to an audiobook in the dashboard and its time is counted here.</p>' : ''}
    </section>` : '';
  const older = first < cut - 1;
  const undatedNote = undated ? `<p class="hint vz-note">${num(undated)} ${undated === 1 ? 'read has' : 'reads have'} no finish date, so ${undated === 1 ? 'it is' : 'they are'} not in these charts.${ownerHere() ? ' <a href="admin.html#missing=finished">Add the dates in the dashboard</a>' : ''}</p>` : '';

  const yi = years.indexOf(year);
  const yearNav = `<nav class="yearnav" aria-label="Year">
      <button type="button" ${yi > 0 ? `data-year="${years[yi - 1]}"` : 'disabled'} aria-label="Earlier year">${ICON.left}</button>
      <b>${year}</b>
      <button type="button" ${yi < years.length - 1 ? `data-year="${years[yi + 1]}"` : 'disabled'} aria-label="Later year">${ICON.right}</button>
    </nav>`;
  const fig = (n, label, sub = '', icon = '') => `<div class="fig">${icon ? SI(icon) : ''}<b>${n}</b><span>${label}</span>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const goalHtml = year === thisYear ? goalCard(thisYear, (byYear.get(thisYear) || []).length) : '';
  return `<div class="wrap statpage v2">
    <header class="st-top"><h1>Stats</h1>${yearNav}</header>
    <section class="st-hero${goalHtml ? '' : ' solo'}">
      <svg class="st-mark" viewBox="0 0 170 110" aria-hidden="true"><rect x="6" y="20" width="21" height="78" rx="4"/><rect x="31" y="36" width="21" height="62" rx="4"/><rect x="56" y="10" width="23" height="88" rx="4"/><g transform="rotate(14 94 98)"><rect x="84" y="26" width="21" height="72" rx="4"/></g><rect x="0" y="100" width="118" height="6" rx="3"/></svg>
      <div class="st-big">
        <b>${num(count.total)}</b>
        <div><h2>Finished in ${year}</h2><p>${splitText(count)}</p>${against ? `<p class="vs">${against}</p>` : ''}</div>
      </div>
      ${goalHtml}
    </section>
    <section class="figs" aria-label="${year} in figures">
      ${fig(perMonth >= 10 ? num(Math.round(perMonth)) : String(Math.round(perMonth * 10) / 10), 'A Month on Average', '', 'cal')}
      ${fig(busiest.count.total ? num(busiest.count.total) : '–', 'Busiest Month', busiest.count.total ? busiest.long.split(' ')[0] : '', 'peak')}
      ${fig(pages ? num(pages) : '–', 'Pages', pages ? `from ${num(withPages.length)} of ${num(inYear.length)} titles` : 'no page counts yet', 'pages')}
      ${fig(longest ? num(longest.pages) : '–', 'Longest', longest ? link(longest) : '', 'book')}
    </section>
    <div class="st-two">
      <section class="vz-card"><h2>${SI('bars')}Finished Each Year</h2><p class="hint">Pick a year to see its months.</p>${columnChart(yearCols, 'Year', fold)}
        ${older ? `<p class="vz-more"><button type="button" data-statopt="years" data-val="${fold ? 'all' : ''}">${fold ? `Show every year since ${first}` : 'Show the last eight years only'}</button></p>` : ''}
      </section>
      <section class="vz-card"><h2>${SI('cal')}${year}, Month by Month</h2><p class="hint">Pick a month to see what was finished in it.</p>
        ${columnChart(monthCols, 'Month', true)}
      </section>
    </div>
    ${undatedNote}
    ${recent.length ? `<section class="shelf-row" id="stat-row"><div class="row-head"><h2>${rowTitle}</h2>${month ? '<button type="button" data-month="">Show the whole year</button>' : `<a href="#/shelf/read">See the Read Shelf${ICON.right}</a>`}</div><div class="row">${recent.map(homeCard).join('')}</div>${shown.length > recent.length ? `<p class="hint">Showing the latest ${num(recent.length)} of ${num(shown.length)}.</p>` : ''}</section>` : ''}
    <h2 class="st-div">${SI('stack')}All Time</h2>
    <div class="st-two even">
      <section class="vz-card"><div class="lead">${SI('check')}<b>${num(read.length)}</b><span>Finished So Far</span>${events.length > read.length ? `<small>${num(events.length)} reads in all, counting rereads</small>` : ''}${bestEver ? `<small>Best month: ${MONTHS[Number(bestEver[0].slice(5)) - 1]} ${bestEver[0].slice(0, 4)}, with ${num(bestEver[1])}</small>` : ''}</div>
        ${shareBar('Kind', [['Books', all.book, 'book'], ['Comics', all.comic, 'comic'], ['Audiobooks', all.audio, 'audio']])}
        ${shareBar('Language', [['Bengali', read.filter((b) => b.language === 'Bengali').length, 's1'], ['English', read.filter((b) => b.language === 'English').length, 's2']])}
        ${shareBar('Copy of the Books Read', [['Hardcopy', copies.hard, 's1'], ['Ebook', copies.ebook, 's2'], ['Both', copies.both, 's3'], ['Not recorded', copies.none, 'none']])}
      </section>
      ${listening}
    </div>
    <section class="vz-card"><div class="rank-head"><h2>${SI('award')}Most Read</h2><div class="seg" role="group" aria-label="Count">${seg}</div></div>
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
  const everything = books.filter((b) => wroteIt(b, key));
  if (!key || !everything.length) return notFound();
  const list = sortList(everything.filter(passes), SORT_AUTHOR);   // e.g. ?kind=audio: only this author's audiobooks
  const label = authorsOf(everything[0].author).find((a) => norm(a) === key) || name;
  document.title = `${label} \u2013 Reading Ledger`;
  return `<div class="wrap">
    <p class="eyebrow">Author</p>
    <h1 class="${/[\u0980-\u09FF]/.test(label) ? 'bn' : ''}">${esc(label)}</h1>
    <p class="lede">${num(list.length)} ${list.length === 1 ? 'title' : 'titles'}${list.length < everything.length ? ` of ${num(everything.length)}` : ''}</p>
    ${chips(['lang', 'kind'], SORT_AUTHOR, list.length, everything.some((b) => b.format === 'Audiobook'))}
    ${list.length ? gridHtml(list) : '<p class="empty">No titles match these filters yet.</p>'}
  </div>`;
}

// "2024-03-11" -> "11 March 2024" (built by hand so time zones can never shift the day)
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function fmtDate(iso) {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : '';
}

// Book Details (and Audiobook Details) are always open on a wide screen and folded on a narrow one.
// The page decides this when it is drawn; these keep it right when the window is resized, the phone
// is turned, or the browser switches to a phone view (fixed 18 November 2026: before, a page drawn
// narrow stayed folded on a wide screen, where the heading cannot be clicked).
[['(min-width: 1001px)', '.bookpage .facts-more'], ['(min-width: 901px)', '.detail.listen .facts-more']].forEach(([query, selector]) => {
  const mq = window.matchMedia(query);
  mq.addEventListener('change', () => document.querySelectorAll(selector).forEach((d) => { d.open = mq.matches; }));
});

function detailPage(id) {
  const b = books.find((x) => String(x.id) === id);
  if (!b) return notFound();
  const audio = b.format === 'Audiobook';
  const size = audio ? b.duration : (b.pages ? `${b.pages} pages` : '');
  const meta = [size, b.pub_year, b.language].filter(Boolean).map(esc).join(' \u00b7 ');
  const link = audio && b.youtube_url && /^https?:\/\//i.test(b.youtube_url) ? b.youtube_url : '';
  const yt = link
    ? `<a class="btn primary block" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${ICON.play}Listen on YouTube</a>` : '';
  const finished = b.status === 'read' && fmtDate(b.finished_at) ? `${audio ? 'Listened' : 'Finished'} ${fmtDate(b.finished_at)}` : '';
  // ---- reads, rereads and progress (added 18 November 2026) ----
  const reads = readsOf(b);
  const rereading = rereadingNow(b);
  const many = reads.length > 1 || (rereading && reads.length > 0);     // a history list is worth showing
  const pct = pctOf(b);
  const markPlain = b.progress_mark ? (audio ? `${b.progress_mark}${b.duration ? ` of ${b.duration}` : ''}`
    : `page ${b.progress_mark}${b.pages ? ` of ${num(b.pages)}` : ''}`) : '';
  const ago = (iso) => {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return '';
    const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(m[1], m[2] - 1, m[3])) / 864e5);
    return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 7 ? `${days} days ago` : `on ${fmtDate(iso)}`;
  };
  const progSub = [rereading ? `${ordinal(reads.length + 1)} ${audio ? 'listen' : 'read'}` : '',
    b.started_at && readingNow(b) ? `started ${fmtDate(b.started_at)}` : '',
    pct != null && b.progress_on ? `updated ${ago(b.progress_on)}` : ''].filter(Boolean).join(' \u00b7 ');
  const progressHtml = pct != null
    ? `<section class="inseries myprog"><h2 class="h3">Your Progress</h2>
      <p class="inseries-n"><b class="num">${pct}%</b>${markPlain ? ` \u00b7 ${esc(markPlain)}` : ''}</p>
      ${pctBar(pct)}${progSub ? `<p class="myprog-sub">${esc(progSub)}</p>` : ''}</section>`
    : progSub ? `<p class="meta myprog-only">${esc(progSub)}</p>` : '';
  const timesWord = (n) => (n === 1 ? 'Once' : n === 2 ? 'Twice' : `${num(n)} Times`);
  let historyHtml = '';
  if (many) {
    const undatedN = reads.filter((r) => !readWhen(r)).length;
    const items = [];
    reads.forEach((r, i) => {
      const w = readWhen(r);
      if (w) items.push(`<li><span>${ordinal(i + 1)}</span>${w.length > 4 ? `${audio ? 'Listened' : 'Finished'} ${fmtDate(w)}` : esc(w)}</li>`);
    });
    items.reverse();                                  // newest first
    if (undatedN) items.push(`<li><span>${undatedN > 1 ? `1st\u2013${ordinal(undatedN)}` : '1st'}</span>${undatedN > 1 ? 'No dates' : 'No date'}</li>`);
    historyHtml = `<section class="inseries myreads"><h2 class="h3">${audio ? 'Listened' : 'Read'} ${timesWord(reads.length)}</h2><ol class="readlist">${items.join('')}</ol></section>`;
  }
  const finishedLine = many ? '' : finished;            // the list already shows every finish date
  const facts = [
    ['Format', b.format],
    [audio ? 'Duration' : 'Pages', audio ? b.duration : b.pages],
    ['Published', b.pub_year],
    ['Language', b.language],
    ['Status', statusWord(b)],
    // ...(b.status === 'read' ? [['Date finished', fmtDate(b.finished_at)]] : []),
    ...(b.status === 'read' ? [[many ? 'Last finished' : 'Date finished', fmtDate(b.finished_at) || (reads.length ? readWhen(reads[reads.length - 1]) : '')]] : []),
    ...(many ? [[audio ? 'Times listened' : 'Times read', `${num(reads.length)}${rereading ? ` (${ordinal(reads.length + 1)} in progress)` : ''}`]] : []),
    ...(pct != null ? [['Progress', `${pct}%${markPlain ? ` (${markPlain})` : ''}`]] : []),
    ['Ownership', OWN[b.ownership]],
    ...(audio ? [] : [['Copies', (b.copies || []).filter((c) => COPY[c]).map((c) => COPY[c]).join(' and ')]]),
  ].filter(([, v]) => !audio || v || v === 0)      // an audiobook's empty rows are left out
   .map(([k, v]) => `<tr><th scope="row">${k}</th><td>${v || v === 0 ? esc(v) : '\u2014'}</td></tr>`).join('');
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
      <div class="row-head"><h2>More in <span class="${hasBn(rowName) ? 'bn' : ''}">${esc(rowName)}</span><small>${num(siblings.length)}</small></h2><a href="${esc(rowHref)}">See all${ICON.right}</a></div>
      <div class="row">${nearby.map(seriesCard).join('')}</div>
    </section>` : '';
  // One "More by ..." row per author (at most three), each with that author's other titles.
  const writers = authorsOf(b.author);
  const rowOf = (title, list, href, n) => (list.length ? `<section class="shelf-row more-by">
      <div class="row-head"><h2>${title}${n == null ? '' : `<small>${num(n)}</small>`}</h2>${href ? `<a href="${esc(href)}">See all${ICON.right}</a>` : ''}</div>
      <div class="row">${list.slice(0, 12).map(homeCard).join('')}</div>
    </section>` : '');
  // On a book's page: the author's other books in one row, the author's audiobooks in another (at most three authors).
  // "See all" opens the author's page already narrowed to what the row shows.
  const moreBy = writers.slice(0, 3).map((name) => {
    const others = books.filter((x) => x.id !== b.id && wroteIt(x, norm(name))).sort(byTitle);
    const paper = others.filter((x) => x.format !== 'Audiobook'), heard = others.filter((x) => x.format === 'Audiobook');
    const nm = `<span class="${hasBn(name) ? 'bn' : ''}">${esc(name)}</span>`;
    // the same titles as the series row just above: no need to show them twice
    const repeat = nearby.length && paper.every((x) => siblings.includes(x));
    const onlyBooks = paper.every((x) => !isComics(x)) && !isComics(b);
    return (repeat ? '' : rowOf(`More Books by ${nm}`, paper, `${authorHref(name)}${onlyBooks ? '?kind=book' : ''}`, paper.length + 1))
      + rowOf(`Audiobooks by ${nm}`, heard, `${authorHref(name)}?kind=audio`, heard.length);
  }).join('');
  // ---- audiobook page: rows that keep you listening, and links into the rest of the library
  let audioRows = '', twin = null;
  if (audio) {
    const bare = (t) => norm(String(t || '').replace(/\(.*?\)/g, ''));
    twin = books.find((x) => x.format === 'Book' && bare(x.title) === bare(b.title)) || null;
    audioRows = writers.slice(0, 2).map((name) => {
      const mine = books.filter((x) => x.id !== b.id && wroteIt(x, norm(name)));
      const heard = mine.filter((x) => x.format === 'Audiobook').sort(byTitle), paper = mine.filter((x) => x.format !== 'Audiobook').sort(byTitle);
      const nm = `<span class="${hasBn(name) ? 'bn' : ''}">${esc(name)}</span>`;
      // the same audiobooks as the series row just above: no need to show them twice
      const repeat = nearby.length && heard.length && heard.every((x) => siblings.includes(x));
      // "See all" opens the author's page already narrowed to what the row shows
      const onlyBooks = paper.every((x) => !isComics(x));
      return (repeat ? '' : rowOf(`More Audiobooks by ${nm}`, heard, `${authorHref(name)}?kind=audio`, heard.length + 1))
        + rowOf(`Books by ${nm}`, paper, `${authorHref(name)}${onlyBooks ? '?kind=book' : ''}`, paper.length);
    }).join('');
    const mins = (x) => minutesOf(x) || 1e9;   // no length recorded: goes last
    const waiting = books.filter((x) => x.format === 'Audiobook' && x.id !== b.id && x.status !== 'read').sort((x, y) => mins(x) - mins(y));
    audioRows += rowOf('Up Next, Shortest First', waiting, '#/shelf/audio', null);   // no count: "See all" opens every audiobook, heard or not
  }
  // the one before and the one after this in its series
  const here = siblings.findIndex((x) => x.id === b.id);
  const step = (x, word) => (x ? `<a class="step${x.format === 'Audiobook' ? ' wide' : ''}" href="#/book/${esc(x.id)}"><span class="step-c">${coverHtml(x)}</span><span class="step-t"><small>${word}${x.series_no != null ? ` \u00b7 #${esc(x.series_no)}` : ''}</small><b class="${lc(x)}">${esc(x.title)}</b></span></a>` : '');
  const stepNav = here >= 0 && siblings.length > 1 ? `<nav class="steps" aria-label="In ${esc(rowName)}">${step(siblings[here - 1], 'Previous')}${step(siblings[here + 1], 'Next')}</nav>` : '';
  // where this one sits in its series, and how far through the series I am
  const doneIn = siblings.filter((x) => x.status === 'read').length;
  const inArcNow = arcMates.length > 1;
  const place = inArcNow
    ? (b.arc_no != null ? `Part ${esc(b.arc_no)} of ${num(siblings.length)}` : `${num(siblings.length)} parts`)
    : (b.series_no != null ? `#${esc(b.series_no)} of ${num(siblings.length)}` : `${num(siblings.length)} titles`);
  // a comic in a story arc usually belongs to a series as well: the arc leads (it is the reading order),
  // and the series gets its own line underneath
  const seriesToo = inArcNow && b.series ? inSeries(b.series) : [];
  const alsoSeries = seriesToo.length ? `<p class="inseries-also">${b.series_no != null ? `Issue #${esc(b.series_no)} of` : 'Also in'} the series <a class="${hasBn(b.series) ? 'bn' : ''}" href="${esc(seriesHref(b.series))}">${esc(b.series)}</a><small>${num(seriesToo.length)} on the shelf · ${num(seriesToo.filter((x) => x.status === 'read').length)} read</small></p>` : '';
  const seriesBox = here >= 0 && siblings.length > 1 ? `<section class="inseries"><h2 class="h3">${inArcNow ? 'In the Story Arc' : 'In the Series'} <a class="${hasBn(rowName) ? 'bn' : ''}" href="${esc(rowHref)}">${esc(rowName)}</a></h2>
      <p class="inseries-n">${place} · ${num(doneIn)} read</p>
      ${progressBar(doneIn, siblings.length)}
      ${stepNav}
      ${alsoSeries}
    </section>` : (b.series && inSeries(b.series).length === 1 ? `<section class="inseries"><h2 class="h3">In the Series <a href="${esc(seriesHref(b.series))}">${esc(b.series)}</a></h2></section>` : '');
  const genresHtml = (b.genres || []).length ? `<ul class="genres" aria-label="Genres">${b.genres.map((g) => {
    const slug = genreKey(g);
    const bn = /[\u0980-\u09FF]/.test(g) ? ' bn' : '';
    return slug ? `<li class="gchip${bn}"><a href="#/genre/${esc(slug)}">${esc(g)}</a></li>` : `<li class="gchip${bn}">${esc(g)}</li>`;
  }).join('')}</ul>` : '';
  const authorHtml = `<p class="author ${lc(b)}">${writers.map((name) => `<a href="${esc(authorHref(name))}">${esc(name)}</a>`).join(', ') || esc(b.author)}</p>`;
  const audioPage = () => `<div class="wrap">
    <div class="detail-top"><a class="backbtn" href="${esc(backHash)}" data-back>${ICON.left}Back to ${esc(backLabel)}</a>${edit}</div>
    <article class="detail audio listen">
      <div class="detail-side">
        ${link && ytId(link) ? `<button type="button" class="ytplay" data-yt="${esc(ytId(link))}" aria-label="Play ${esc(b.title)} here">${coverHtml(b, true)}</button>` : coverHtml(b, true)}
      </div>
      <header class="detail-head">
        <h1 class="${lc(b)}">${esc(b.title)}</h1>
        ${authorHtml}
        ${seriesLine}
        <p class="meta">${meta}</p>
      </header>
      <div class="detail-body">
        <div class="dtags">${statusBadge(b)}${badge(b)}</div>
        ${twin ? `<p class="twin">Also on the shelf as a book: <a class="${lc(twin)}" href="#/book/${esc(twin.id)}">${esc(twin.title)}</a></p>` : ''}
        ${progressHtml}${historyHtml}
        ${finishedLine ? `<p class="meta">${finishedLine}</p>` : ''}
        ${b.description ? `<p class="desc ${lc(b)}">${esc(b.description)}</p>` : ''}
        ${genresHtml}
      </div>
      <aside class="detail-aside">
        ${yt}${link && ytId(link) ? '<p class="hint yt-hint">Press play on the picture to listen here, or use the button to open YouTube.</p>' : ''}
        <details class="facts-more"${window.matchMedia('(min-width: 901px)').matches ? ' open' : ''}><summary>Audiobook Details</summary><table class="facts"><tbody>${facts}</tbody></table></details>
        ${stepNav}
      </aside>
    </article>
    ${moreSeries}
    ${audioRows}
  </div>`;
  const edit = ownerHere() ? `<a class="btn editbtn" href="admin.html#edit=${esc(b.id)}">${ICON.edit}Edit</a>` : '';
  document.title = `${b.title} \u2013 Reading Ledger`;
  if (audio) return audioPage();
  return `<div class="wrap">
    <div class="detail-top"><a class="backbtn" href="${esc(backHash)}" data-back>${ICON.left}Back to ${esc(backLabel)}</a>${edit}</div>
    <article class="detail bookpage">
      <div class="detail-side"><button type="button" class="coverzoom" data-zoom aria-label="See the cover full screen">${coverHtml(b, true)}</button></div>
      <header class="detail-head">
        <h1 class="${lc(b)}">${esc(b.title)}</h1>
        ${authorHtml}
        <p class="meta">${meta}</p>
        <div class="dtags">${statusBadge(b)}${badge(b)}${copyBadges(b)}</div>
      </header>
      <div class="detail-body">
        ${progressHtml}${historyHtml}
        ${finishedLine ? `<p class="meta fin">${finishedLine}</p>` : ''}
        ${b.description ? `<p class="desc ${lc(b)}${String(b.description).length > 420 ? ' clamp' : ''}">${esc(String(b.description).replace(/<br\s*\/?>/gi, '\n'))}</p>${String(b.description).length > 420 ? '<button type="button" class="desc-more" data-desc>Read more</button>' : ''}` : ''}
        ${genresHtml}
      </div>
      <aside class="detail-aside">
        ${seriesBox}
        <details class="facts-more"${window.matchMedia('(min-width: 1001px)').matches ? ' open' : ''}><summary>Book Details</summary><table class="facts"><tbody>${facts}</tbody></table></details>
      </aside>
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
  return `<div class="wrap"><h1>Search Results</h1>
    <p class="lede">${num(hits.length)} ${hits.length === 1 ? 'title matches' : 'titles match'} \u201c${esc(text.trim())}\u201d</p>
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
  if (state === 'setup') { setNav(''); app.innerHTML = stateBox('<h1>Almost There</h1><p>Open <code>js/config.js</code> and paste your Supabase project URL and publishable key. The README explains how.</p>'); return; }
  if (state === 'loading') { app.innerHTML = stateBox('<p>Loading the shelf\u2026</p>'); return; }
  if (state === 'error') {
    app.innerHTML = stateBox('<h1>The Shelf Is Out of Reach</h1><p>We couldn\u2019t load the books. Check your connection, or your Supabase project may be paused.</p><button class="btn primary" type="button" data-retry>Try again</button>');
    return;
  }
  grids = {};
  const { parts, params } = route();
  const page = parts[0] || 'home';
  const opt = (name) => params.get(name) || '';
  // (older links said type=comic or fmt=Audiobook; they still work)
  filters = { lang: opt('lang'), own: opt('own'), copies: opt('copies'), kind: opt('kind') || (opt('fmt') === 'Audiobook' ? 'audio' : opt('type')) };
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
  markOwner();
  watchMore();
  const note = document.getElementById('offline-note');
  if (offline && state === 'ready' && !note) {
    app.insertAdjacentHTML('beforebegin', '<p id="offline-note" class="offline-note" role="status">No connection. Showing the shelf as it was last saved on this device.</p>');
  } else if (!offline && note) note.remove();
  const bar = document.querySelector('.stabs');
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
  const pick = e.target.closest('[data-fsel]');
  if (pick) { setOption(pick.dataset.fsel, pick.value); redraw(`[data-fsel="${pick.dataset.fsel}"]`); return; }
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
  const zoom = e.target.closest('[data-zoom]');
  if (zoom) {      // the cover, as large as the screen allows; a tap anywhere (or Escape) closes it
    const box = document.createElement('dialog');
    box.className = 'coverbox';
    const img = zoom.querySelector('img');
    box.innerHTML = `<button type="button" class="coverbox-x" aria-label="Close">\u00d7</button>${img ? `<img src="${esc(img.currentSrc || img.src)}" alt="${esc(img.alt)}">` : `<div class="coverbox-gen cover">${zoom.querySelector('.gencover').outerHTML}</div>`}`;
    box.addEventListener('click', () => box.close());
    box.addEventListener('close', () => { box.remove(); zoom.focus({ preventScroll: true }); });
    document.body.append(box);
    box.showModal();
    return;
  }
  const descBtn = e.target.closest('[data-desc]');
  if (descBtn) { const folded = descBtn.previousElementSibling.classList.toggle('clamp'); descBtn.textContent = folded ? 'Read more' : 'Show less'; return; }
  const play = e.target.closest('[data-yt]');
  if (play) {      // play the audiobook right here instead of leaving for YouTube
    const frame = document.createElement('iframe');
    frame.className = 'ytframe';
    frame.src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(play.dataset.yt)}?autoplay=1&rel=0`;
    frame.title = play.getAttribute('aria-label') || 'Audiobook';
    frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    frame.allowFullscreen = true;
    play.replaceWith(frame);
    return;
  }
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
