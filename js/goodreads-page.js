// Dashboard: "Fill from a saved Goodreads page" in the Add / Edit Book form (added 19 November 2026).
// Save a Goodreads book page with Ctrl+S ("Webpage, Complete") and drop the .htm file, with its cover picture
// from the "_files" folder, onto the box at the top of the form. The page is read here, in this browser:
// nothing is fetched from Goodreads. A preview shows what the page has next to what the form has; ticked
// items are copied into the form, and nothing is saved until you press Save book.
import { patchBook, esc, authorsOf } from './api.js';
import { matchKey } from './series-list.js';
// Fill from a web page (20 November 2026): Fandom links, any saved page, pasted text
import { readFandomLink, readGenericPage, readPastedText, fandomAddress } from './web-reader.js';
import { seriesCore, shelfKey } from './comics.js';
import { openIssues, onIssuesClick } from './collection-import.js';   // Get its issues (21 November 2026)

const $ = (id) => document.getElementById(id);
const isBn = (text) => /[ঀ-৿]/.test(text || '');
const bn = (text) => (isBn(text) ? 'bn' : '');

// START-PURE-HELPERS
const decode = (s) => String(s ?? '').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
// Goodreads descriptions are HTML: line breaks become new lines, other tags are dropped.
export function plainText(html) {
  return decode(String(html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n\n').replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
// "1" -> [1]; "2, 3, 4" -> [2, 3, 4]; "1-3" -> [1, 2, 3]; anything else -> []
export function positions(text) {
  const out = [];
  String(text ?? '').split(',').forEach((part) => {
    const p = part.trim();
    let m = p.match(/^(\d+(?:\.\d+)?)$/);
    if (m) { out.push(Number(m[1])); return; }
    m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m && Number(m[2]) >= Number(m[1]) && Number(m[2]) - Number(m[1]) < 200) for (let n = Number(m[1]); n <= Number(m[2]); n += 1) out.push(n);
  });
  return out;
}
const yearOf = (ms) => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).getUTCFullYear() : null);

// Read a saved Goodreads book page. Returns null when it is not one, otherwise
// { id, title, authors, description, genres, pages, year, publisher, format, language, isbn, series, editions, cover }.
// series = [{ name, numbers }] (one number: the book's place; several: the books it contains).
// editions = the other editions on the page: [{ isbn, isbn13, pages }].
export function readGoodreadsPage(html) {
  const text = String(html ?? '');
  const idMatch = text.match(/<link[^>]+rel="canonical"[^>]+href="[^"]*\/book\/show\/(\d+)/i)
    || text.match(/property="og:url"[^>]+content="[^"]*\/book\/show\/(\d+)/i)
    || text.match(/\/book\/show\/(\d+)/);
  let id = idMatch ? Number(idMatch[1]) : null;
  let ld = null;
  const ldm = text.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (ldm) { try { ld = JSON.parse(ldm[1]); } catch (e) { ld = null; } }
  let st = null;
  const nd = text.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (nd) { try { st = JSON.parse(nd[1]).props.pageProps.apolloState; } catch (e) { st = null; } }
  if (!st && !ld) return null;
  const get = (ref) => (ref && st ? st[ref.__ref || ref] : null);
  const booksIn = st ? Object.entries(st).filter(([k]) => k.startsWith('Book:')).map(([, v]) => v) : [];
  const main = booksIn.find((b) => id && Number(b.legacyId) === id && b.title)
    || booksIn.find((b) => b.title && b.primaryContributorEdge) || null;
  if (main && !id) id = Number(main.legacyId) || null;
  const d = (main && main.details) || {};
  const authors = [];
  if (main) {
    const add = (edge) => { const c = edge && get(edge.node); if (c && c.name && !authors.includes(c.name)) authors.push(c.name.replace(/\s+/g, ' ').trim()); };
    add(main.primaryContributorEdge);
    (main.secondaryContributorEdges || []).forEach((e) => { if (!e.role || /author/i.test(e.role)) add(e); });
  }
  if (!authors.length && ld && ld.author) [].concat(ld.author).forEach((a) => { if (a && a.name) authors.push(String(a.name).trim()); });
  const work = main && get(main.work);
  // The saved page points at its own copy of the cover in the "_files" folder, e.g. "…_files/32725806_H6gw.jpg"
  // (written with %-codes). Its file name tells exactly which picture to use. (20 November 2026)
  let coverName = '';
  if (id) {
    const refs = [...text.matchAll(/(?:src|href)="([^"]*_files\/([^"/]+))"/gi)].map((m) => { try { return decodeURIComponent(m[2]); } catch (e) { return m[2]; } });
    coverName = refs.find((n) => n.startsWith(`${id}_`)) || refs.find((n) => n.startsWith(`${id}.`)) || '';
  }
  const og = text.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) || text.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
  const isbn = d.isbn13 || d.isbn || (ld && ld.isbn) || '';
  return {
    id,
    title: String((main && (main.titleComplete || main.title)) || (ld && ld.name) || '').replace(/\s+/g, ' ').trim(),
    authors,
    description: plainText(main && (main.description || main['description({"stripped":true})'])),
    genres: main ? (main.bookGenres || []).map((g) => g && g.genre && g.genre.name).filter(Boolean) : [],
    pages: Number(d.numPages || (ld && ld.numberOfPages)) || null,
    year: yearOf(work && work.details && work.details.publicationTime) || yearOf(d.publicationTime),
    publisher: d.publisher || '',
    format: d.format || (ld && ld.bookFormat) || '',
    language: (d.language && d.language.name) || (ld && ld.inLanguage) || '',
    isbn: String(isbn || '').replace(/[^0-9Xx]/g, '').toUpperCase(),
    series: main ? (main.bookSeries || []).map((s) => ({ name: String((get(s.series) || {}).title || '').trim(), numbers: positions(s.userPosition) })).filter((s) => s.name) : [],
    editions: booksIn.filter((b) => b !== main && b.details).map((b) => ({
      isbn: String(b.details.isbn || '').toUpperCase(), isbn13: String(b.details.isbn13 || ''), pages: Number(b.details.numPages) || null })),
    cover: (main && main.imageUrl) || (og && decode(og[1])) || (ld && ld.image) || '',
    coverName,
  };
}

