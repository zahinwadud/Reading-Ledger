// Dashboard: "Fill from a saved Goodreads page" in the Add / Edit Book form (added 19 November 2026).
// Save a Goodreads book page with Ctrl+S ("Webpage, Complete") and drop the .htm file, with its cover picture
// from the "_files" folder, onto the box at the top of the form. The page is read here, in this browser:
// nothing is fetched from Goodreads. A preview shows what the page has next to what the form has; ticked
// items are copied into the form, and nothing is saved until you press Save book.
import { patchBook, esc, authorsOf } from './api.js';
import { matchKey } from './series-list.js';

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
    cover: (main && main.imageUrl) || (ld && ld.image) || '',
  };
}

// Which dropped picture is the book's cover? Goodreads saves it named after the book number:
// "18690065_qu4W.jpg", plus sized copies like "18690065._SX300__qu4W.jpg". The plain one wins, then the largest.
export function pickCover(files, id) {
  const imgs = files.filter((f) => /^image\//.test(f.type || '') || /\.(jpe?g|png|webp|gif)$/i.test(f.name || ''));
  if (!imgs.length) return null;
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
  if (!htmlFile) { coverFile = pickCover(files, page && page.id) || coverFile; if (page) render(); else hooks.toast('Drop the saved page (.htm) first, then its cover picture.', true); return; }
  const parsed = readGoodreadsPage(await htmlFile.text());
  if (!parsed || !parsed.title) { hooks.toast('That file is not a saved Goodreads book page.', true); return; }
  page = parsed;
  coverFile = pickCover(files, page.id);
  render();
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
  else out.push({ key: 'cover-missing', label: 'Cover', show: `Drop the cover picture too. In the “_files” folder it is the file starting with <b>${esc(page.id || '')}</b>.`, on: null });
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
    if (!now) row('year', 'Year', String(page.year), true, 'First published. Yours is empty.');
    else if (now === page.year) same.push('publishing year');
    else row('year', 'Year', String(page.year), false, `Yours says ${now}. Goodreads gives the first publication.`);
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
    if (own) {
      const name = siteSeries(own.name); const no = own.numbers[0];
      const now = val('f-series'); const nowNo = Number(val('f-series-no'));
      if (!now) row('series', 'Series', `<span class="${bn(name)}">${esc(name)}</span> #${no}`, true, name === own.name && !hooks.getBooks().some((b) => b.series && matchKey(b.series) === matchKey(name)) ? 'Yours has no series. (A new series on your site.)' : 'Yours has no series.');
      else if (matchKey(now) === matchKey(name) && nowNo === no) same.push('series');
      else row('series', 'Series', `<span class="${bn(name)}">${esc(name)}</span> #${no}`, false, `Yours: ${esc(now)}${val('f-series-no') ? ` #${esc(val('f-series-no'))}` : ''}.`);
    }
  }
  if (hooks.hasArc() && !val('f-arc')) {
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
    <div class="gp-act"><button class="btn" type="button" data-gp="cancel">Cancel</button><button class="btn primary" type="button" data-gp="fill" id="gp-fill"></button></div>`;
  const label = () => { const n = ticked(); $('gp-fill').textContent = n ? `Fill the form with ${n} ticked ${n === 1 ? 'item' : 'items'}` : 'Nothing ticked'; $('gp-fill').disabled = !n; };
  label();
  $('gp-card').onchange = (e) => { const i = e.target.dataset.gpI; if (i !== undefined) { rows[Number(i)].on = e.target.checked; label(); } };
  if (coverFile) {
    const url = URL.createObjectURL(coverFile);
    ['gp-cov', 'gp-cov-top'].forEach((id) => { if ($(id)) $(id).innerHTML = `<img src="${url}" alt="">`; });
  }
  $('gp-card').hidden = false;
  $('gp-card').scrollIntoView({ block: 'nearest' });
}

async function fill() {
  const set = (id, v) => { if ($(id)) { $(id).value = v; $(id).classList.add('gp-filled'); $(id).dispatchEvent(new Event('input', { bubbles: true })); } };
  let n = 0;
  for (const r of rows.filter((x) => x.on)) {
    n += 1;
    if (r.key === 'cover' && coverFile) await hooks.handleFile(coverFile);
    if (r.key === 'title') set('f-title', page.title);
    if (r.key === 'author') set('f-author', page.authors.join(', '));
    if (r.key === 'description') set('f-description', page.description);
    if (r.key === 'genres') hooks.addGenres(page.genres);
    if (r.key === 'pages') set('f-pages', String(page.pages));
    if (r.key === 'year') set('f-year', String(page.year));
    if (r.key === 'language') { $('f-language').value = /^bengali$/i.test(page.language) ? 'Bengali' : 'English'; $('f-language').classList.add('gp-filled'); }
    if (r.key === 'isbn') pending.isbn = page.isbn;
    if (r.key === 'series') { const s = page.series.find((x) => x.numbers.length === 1); set('f-series', siteSeries(s.name)); set('f-series-no', String(s.numbers[0])); }
    if (r.key === 'arc') { set('f-arc', r.arcName); set('f-arc-no', ''); arcPlan = { name: r.arcName, members: r.members || [] }; }
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
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files.length) readFiles(e.dataTransfer.files); });
  $('gp-card').addEventListener('click', (e) => {
    const b = e.target.closest('[data-gp]'); if (!b) return;
    if (b.dataset.gp === 'cancel') { $('gp-card').hidden = true; }
    if (b.dataset.gp === 'fill') fill();
    if (b.dataset.gp === 'open') {
      const book = hooks.getBooks().find((x) => String(x.id) === b.dataset.gpId);
      const keep = { page, coverFile };
      if (book) { hooks.openPanel(book); page = keep.page; coverFile = keep.coverFile; render(); }
    }
  });
}
