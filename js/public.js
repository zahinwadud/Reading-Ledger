// Public site: home rows, shelf pages, book detail, live search.
import { configured, fetchBooks, coverOf, ytThumb, esc, norm, initTheme, STATUS, OWN } from './api.js';

const app = document.getElementById('app');
const qEl = document.getElementById('q');
initTheme(document.getElementById('theme'));

let books = [];
let state = configured ? 'loading' : 'setup'; // loading | ready | error | setup
let filters = { lang: '', own: '', fmt: '', copies: '' };
let lastPath = '';

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
function coverHtml(b, eager) {
  const audio = b.format === 'Audiobook';
  const yurl = audio ? ytThumb(b.youtube_url, eager ? 'maxresdefault' : 'hqdefault') : '';
  const url = yurl || coverOf(b);
  const fallback = yurl && eager ? ytThumb(b.youtube_url, 'hqdefault') : ''; // if maxres is missing
  const dims = audio ? 'width="320" height="180"' : 'width="200" height="300"';
  const img = url
    ? `<img src="${esc(url)}" ${fallback ? `data-fb="${esc(fallback)}"` : ''} alt="${audio ? 'Thumbnail' : 'Cover'} of ${esc(b.title)}" ${dims} ${eager ? '' : 'loading="lazy"'}>`
    : `<div class="nocover">${audio ? 'No thumbnail' : 'No cover'}</div>`;
  const play = yurl ? `<span class="play" aria-hidden="true">${ICON.play}</span>` : '';
  const hp = audio
    ? `<span class="hp" role="img" aria-label="Audiobook" title="Audiobook">${ICON.phones}</span>` : '';
  return `<div class="cover${audio ? ' wide' : ''}">${img}${play}${hp}</div>`;
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
function cardBase(b, withTags) {
  return `<a class="card${b.format === 'Audiobook' ? ' wide' : ''}" href="#/book/${esc(b.id)}">
    ${coverHtml(b)}
    ${withTags ? `<p class="cstat">${statusBadge(b)}</p>` : ''}
    <h3 class="ct ${lc(b)}">${esc(b.title)}</h3>
    <p class="ca ${lc(b)}">${esc(b.author)}</p>
    ${withTags ? badge(b) : ''}
  </a>`;
}
const card = (b) => cardBase(b, false);
const homeCard = (b) => cardBase(b, false);

const stateBox = (html) => `<div class="wrap"><div class="state">${html}</div></div>`;
const notFound = () => stateBox('<p>We couldn\u2019t find that page.</p><a class="btn primary" href="#/">Back to the shelf</a>');

// Books (portrait covers) and audiobooks (wide thumbnails) never share one grid.
function gridHtml(list, withTags = false) {
  const cardFn = withTags ? (b) => cardBase(b, true) : card;
  const bk = list.filter((b) => b.format !== 'Audiobook');
  const au = list.filter((b) => b.format === 'Audiobook');
  const grid = (l, wide) => `<div class="grid${wide ? ' wide' : ''}">${l.map(cardFn).join('')}</div>`;
  if (bk.length && au.length) {
    return `<h2 class="sec-h">Books <small>${bk.length}</small></h2>${grid(bk)}<h2 class="sec-h">Audiobooks <small>${au.length}</small></h2>${grid(au, true)}`;
  }
  return grid(list, au.length > 0);
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
    return `<a class="cf-card" href="#/book/${esc(b.id)}" data-i="${i}" data-o="${o}" ${o === 0 ? '' : 'tabindex="-1"'} aria-label="${esc(b.title)}, ${esc(b.author)}">${
      url ? `<img src="${esc(url)}" alt="" width="230" height="345" draggable="false">` : '<div class="nocover">No cover</div>'}</a>`;
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
  const pics = (f, n = 4) => books.filter((b) => f(b) && coverOf(b)).slice(0, n);

  // One card: up to 4 mini covers as a mosaic, or a single cover, or a plain tint.
  const card = (href, count, label, list, cls = '') => {
    const covers = list.map((b) =>
      `<img src="${esc(coverOf(b))}" alt="" loading="lazy">`).join('');
    return `<a class="pstat${cls ? ' ' + cls : ''}" href="${href}">
      <span class="pstat-bg" aria-hidden="true">${covers || ''}</span>
      <span class="pstat-num">${count}</span>
      <span class="pstat-lbl">${label}</span>
    </a>`;
  };

  const all = books.slice(0, 4);
  return `<section class="pstats" aria-label="Library statistics">
    ${card('#/all', books.length, 'Total',
        pics(() => true), 'big')}
    ${card('#/shelf/reading', c(b => b.status === 'reading'), 'Reading',
        pics(b => b.status === 'reading'))}
    ${card('#/shelf/read', c(b => b.status === 'read'), 'Read',
        pics(b => b.status === 'read'))}
    ${card('#/shelf/want', c(b => b.status === 'want'), 'To read',
        pics(b => b.status === 'want'))}
    ${card('#/shelf/audio', c(b => b.format === 'Audiobook'), 'Audiobooks',
        pics(b => b.format === 'Audiobook'))}
    ${card('#/copies/hardcopy', c(b => (b.copies || []).includes('hardcopy')), 'Hardcopy',
        pics(b => (b.copies || []).includes('hardcopy')))}
    ${card('#/copies/ebook', c(b => (b.copies || []).includes('ebook')), 'Ebook',
        pics(b => (b.copies || []).includes('ebook')))}
    ${card('#/shelf/buy', c(b => b.ownership === 'buy'), 'Want to buy',
        pics(b => b.ownership === 'buy'))}
  </section>`;
}


// ---------- pages ----------
function homePage() {
  const rows = SHELVES.filter((s) => s.key !== 'all').map((s) => {
    const all = books.filter(s.test);
    const list = all.slice(0, HOME_ROW_LIMIT);
    return `<section class="shelf-row" aria-label="${esc(s.label)}">
      <div class="row-head"><h2>${s.label}</h2><a href="#/shelf/${s.key}">See all (${all.length})</a></div>
      ${list.length ? `<div class="row">${list.map(homeCard).join('')}</div>` : '<p class="empty">Nothing on this shelf yet.</p>'}
    </section>`;
  }).join('');
  document.title = 'Reading Ledger';
  return heroHtml() + `<div class="wrap">${statsHtml()}${rows}</div>`;
}

function chips(key) {
  const showFormat = key === 'all' || key === 'buy';
  const group = (id, label, opts) =>
    `<div class="chipgroup" role="group" aria-label="${label}"><span class="cg-l">${label}</span>${
      opts.map(([v, t]) => `<button type="button" class="chip" data-g="${id}" data-v="${v}" aria-pressed="${filters[id] === v}">${t}</button>`).join('')
    }</div>`;
  return `<div class="filters">
    ${group('lang', 'Language', [['', 'All'], ['English', 'English'], ['Bengali', 'Bengali']])}
    ${key === 'buy' ? '' : group('own', 'Ownership', [['', 'All'], ['owned', 'Owned'], ['buy', 'Want to Buy']])}
    ${showFormat ? group('fmt', 'Format', [['', 'All'], ['Book', 'Books'], ['Audiobook', 'Audiobooks']]) : ''}
    ${group('copies', 'Copies', [['', 'All'], ['hardcopy', 'Hardcopy'], ['ebook', 'Ebook']])}
  </div>`;
}

function shelfPage(key) {
  const shelf = SHELVES.find((s) => s.key === key);
  if (!shelf) return notFound();
const list = books.filter(shelf.test).filter((b) =>
  (!filters.lang || b.language === filters.lang) &&
  (!filters.own || b.ownership === filters.own) &&
  (!filters.fmt || b.format === filters.fmt) &&
  (!filters.copies || (b.copies || []).includes(filters.copies))
);
  const bar = SHELVES.map((s) =>
    `<a class="shelf-pill" href="${s.key === 'all' ? '#/all' : '#/shelf/' + s.key}" ${s.key === key ? 'aria-current="page"' : ''}>${s.label}<span class="n">${books.filter(s.test).length}</span></a>`
  ).join('');
  document.title = `${shelf.label} \u2013 Reading Ledger`;
  return `<nav class="shelfbar" aria-label="Shelves"><div class="shelfbar-in">${bar}</div></nav>
  <div class="wrap">
    <h1>${shelf.label}</h1>
    ${chips(key)}
    ${list.length ? gridHtml(list) : '<p class="empty">No titles match these filters yet.</p>'}
  </div>`;
}

function copiesPage(kind) {
  const LABELS = { hardcopy: 'Hardcopy books', ebook: 'Ebook books' };
  const label = LABELS[kind];
  if (!label) return notFound();
  const list = books.filter((b) => (b.copies || []).includes(kind));
  document.title = `${label} \u2013 Reading Ledger`;
  return `<div class="wrap">
    <h1>${label}</h1>
    <p class="lede">${list.length} ${list.length === 1 ? 'title' : 'titles'}</p>
    ${list.length ? gridHtml(list) : '<p class="empty">Nothing here yet.</p>'}
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
  document.title = `${label} \u2013 Reading Ledger`;
  return `<div class="wrap">
    <h1>${esc(label)}</h1>
    <p class="lede">${list.length} ${list.length === 1 ? 'title' : 'titles'}</p>
    ${list.length ? gridHtml(list) : '<p class="empty">Nothing here yet.</p>'}
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
  document.title = `${b.title} \u2013 Reading Ledger`;
  return `<div class="wrap">
    <a class="backbtn" href="${esc(backHash)}">${ICON.left}Back to ${esc(backLabel)}</a>
    <article class="detail${audio ? ' audio' : ''}">
      <div class="detail-side">
        ${link ? `<a class="ytlink" href="${esc(link)}" target="_blank" rel="noopener noreferrer" aria-label="Watch ${esc(b.title)} on YouTube">${coverHtml(b, true)}</a>` : coverHtml(b, true)}
        ${yt}
      </div>
      <div>
        <div class="dtags">${statusBadge(b)}${badge(b)}${copyBadges(b)}</div>
        <h1 class="${lc(b)}">${esc(b.title)}</h1>
        <p class="author ${lc(b)}">${esc(b.author)}</p>
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
  </div>`;
}

function searchPage(q) {
  const hits = books.filter((b) => norm(b.title).includes(q) || norm(b.author).includes(q));
  document.title = `Search \u2013 Reading Ledger`;
  return `<div class="wrap"><h1>Search results</h1>
    <p class="lede">${hits.length} ${hits.length === 1 ? 'title matches' : 'titles match'} \u201c${esc(qEl.value.trim())}\u201d</p>
    ${hits.length ? gridHtml(hits) : '<p class="empty">Nothing found. Try a different spelling or part of the name.</p>'}
  </div>`;
}

// ---------- "Back" button on the book page: returns to the page you came from ----------
let backHash = '#/all';
let backLabel = 'Books';
let lastHash = location.hash;
function rememberBack(from) {
  if (/^#\/book\//.test(from)) return;                       // never go "back" to another book page
  if (from === '' || from === '#' || from === '#/') { backHash = '#/'; backLabel = 'Home'; }
  else if (/^#\/(all|shelf\/)/.test(from)) { backHash = from; backLabel = 'Books'; }
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
  const q = norm(qEl.value);
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const page = parts[0] || 'home';
  const path = parts.slice(0, 2).join('/');
  if (path !== lastPath) { filters = { lang: '', own: '', fmt: '', copies: '' }; lastPath = path; }
  if (q) { setNav(''); app.innerHTML = searchPage(q); return; }
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
  if (page === 'all') { setNav('books'); app.innerHTML = shelfPage('all'); return; }
  if (page === 'home') { setNav('home'); app.innerHTML = homePage(); return; }
  setNav(''); app.innerHTML = notFound();
}

// Draw the page, then scroll the shelf bar so the current shelf is in view (matters on phones).
function render() {
  draw();
  const bar = document.querySelector('.shelfbar-in');
  const cur = bar && bar.querySelector('[aria-current]');
  if (cur) bar.scrollLeft = cur.offsetLeft - (bar.clientWidth - cur.offsetWidth) / 2;
}

async function load() {
  if (!configured) { state = 'setup'; render(); return; }
  state = 'loading'; render();
  try { books = await fetchBooks(); state = 'ready'; }
  catch (err) { console.error(err); state = 'error'; }
  render();
}

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
function closeSearch() {
  const had = qEl.value !== '';
  qEl.value = ''; collapseSearch();
  if (had) render();
}
sBtn.addEventListener('click', () => {
  if (sw.classList.contains('open')) { closeSearch(); return; }
  sw.classList.add('open'); topBar.classList.add('searching'); sBtn.setAttribute('aria-expanded', 'true');
  qEl.focus();
});
qEl.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeSearch(); sBtn.focus(); } });
document.addEventListener('pointerdown', (e) => {
  if (sw.classList.contains('open') && !qEl.value && !e.target.closest('#sw')) collapseSearch();
});

qEl.addEventListener('input', render);
window.addEventListener('hashchange', () => { rememberBack(lastHash); lastHash = location.hash; qEl.value = ''; collapseSearch(); render(); window.scrollTo(0, 0); });
// Clicking a top-bar link always leaves search, even if the address does not change.
topBar.addEventListener('click', (e) => {
  if (e.target.closest('a')) { qEl.value = ''; collapseSearch(); setTimeout(render, 0); }
});
function useFallback(e) {
  const img = e.target;
  // A cover link that no longer works: show the neutral "No cover" box instead of a broken picture.
  if (e.type === 'error' && img.tagName === 'IMG' && !img.dataset.fb && img.closest('.cover, .cf-card')) {
    const box = document.createElement('div');
    box.className = 'nocover'; box.textContent = 'No cover';
    img.replaceWith(box);
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
  if (chip) { filters[chip.dataset.g] = chip.dataset.v; render(); return; }
  if (e.target.closest('[data-retry]')) load();
});

load();