// Which dropped picture is the book's cover? Goodreads saves it named after the book number:
// "18690065_qu4W.jpg", plus sized copies like "18690065._SX300__qu4W.jpg". The plain one wins, then the largest.
export function pickCover(files, id, exactName = '') {
  const imgs = files.filter((f) => /^image\//.test(f.type || '') || /\.(jpe?g|png|webp|gif)$/i.test(f.name || ''));
  if (!imgs.length) return null;
  if (exactName) { const hit = imgs.find((f) => String(f.name).normalize('NFC') === exactName.normalize('NFC')); if (hit) return hit; }
  if (id) {
    const mine = imgs.filter((f) => String(f.name).startsWith(`${id}_`) || String(f.name).startsWith(`${id}.`));
    if (mine.length) return mine.find((f) => String(f.name).startsWith(`${id}_`)) || mine.sort((a, b) => (b.size || 0) - (a.size || 0))[0];
  }
  return imgs.length === 1 ? imgs[0] : null;
}
// END-PURE-HELPERS

let hooks = null;        // from admin.js: getBooks, getEditing, handleFile, addGenres, getGenres, toast, openPanel, hasSeries, hasArc, coverShown
let page = null;         // what the dropped page says
let coverFile = null;
let rows = [];           // the preview's lines
let pending = {};        // fields the form has no box for (ISBN), added when the book is saved
let arcPlan = null;      // { name, members: [{ id, no }] }: the contained books join this book's story arc after saving

const val = (id) => ($(id) ? $(id).value.trim() : '');
const singular = (g) => matchKey(g).replace(/s$/, '');

export function gpReset() {
  page = null; coverFile = null; rows = []; pending = {}; arcPlan = null;
  if ($('gp-card')) { $('gp-card').hidden = true; $('gp-card').innerHTML = ''; }
  if ($('gp-drop')) $('gp-drop').hidden = false;
  document.querySelectorAll('.gp-filled').forEach((el) => el.classList.remove('gp-filled'));
}
// Extra fields for the save, and what to do once the book is saved.
export function gpExtra() { return { ...pending }; }
export async function gpAfterSave() {
  if (!arcPlan) return;
  const plan = arcPlan; arcPlan = null;
  for (const m of plan.members) await patchBook(m.id, { arc: plan.name, arc_no: m.no });
  if (plan.members.length) hooks.toast(`${plan.members.length} ${plan.members.length === 1 ? 'book joins' : 'books join'} the story arc “${plan.name}”`);
}

async function readFiles(fileList) {
  const files = [...fileList];
  const htmlFile = files.find((f) => /\.html?$/i.test(f.name) || f.type === 'text/html');
  if (!htmlFile) { coverFile = pickCover(files, page && page.id, page && page.coverName) || coverFile; if (page) render(); else hooks.toast('Drop the saved page (.htm) first, then its cover picture.', true); return; }
  // const parsed = readGoodreadsPage(await htmlFile.text());
  // if (!parsed || !parsed.title) { hooks.toast('That file is not a saved Goodreads book page.', true); return; }
  const html = await htmlFile.text();
  let parsed = null;
  if (/goodreads\.com/i.test(html) && /__NEXT_DATA__/.test(html)) parsed = readGoodreadsPage(html);
  if (parsed) parsed.source = 'goodreads';
  if (!parsed) {
    // a saved Fandom page: read the live page through Fandom's data service, which is far more complete
    const can = (html.match(/<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i) || html.match(/property="og:url"[^>]+content="([^"]+)"/i) || [])[1];
    if (can && fandomAddress(can)) { try { parsed = await readFandomLink(can); } catch (e) { parsed = null; } }
  }
  if (!parsed) parsed = readGenericPage(html);
  if (!parsed || !parsed.title) { hooks.toast('No book details found in that page.', true); return; }
  showPage(parsed, pickCover(files, parsed.id, parsed.coverName));
}

// Every source ends here: tidy the page into one shape, then show the preview.
function showPage(parsed, cover = null) {
  page = { contains: [], containsYear: null, arcName: '', joinVolume: '', editions: [], series: [], genres: [], authors: [], ...parsed };
  // Goodreads: a series entry with several numbers ("কাঁটা #2–6") lists the books this one holds
  if (!page.contains.length) page.series.filter((x) => x.numbers.length > 1).forEach((x) => x.numbers.forEach((n) => page.contains.push({ series: x.name, no: n })));
  coverFile = cover;
  render();
}

// A Fandom link, or text copied from a page (Ctrl+A, Ctrl+C), pasted into the box.
async function readTyped() {
  const box = $('gp-text'); const typed = box.value.trim();
  if (!typed) { hooks.toast('Paste a Fandom link, or the text of a book page.', true); return; }
  const btn = $('gp-read');
  if (/^https?:\/\/\S+$/.test(typed)) {
    btn.disabled = true; btn.textContent = 'Reading\u2026';
    try { showPage(await readFandomLink(typed)); box.value = ''; }
    catch (e) { hooks.toast(e.message || 'Could not read that link.', true); }
    finally { btn.disabled = false; btn.textContent = 'Read'; }
    return;
  }
  const parsed = readPastedText(typed);
  if (!parsed) { hooks.toast('No book details found in that text.', true); return; }
  box.value = '';
  showPage(parsed);
}

// Which of your books does a collection hold? A title, or a series and number ("Batman/Superman" Vol 2 #1).
// When several of your series share the name (Batman/Superman (2013-2016) and (2019-2021)), the one that began
// closest before the collection's year wins.
function resolveMembers(contains, year) {
  const books = hooks.getBooks(); const editing = hooks.getEditing();
  const start = (b) => { const m = String(b.series || b.title).match(/\((\d{4})/); return m ? Number(m[1]) : null; };
  const score = (b) => { const y = start(b); return y == null || !year ? 500 : y <= year ? year - y : 1000 + y - year; };
  return contains.map((c, i) => {
    let cands;
    if (c.title) cands = books.filter((b) => matchKey(b.title) === matchKey(c.title));
    else {
      const key = `${seriesCore(c.series)}#${Number(c.no)}`;
      cands = books.filter((b) => shelfKey(b) === key || (b.series && seriesCore(b.series) === seriesCore(c.series) && Number(b.series_no) === Number(c.no)));
    }
    cands = cands.filter((b) => !editing || b.id !== editing.id).sort((a, b) => score(a) - score(b));
    return { k: i + 1, c, book: cands[0] || null };
  });
}
// A good name for the arc: one your site already uses for it, or written the way your other arcs of that
// series are ('"Batman/Superman" Planet Brainiac'), or, for a Tin Goyenda volume, your volume's own title.
function arcNameFor() {
  const books = hooks.getBooks();
  const arcs = [...new Set(books.map((b) => b.arc).filter(Boolean))];
  const vm = String(page.arcName || page.title).match(/^Volume\s+([\d\u09e6-\u09ef]+(?:\s*\/\s*[\d\u09e6-\u09ef]+)?)$/i);
  if (vm) { const v = siteVolume(vm[1].replace(/\s+/g, '')); if (v) return v; }
  if (page.source === 'goodreads' || page.source === 'text-goodreads' || !page.arcName) return val('f-title') || page.title;
  const same = arcs.find((a) => matchKey(a) === matchKey(page.arcName) || matchKey(a).endsWith(` ${matchKey(page.arcName)}`));
  if (same) return same;
  const first = page.contains.find((c) => c.series);
  if (first && arcs.some((a) => a.startsWith(`"${first.series}" `))) return `"${first.series}" ${page.arcName}`;
  return page.arcName;
}
// Your volume for "2/1": a book or arc named like "তিন গোয়েন্দা ভলিউম ২/১". Returns its name, or ''.
function siteVolume(numbers) {
  const BN = '\u09e6\u09e7\u09e8\u09e9\u09ea\u09eb\u09ec\u09ed\u09ee\u09ef';
  const bnNo = String(numbers).replace(/\d/g, (d) => BN[d]);
  const re = new RegExp(`ভলিউম[\\s-]*(${bnNo.replace('/', '\\s*/\\s*')}|${String(numbers).replace('/', '\\s*/\\s*')})(?![\\d\\u09e6-\\u09ef/])`);
  const books = hooks.getBooks();
  const arc = books.map((b) => b.arc).find((a) => a && re.test(a));
  if (arc) return arc;
  const book = books.find((b) => re.test(b.title));
  return book ? book.title : '';
}

// The site's own spelling of a series, when it already has it.
function siteSeries(name) {
  const k = matchKey(name); const counts = new Map();
  hooks.getBooks().forEach((b) => { if (b.series && matchKey(b.series) === k) counts.set(b.series, (counts.get(b.series) || 0) + 1); });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s)[0] || name;
}

function buildRows() {
  const editing = hooks.getEditing();
  const out = []; const same = [];
  const row = (key, label, show, on, note = '') => out.push({ key, label, show, on, note });
  // cover
  if (coverFile) row('cover', 'Cover', `<span class="gp-cov" id="gp-cov"></span>${esc(coverFile.name)}`, !hooks.coverShown(), hooks.coverShown() ? 'Replaces your current cover.' : 'Your book has no cover yet.');
  else if (/^https:\/\//i.test(page.cover || '')) row('cover-web', 'Cover', `<span class="gp-cov"><img src="${esc(page.cover)}" alt="" referrerpolicy="no-referrer"></span>From the page's web address`, !hooks.coverShown(),
    `${hooks.coverShown() ? 'Replaces your current cover. ' : 'Your book has no cover yet. '}Loaded when you fill the form.${page.coverName ? ` (Or drop <b>${esc(page.coverName)}</b> from the “_files” folder.)` : ''}`);
  else if (page.coverName) out.push({ key: 'cover-missing', label: 'Cover', show: `Drop the cover picture too: <b>${esc(page.coverName)}</b> in the “_files” folder next to the page.`, on: null });
  else if (/^text/.test(page.source || '')) out.push({ key: 'cover-missing', label: 'Cover', show: 'Copied text has no pictures. Drop the cover onto the cover box below, or paste its address there.', on: null });
  // plain text fields
  const text = (key, label, id, value, display = value) => {
    if (!value) return;
    const now = val(id);
    if (!now) row(key, label, esc(display), true, 'Yours is empty.');
    else if (matchKey(now) === matchKey(value)) same.push(label.toLowerCase());
    else row(key, label, esc(display), false, `Yours: “${esc(now.length > 90 ? `${now.slice(0, 90)}…` : now)}”.`);
  };
  text('title', 'Title', 'f-title', page.title);
  const author = page.authors.join(', ');
  if (author) {
    const now = val('f-author');
    const sameAuthor = now && authorsOf(now).map(matchKey).sort().join('|') === page.authors.map(matchKey).sort().join('|');
    if (!now) row('author', 'Author', esc(author), true, 'Yours is empty.');
    else if (sameAuthor) same.push('author');
    else row('author', 'Author', esc(author), false, `Yours: “${esc(now)}”. Names in another script are often the same person.`);
  }
  text('description', 'Description', 'f-description', page.description, page.description.replace(/\n+/g, ' · '));
  // genres
  const have = hooks.getGenres().map(singular);
  const add = page.genres.filter((g) => !have.includes(singular(g)));
  if (add.length) row('genres', 'Genres', add.map((g) => `<span class="gp-chip">${esc(hooks.knownGenre(g))}</span>`).join(''), true, hooks.getGenres().length ? 'Added to the genres you already picked.' : 'Yours has none. Names your site already uses are matched, the rest are added as new.');
  else if (page.genres.length) same.push('genres');
  // pages: watch for another edition
  if (page.pages && $('f-format').value !== 'Audiobook') {
    const now = Number(val('f-pages')) || null;
    const myIsbn = String((editing && editing.isbn) || '').replace(/[^0-9Xx]/g, '').toUpperCase();
    const other = myIsbn && myIsbn !== page.isbn ? page.editions.find((e) => e.isbn13 === myIsbn || e.isbn === myIsbn) : null;
    if (!now) row('pages', 'Pages', String(page.pages), true, 'Yours is empty.');
    else if (now === page.pages) same.push('pages');
    else row('pages', 'Pages', String(page.pages), false, `Yours says ${now}.${other && other.pages ? ` Goodreads lists your ISBN ${myIsbn} as a ${other.pages}-page edition, so yours is probably right.` : ' This page may be another edition.'}`);
  }
  // year
  if (page.year) {
    const now = Number(val('f-year')) || null;
    if (!now) row('year', 'Year', String(page.year), true, `${/goodreads/.test(page.source || '') ? 'First published. ' : ''}Yours is empty.`);
    else if (now === page.year) same.push('publishing year');
    else row('year', 'Year', String(page.year), false, `Yours says ${now}. ${/goodreads/.test(page.source || '') ? 'Goodreads gives' : 'The page gives'} the first publication.`);
  }
  // language: the site has English and Bengali
  if (/^(english|bengali)$/i.test(page.language)) {
    const lang = /^bengali$/i.test(page.language) ? 'Bengali' : 'English';
    if ($('f-language').value === lang) same.push('language');
    else row('language', 'Language', lang, !editing, `The form says ${$('f-language').value}.`);
  }
  // ISBN (no box in the form: saved with the book)
  if (page.isbn) {
    const mine = String((editing && editing.isbn) || '').replace(/[^0-9Xx]/g, '').toUpperCase();
    if (!mine) row('isbn', 'ISBN', page.isbn, true, editing ? 'Yours has none.' : '');
    else if (mine === page.isbn) same.push('ISBN');
  }
  // series and story arc
  if (hooks.hasSeries()) {
    const own = page.series.find((s) => s.numbers.length === 1);
    const also = page.series.filter((s) => s.numbers.length === 1 && s !== own);
    if (own) {
      const name = siteSeries(own.name); const no = own.numbers[0];
      const now = val('f-series'); const nowNo = Number(val('f-series-no'));
      if (!now) row('series', 'Series', `<span class="${bn(name)}">${esc(name)}</span> #${no}`, true, name === own.name && !hooks.getBooks().some((b) => b.series && matchKey(b.series) === matchKey(name)) ? 'Yours has no series. (A new series on your site.)' : 'Yours has no series.');
      else if (matchKey(now) === matchKey(name) && nowNo === no) same.push('series');
      else row('series', 'Series', `<span class="${bn(name)}">${esc(name)}</span> #${no}`, false, `Yours: ${esc(now)}${val('f-series-no') ? ` #${esc(val('f-series-no'))}` : ''}.`);
      if (also.length && out.length && out[out.length - 1].key === 'series') out[out.length - 1].note += ` Also listed in ${also.map((x) => `<span class="${bn(x.name)}">${esc(x.name)}</span> #${x.numbers[0]}`).join(', ')}; a book has one series on your site.`;
    }
  }
  // A collection, volume or omnibus: the books it holds become a story arc, in order (20 November 2026).
  if (hooks.hasArc() && page.contains.length) {
    const name = arcNameFor();
    const res = resolveMembers(page.contains, page.containsYear || page.year);
    const found = res.filter((x) => x.book);
    const free = found.filter((x) => !x.book.arc || (matchKey(x.book.arc) === matchKey(name) && x.book.arc_no == null));
    const done = found.filter((x) => x.book.arc && matchKey(x.book.arc) === matchKey(name) && x.book.arc_no != null);
    const busy = found.filter((x) => x.book.arc && matchKey(x.book.arc) !== matchKey(name));
    const missing = res.filter((x) => !x.book);
    const label = (x) => (x.c.title ? x.c.title : `${x.c.series} #${x.c.no}`);
    const notes = [
      free.length ? `${free.length} of the ${res.length} on your shelf join it, in this order: ${free.map((x) => `<span class="${bn(x.book.title)}">${esc(x.book.title)}</span> (part ${x.k})`).join(', ')}.` : '',
      done.length ? `${done.length} already in it.` : '',
      busy.length ? `Left as they are, already in another arc: ${busy.map((x) => `<span class="${bn(x.book.title)}">${esc(x.book.title)}</span> (${esc(x.book.arc)})`).join(', ')}.` : '',
      missing.length ? `Not on your shelf: ${missing.slice(0, 8).map((x) => `<span class="${bn(label(x))}">${esc(label(x))}</span>`).join(', ')}${missing.length > 8 ? '\u2026' : ''}.` : '',
    ].filter(Boolean).join(' ');
    const fromWiki = /^fandom/.test(page.source || '');
    const now = val('f-arc');
    row('arc', 'Story arc', `Holds ${res.length} ${res.length === 1 ? 'book' : 'books'}. Make a story arc named <input class="gp-arcname" id="gp-arcname" type="text" value="${esc(name)}" aria-label="Story arc name">`,
      fromWiki && free.length > 0 && (!now || matchKey(now) === matchKey(name)), `${notes}${now && matchKey(now) !== matchKey(name) ? ` This book is now in the arc “${esc(now)}”; ticking this changes it.` : ''}`);
    out[out.length - 1].members = free.map((x) => ({ id: x.book.id, no: x.k }));
  }
  // Tin Goyenda: the volume this book was republished in
  if (hooks.hasArc() && page.joinVolume) {
    const vol = siteVolume(page.joinVolume);
    const now = val('f-arc');
    if (vol && (!now || matchKey(now) !== matchKey(vol))) row('arc-join', 'Story arc', `<span class="${bn(vol)}">${esc(vol)}</span>`, !now, `Republished in Volume ${esc(page.joinVolume)}.${now ? ` Yours: “${esc(now)}”.` : ''} Its part number can be set in the form.`);
    else if (!vol) out.push({ key: 'arc-none', label: 'Story arc', show: `Republished in Volume ${esc(page.joinVolume)}, which is not on your shelf yet.`, on: null });
  }
  if (false) {
    const holds = page.series.find((s) => s.numbers.length > 1);
    if (holds) {
      const name = siteSeries(holds.name);
      const found = holds.numbers.map((n, i) => ({ n, k: i + 1, b: hooks.getBooks().find((x) => x.series && matchKey(x.series) === matchKey(name) && Number(x.series_no) === n && !x.arc && (!editing || x.id !== editing.id)) })).filter((x) => x.b);
      const title = val('f-title') || page.title;
      row('arc', 'Story arc', `Also contains <span class="${bn(name)}">${esc(name)}</span> #${holds.numbers.join(', ')}: make “<span class="${bn(title)}">${esc(title)}</span>” a story arc holding them`, false,
        found.length ? `${found.length} of the ${holds.numbers.length} ${found.length === 1 ? 'is' : 'are'} on your shelf: ${found.map((x) => `<span class="${bn(x.b.title)}">${esc(x.b.title)}</span> (#${x.n})`).join(', ')}. The same way as your তিন গোয়েন্দা volumes.` : 'None of them are on your shelf yet; the arc starts with this book.');
      out[out.length - 1].members = found.map((x) => ({ id: x.b.id, no: x.k }));
      out[out.length - 1].arcName = title;
    }
  }
  return { out, same };
}

function render() {
  const editing = hooks.getEditing();
  const built = buildRows(); rows = built.out;
  const ticked = () => rows.filter((r) => r.on).length;
  // adding a book that is already on the shelf?
  let dup = '';
  if (!editing) {
    const isbn = page.isbn; const t = matchKey(page.title); const who = page.authors.map(matchKey);
    const hit = hooks.getBooks().find((b) => (isbn && String(b.isbn || '').toUpperCase() === isbn)
      || (matchKey(b.title) === t && (!who.length || authorsOf(b.author).some((a) => who.includes(matchKey(a))))));
    if (hit) dup = `<div class="gp-dup">“<span class="${bn(hit.title)}">${esc(hit.title)}</span>” is already on your shelf. <button class="btn" type="button" data-gp="open" data-gp-id="${esc(hit.id)}">Edit that book instead</button></div>`;
  }
  const facts = [page.authors.join(', '), page.format, page.pages ? `${page.pages} pages` : '', page.publisher, page.year].filter(Boolean).join(' · ');
  $('gp-card').innerHTML = `
    <div class="gp-top"><span class="gp-cov gp-cov-top" id="gp-cov-top"></span><span><b class="${bn(page.title)}">${esc(page.title)}</b>${esc(facts)}<br>Tick what to copy into the form. Nothing is saved until you press Save book.</span></div>
    ${dup}
    ${rows.map((r, i) => `<label class="gp-row">${r.on === null ? '<span></span>' : `<input type="checkbox" data-gp-i="${i}"${r.on ? ' checked' : ''}>`}<span class="gp-k">${r.label}</span><span class="gp-v">${r.show}${r.note ? `<small>${r.note}</small>` : ''}</span></label>`).join('')}
    ${built.same.length ? `<div class="gp-same">Already the same: ${esc(built.same.join(', '))}.</div>` : ''}
    <div class="gp-act">${issuesButton()}<button class="btn" type="button" data-gp="cancel">Cancel</button><button class="btn primary" type="button" data-gp="fill" id="gp-fill"></button></div>`;
  const label = () => { const n = ticked(); $('gp-fill').textContent = n ? `Fill the form with ${n} ticked ${n === 1 ? 'item' : 'items'}` : 'Nothing ticked'; $('gp-fill').disabled = !n; };
  label();
  $('gp-card').onchange = (e) => { const i = e.target.dataset.gpI; if (i !== undefined) { rows[Number(i)].on = e.target.checked; label(); } };
  if (coverFile) {
    const url = URL.createObjectURL(coverFile);
    ['gp-cov', 'gp-cov-top'].forEach((id) => { if ($(id)) $(id).innerHTML = `<img src="${url}" alt="">`; });
  } else if (/^https:\/\//i.test(page.cover || '') && $('gp-cov-top')) $('gp-cov-top').innerHTML = `<img src="${esc(page.cover)}" alt="" referrerpolicy="no-referrer">`;
  $('gp-card').hidden = false;
  $('gp-card').scrollIntoView({ block: 'nearest' });
}

// A Fandom collection or volume: a button that reads every book it holds (collection-import.js).
function issuesButton() {
  const at = page && page.link ? fandomAddress(page.link) : null;
  if (!at || !page.contains.length) return '';
  const word = page.contains.some((c) => c.series) ? 'issue' : 'book';
  return `<button class="btn gp-issues" type="button" data-gp="issues">Get its ${page.contains.length} ${page.contains.length === 1 ? word : `${word}s`}</button>`;
}

async function fill() {
  const set = (id, v) => { if ($(id)) { $(id).value = v; $(id).classList.add('gp-filled'); $(id).dispatchEvent(new Event('input', { bubbles: true })); } };
  let n = 0;
  for (const r of rows.filter((x) => x.on)) {
    n += 1;
    if (r.key === 'cover' && coverFile) await hooks.handleFile(coverFile);
    if (r.key === 'cover-web') await hooks.handleImageUrl(page.cover);
    if (r.key === 'title') set('f-title', page.title);
    if (r.key === 'author') set('f-author', page.authors.join(', '));
    if (r.key === 'description') set('f-description', page.description);
    if (r.key === 'genres') hooks.addGenres(page.genres);
    if (r.key === 'pages') set('f-pages', String(page.pages));
    if (r.key === 'year') set('f-year', String(page.year));
    if (r.key === 'language') { $('f-language').value = /^bengali$/i.test(page.language) ? 'Bengali' : 'English'; $('f-language').classList.add('gp-filled'); }
    if (r.key === 'isbn') pending.isbn = page.isbn;
    if (r.key === 'series') { const s = page.series.find((x) => x.numbers.length === 1); set('f-series', siteSeries(s.name)); set('f-series-no', String(s.numbers[0])); }
    // if (r.key === 'arc') { set('f-arc', r.arcName); set('f-arc-no', ''); arcPlan = { name: r.arcName, members: r.members || [] }; }
    if (r.key === 'arc') {
      const name = ($('gp-arcname') ? $('gp-arcname').value : '').replace(/\s+/g, ' ').trim();
      if (name) { set('f-arc', name); set('f-arc-no', ''); arcPlan = { name, members: r.members || [] }; }
    }
    if (r.key === 'arc-join') { set('f-arc', page.joinVolume ? siteVolume(page.joinVolume) : ''); }
  }
  $('gp-card').hidden = true;
  hooks.toast(`Filled ${n} ${n === 1 ? 'item' : 'items'}. Check the form, then press Save book.`);
}

export function initGoodreadsPage(h) {
  hooks = h;
  const drop = $('gp-drop'); const input = $('gp-file');
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', () => { readFiles(input.files); input.value = ''; });
  $('gp-read').addEventListener('click', readTyped);
  $('gp-text').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey || !e.target.value.includes('\n') && /^https?:\/\//.test(e.target.value.trim()))) { e.preventDefault(); readTyped(); } });
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  // drop.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files.length) readFiles(e.dataTransfer.files); });
  // A dropped folder (the "_files" folder next to the page) is opened and its pictures are used too.
  drop.addEventListener('drop', async (e) => {
    const dt = e.dataTransfer; if (!dt) return;
    const entries = [...(dt.items || [])].map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null)).filter(Boolean);
    if (!entries.some((en) => en.isDirectory)) { if (dt.files.length) readFiles(dt.files); return; }
    const files = [];
    const walk = async (en, depth) => {
      if (en.isFile) { files.push(await new Promise((ok, bad) => en.file(ok, bad))); return; }
      if (!en.isDirectory || depth > 2) return;
      const reader = en.createReader();
      for (;;) { const batch = await new Promise((ok, bad) => reader.readEntries(ok, bad)); if (!batch.length) break; for (const c of batch) await walk(c, depth + 1); }
    };
    try { for (const en of entries) await walk(en, 0); } catch (err) { console.error(err); }
    readFiles(files);
  });
  $('gp-card').addEventListener('click', (e) => {
    if (onIssuesClick(e.target)) return;
    const b = e.target.closest('[data-gp]'); if (!b) return;
    if (b.dataset.gp === 'issues') {
      const name = ($('gp-arcname') ? $('gp-arcname').value : '').replace(/\s+/g, ' ').trim() || arcNameFor();
      const kept = { page, coverFile };
      openIssues({ host: fandomAddress(page.link).host, page, arcName: () => name, hooks, back: () => { page = kept.page; coverFile = kept.coverFile; render(); } });
      return;
    }
    if (b.dataset.gp === 'cancel') { $('gp-card').hidden = true; }
    if (b.dataset.gp === 'fill') fill();
    if (b.dataset.gp === 'open') {
      const book = hooks.getBooks().find((x) => String(x.id) === b.dataset.gpId);
      const keep = { page, coverFile };
      if (book) { hooks.openPanel(book); page = keep.page; coverFile = keep.coverFile; render(); }
    }
  });
}
