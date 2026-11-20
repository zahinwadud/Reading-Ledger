// Book form → Fill from a web page → "Get its issues" (added 21 November 2026).
// A Fandom collection (a DC Database collected edition, a Tin Goyenda volume) lists the books it holds.
// This reads all of their wiki pages at once (50 per request, through the wiki's public api.php), shows them
// in a list with cover, date, writers and stories, and adds the new ones / fills what the ones you have lack.
// Nothing is saved until you press the save button. Covers are copied into your own covers storage.
import { importBooks, patchBook, uploadCover, esc, authorsOf } from './api.js';
import { readWikiText } from './web-reader.js';
import { seriesCore, shelfKey } from './comics.js';
import { matchKey } from './series-list.js';

const $ = (id) => document.getElementById(id);
const bn = (t) => (/[ঀ-৿]/.test(t || '') ? 'bn' : '');
const plural = (n, one, many) => `${Number(n).toLocaleString()} ${n === 1 ? one : many}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const BATCH = 50;                       // the wiki's own limit per request
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// START-PURE-HELPERS
// The wiki page that describes one item of a collection.
export const wikiTitleOf = (c) => (c.title ? c.title : `${c.series} Vol ${c.vol} ${c.no}`);
const keyOf = (t) => String(t || '').replace(/_/g, ' ').trim().normalize('NFC');
// Split a list into groups of n.
export const chunks = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));
// The month an issue went on sale, from its wiki text ("| Month = 5").
export const monthOf = (w) => { const m = String(w || '').match(/\|\s*Month\s*=\s*(\d{1,2})\b/); return m ? Number(m[1]) : null; };
// END-PURE-HELPERS

// Fetch the wiki text of many pages: Map(page title -> wikitext). Follows redirects. onStep(done, total).
async function fetchPages(host, titles, onStep) {
  const out = new Map(); let done = 0;
  for (const group of chunks(titles, BATCH)) {
    const url = `https://${host}/api.php?${new URLSearchParams({ action: 'query', prop: 'revisions', rvprop: 'content', rvslots: 'main', redirects: '1', format: 'json', origin: '*', titles: group.join('|') })}`;
    let data = null;
    for (let attempt = 0; attempt < 3 && !data; attempt += 1) {
      try { const res = await fetch(url); if (res.ok) data = await res.json(); else await sleep(1500 * (attempt + 1)); } catch (e) { await sleep(1500 * (attempt + 1)); }
    }
    if (!data || !data.query) throw new Error('The wiki did not answer. Try again in a minute.');
    // the names we asked for -> the names the wiki uses (spaces, redirects)
    const alias = new Map();
    [...(data.query.normalized || []), ...(data.query.redirects || [])].forEach((x) => alias.set(keyOf(x.from), keyOf(x.to)));
    const byTitle = new Map(Object.values(data.query.pages || {}).map((p) => [keyOf(p.title), p]));
    group.forEach((t) => {
      let k = keyOf(t); for (let i = 0; i < 3 && alias.has(k); i += 1) k = alias.get(k);
      const p = byTitle.get(k);
      const w = p && p.revisions && p.revisions[0] && ((p.revisions[0].slots && p.revisions[0].slots.main && p.revisions[0].slots.main['*']) || p.revisions[0]['*']);
      out.set(keyOf(t), w ? { title: p.title, wikitext: w } : null);
    });
    done += group.length; onStep(done, titles.length);
    await sleep(300);                     // be gentle with the wiki
  }
  return out;
}
// The address of each cover picture: Map(file name -> url).
async function fetchImageUrls(host, files) {
  const out = new Map();
  for (const group of chunks([...new Set(files.filter(Boolean))], BATCH)) {
    try {
      const url = `https://${host}/api.php?${new URLSearchParams({ action: 'query', prop: 'imageinfo', iiprop: 'url', format: 'json', origin: '*', titles: group.map((f) => `File:${f}`).join('|') })}`;
      const data = await (await fetch(url)).json();
      const alias = new Map((data.query.normalized || []).map((x) => [keyOf(x.from), keyOf(x.to)]));
      const pages = new Map(Object.values(data.query.pages || {}).map((p) => [keyOf(p.title), p]));
      group.forEach((f) => { const k = keyOf(`File:${f}`); const p = pages.get(alias.get(k) || k); const u = p && p.imageinfo && p.imageinfo[0] && p.imageinfo[0].url; if (u) out.set(keyOf(f), u); });
    } catch (e) { /* no covers for this group: shown as missing */ }
    await sleep(300);
  }
  return out;
}

let ctx = null;        // { host, page, arcName, hooks, back, isNew }
let rows = [];
let seriesMap = new Map();   // "Detective Comics|1" -> name on your site
let busy = false;

const startYear = (b) => { const m = String(b.series || b.title).match(/\((\d{4})/); return m ? Number(m[1]) : null; };
// Your spelling of a DC series ("Detective Comics" Vol 1, issues from 2021 -> "Detective Comics (2016-)").
// The years in a series name like "Aquaman (2011-)" or "Batman (1940-2011)", or null when it has none.
function yearsOf(name) {
  const m = String(name || '').match(/\((\d{4})\s*[-\u2013]\s*(\d{4})?\s*\)\s*$/);
  return m ? { from: Number(m[1]), to: m[2] ? Number(m[2]) : null } : null;
}
// Can an issue from this year belong to that series? (A year early is allowed, for cover dates.)
function fits(name, year) {
  const y = yearsOf(name);
  if (!y || !year) return true;
  return year >= y.from - 1 && year <= (y.to == null ? 9999 : y.to);
}
// Your series name for a wiki series. Only one whose years fit; otherwise a new name with the start year.
// (Before 21 November 2026 it took the closest one even when the years didn't fit, so Aquaman Vol 5 from 1994 went to "Aquaman (2011-)".)
function siteSeriesFor(series, year) {
  const books = ctx.hooks.getBooks();
  const names = new Map();
  books.forEach((b) => { if (b.series && seriesCore(b.series) === seriesCore(series)) names.set(b.series, (names.get(b.series) || 0) + 1); });
  if (!names.size) return series;
  const dated = [...names.keys()].filter((n) => yearsOf(n));
  const fitting = dated.filter((n) => fits(n, year));
  if (fitting.length) return fitting.sort((a, b) => Math.abs(yearsOf(a).from - year) - Math.abs(yearsOf(b).from - year))[0];
  const plain = [...names.keys()].filter((n) => !yearsOf(n));
  if (plain.length && !dated.length) return plain.sort((a, b) => names.get(b) - names.get(a))[0];
  return year ? `${series} (${year}-)` : series;
}
// Is this item already on your shelf? (A title, or a series and number.)
function findOnShelf(r) {
  const books = ctx.hooks.getBooks(); const editing = ctx.hooks.getEditing();
  let cands;
  if (r.kind === 'title') cands = books.filter((b) => matchKey(b.title) === matchKey(r.title));
  else {
    const name = seriesMap.get(r.mapKey) || r.series;
    const key = `${seriesCore(name)}#${r.no}`;
    cands = books.filter((b) => shelfKey(b) === key || (b.series && seriesCore(b.series) === seriesCore(name) && Number(b.series_no) === Number(r.no)));
    const exact = cands.filter((b) => b.series === name);
    // Not the same series name: only one whose years fit this issue (Aquaman #5 from 1994 is not "Aquaman (2011-)" #5).
    cands = exact.length ? exact : cands.filter((b) => !b.series || (fits(b.series, r.year || ctx.page.year) && (!yearsOf(name) || !yearsOf(b.series))));
  }
  cands = cands.filter((b) => !editing || b.id !== editing.id);
  return cands[0] || null;
}

export async function openIssues(c) {
  ctx = c; rows = []; seriesMap = new Map();
  const items = ctx.page.contains;
  const word = items.some((x) => x.series) ? 'issues' : 'books';
  const card = $('gp-card');
  card.innerHTML = `<div class="gi-wrap"><p><b>Reading ${plural(items.length, word.slice(0, -1), word)} from the wiki…</b></p><div class="progress"><i id="gi-bar"></i></div><p class="hint" id="gi-msg"></p></div>`;
  card.hidden = false;
  try {
    const titles = items.map(wikiTitleOf);
    const pages = await fetchPages(ctx.host, titles, (d, t) => { $('gi-bar').style.width = `${Math.round((d / t) * 100)}%`; $('gi-msg').textContent = `${d} of ${t} pages read`; });
    rows = items.map((it, i) => {
      const got = pages.get(keyOf(wikiTitleOf(it)));
      const p = got ? readWikiText(ctx.host, got.title, got.wikitext) : null;
      const base = { k: i + 1, item: it, found: Boolean(p), sel: true };
      if (it.series) {
        return { ...base, kind: 'issue', series: it.series, vol: it.vol, no: Number(it.no), mapKey: `${it.series}|${it.vol}`,
          year: p ? p.year : null, month: got ? monthOf(got.wikitext) : null, authors: p ? p.authors : [], description: p ? p.description : '',
          stories: p ? (p.description.split('\n\n')[0] || '') : '', imageFile: p ? p.imageFile : '', title: '' };
      }
      return { ...base, kind: 'title', title: p ? p.title : it.title, year: p ? p.year : null, month: null, authors: p ? p.authors : [],
        description: p ? p.description : '', stories: '', imageFile: p ? p.imageFile : '', seriesName: p && p.series[0] ? p.series[0].name : '',
        seriesNo: p && p.series[0] ? p.series[0].numbers[0] : null, genres: p ? p.genres : [], language: p ? p.language : '' };
    });
    // one name on your site per DC series in the list
    const firstYear = new Map(); // the earliest year in each wiki series, for its name on your site
    rows.filter((r) => r.kind === 'issue').forEach((r) => { const y = r.year || ctx.page.year; const was = firstYear.get(r.mapKey); firstYear.set(r.mapKey, y && (!was || y < was) ? y : (was || null)); });
    rows.filter((r) => r.kind === 'issue').forEach((r) => { if (!seriesMap.has(r.mapKey)) seriesMap.set(r.mapKey, siteSeriesFor(r.series, firstYear.get(r.mapKey))); });
    $('gi-msg').textContent = 'Finding the covers…';
    const urls = await fetchImageUrls(ctx.host, rows.map((r) => r.imageFile));
    rows.forEach((r) => { r.cover = urls.get(keyOf(r.imageFile)) || ''; });
    list();
  } catch (err) {
    card.innerHTML = `<div class="gi-wrap"><p class="err">${esc(err.message || 'Could not read the wiki.')}</p><div class="gp-act"><button class="btn" type="button" data-gi="back">← Back</button></div></div>`;
  }
}

// What one row would do: new, fill some fields, nothing, or not on the wiki.
function plan(r) {
  if (!r.found) return { state: 'missing', text: 'No page for it on the wiki' };
  const b = findOnShelf(r);
  r.existing = b;
  if (!b) return { state: 'new', text: 'New' };
  const arc = arcChoice();
  const adds = [];
  if (!b.cover_path && !b.cover_url && r.cover && $('gi-covers') && $('gi-covers').checked) adds.push('cover');
  if (arc && (!b.arc || (b.arc === arc && b.arc_no == null))) adds.push(b.arc ? 'arc part number' : 'story arc');
  if (!b.series && r.kind === 'issue') adds.push('series');
  if (!b.description && r.description) adds.push('description');
  if (!b.pub_year && r.year) adds.push('year');
  if ((!b.author || /^unknown$/i.test(b.author)) && r.authors.length) adds.push('writer');
  const note = b.arc && arc && b.arc !== arc ? ` (already in the arc “${b.arc}”, left as it is)` : '';
  return adds.length ? { state: 'fill', text: `On your shelf: adds ${adds.join(', ')}${note}`, adds } : { state: 'have', text: `On your shelf, nothing to add${note}` };
}
const arcChoice = () => ($('gi-arc') && $('gi-arc').checked ? ctx.arcName() : '');
const dateText = (r) => [r.month ? MONTHS[r.month - 1] : '', r.year || ''].filter(Boolean).join(' ');
const nameOf = (r) => (r.kind === 'issue' ? `${seriesMap.get(r.mapKey) || r.series} #${r.no}` : r.title);

function list() {
  const card = $('gp-card');
  const isIssues = rows.some((r) => r.kind === 'issue');
  const arc = ctx.arcName();
  const maps = [...seriesMap.entries()].map(([k, v]) => { const [s, vol] = k.split('|'); return `<label class="gi-map"><span>${esc(s)} Vol ${esc(vol)} →</span><input type="text" data-gi-map="${esc(k)}" value="${esc(v)}" aria-label="Series name on your site for ${esc(s)} Vol ${esc(vol)}"></label>`; }).join('');
  card.innerHTML = `<div class="gi-wrap">
    <p class="gi-title"><b>${plural(rows.length, isIssues ? 'issue' : 'book', isIssues ? 'issues' : 'books')} in “<span class="${bn(ctx.page.title)}">${esc(ctx.page.title)}</span>”</b></p>
    ${maps ? `<div class="gi-maps"><p class="hint">Series name on your site. Titles become “name #number”.</p>${maps}</div>` : ''}
    <div class="gi-opts">
      ${arc ? `<label class="imp-opt"><input type="checkbox" id="gi-arc" checked><span>Put them in the story arc “<span class="${bn(arc)}">${esc(arc)}</span>” as parts 1–${rows.length}<span class="hint">Books already in another arc are left as they are.</span></span></label>` : ''}
      <label class="imp-opt"><input type="checkbox" id="gi-covers" checked><span>Save their covers<span class="hint">A copy of each cover is stored with your books, like a cover you drop in the form.</span></span></label>
      <div class="gi-sel"><label>New ones are <select id="gi-status"><option value="want">Want to Read</option><option value="reading">Currently Reading</option><option value="read">Read</option></select></label>
        <label>and <select id="gi-own"><option value="buy">Want to Buy</option><option value="owned">Owned</option></select></label></div>
    </div>
    <div class="gi-head"><span id="gi-count"></span><span><button class="linkbtn" type="button" data-gi="all">Tick all</button> · <button class="linkbtn" type="button" data-gi="none">Untick all</button></span></div>
    <ol class="gi-list" id="gi-list"></ol>
    <div id="gi-prog" class="gi-prog" hidden><div class="progress"><i id="gi-bar2"></i></div><p class="hint" id="gi-msg2"></p></div>
    <div class="gp-act"><button class="btn" type="button" data-gi="back">← Back</button><button class="btn primary" type="button" data-gi="save" id="gi-save"></button></div>
  </div>`;
  card.onchange = onChange;
  drawRows();
}

function drawRows() {
  rows.forEach((r) => { r.plan = plan(r); if (r.plan.state === 'have' || r.plan.state === 'missing') r.sel = false; });
  $('gi-list').innerHTML = rows.map((r, i) => {
    const off = r.plan.state === 'have' || r.plan.state === 'missing';
    const who = r.authors.slice(0, 3).join(', ') + (r.authors.length > 3 ? '…' : '');
    return `<li class="gi-row${off ? ' off' : ''}"><label>
      <input type="checkbox" data-gi-i="${i}"${r.sel ? ' checked' : ''}${off ? ' disabled' : ''}>
      <span class="gi-cov">${r.cover ? `<img src="${esc(r.cover)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}</span>
      <span class="gi-info"><b class="${bn(nameOf(r))}">${esc(nameOf(r))}</b>
        <span class="hint">${esc([`Part ${r.k}`, dateText(r), who].filter(Boolean).join(' · '))}</span>
        ${r.stories ? `<span class="hint gi-st">${esc(r.stories)}</span>` : ''}
        <span class="gi-state gi-${r.plan.state}">${esc(r.plan.text)}${r.found && !r.cover ? ' · no cover on the wiki' : ''}</span></span>
    </label></li>`;
  }).join('');
  count();
}
function count() {
  const n = rows.filter((r) => r.sel).length;
  const nNew = rows.filter((r) => r.sel && r.plan.state === 'new').length;
  $('gi-count').textContent = `${n} of ${rows.length} ticked`;
  $('gi-save').textContent = n ? `Save ${[nNew ? `${nNew} new` : '', n - nNew ? `${n - nNew} to update` : ''].filter(Boolean).join(' and ')}` : 'Nothing ticked';
  $('gi-save').disabled = !n || busy;
}
function onChange(e) {
  const t = e.target;
  if (t.dataset.giI !== undefined) { rows[Number(t.dataset.giI)].sel = t.checked; count(); return; }
  if (t.dataset.giMap !== undefined) { seriesMap.set(t.dataset.giMap, t.value.replace(/\s+/g, ' ').trim() || t.dataset.giMap.split('|')[0]); rows.forEach((r) => { r.sel = true; }); drawRows(); return; }
  if (t.id === 'gi-arc' || t.id === 'gi-covers') { rows.forEach((r) => { if (r.plan.state !== 'missing') r.sel = true; }); drawRows(); }
}

// A cover from the wiki, made into the same small picture the form makes, stored with your books.
async function saveCover(url) {
  const res = await fetch(url, { referrerPolicy: 'no-referrer' });
  if (!res.ok) throw new Error('cover');
  const blob = await res.blob();
  if (!/^image\//.test(blob.type)) throw new Error('cover');
  const small = await ctx.hooks.processImage(new File([blob], 'cover', { type: blob.type }));
  return uploadCover(small);
}

async function save() {
  if (busy) return;
  const todo = rows.filter((r) => r.sel && (r.plan.state === 'new' || r.plan.state === 'fill'));
  if (!todo.length) return;
  const arc = arcChoice(); const covers = $('gi-covers').checked;
  const status = $('gi-status').value; const ownership = $('gi-own').value;
  const nNew = todo.filter((r) => r.plan.state === 'new').length;
  if (!confirm(`Add ${plural(nNew, 'new book', 'new books')} and update ${plural(todo.length - nNew, 'book', 'books')}${covers ? ', with their covers' : ''}? This saves straight away.`)) return;
  busy = true; count();
  $('gi-prog').hidden = false;
  let done = 0, coverFails = 0, failed = null;
  const step = (msg) => { done += 1; $('gi-bar2').style.width = `${Math.round((done / todo.length) * 100)}%`; $('gi-msg2').textContent = `${msg} ${done} of ${todo.length}`; };
  const newRows = [];
  const queue = todo.slice();
  const worker = async () => {
    while (queue.length && !failed) {
      const r = queue.shift();
      let coverPath = null;
      const b = r.existing;
      if (covers && r.cover && (!b || (!b.cover_path && !b.cover_url))) { try { coverPath = await saveCover(r.cover); } catch (e) { coverFails += 1; } }
      const series = r.kind === 'issue' ? (seriesMap.get(r.mapKey) || r.series) : r.seriesName || null;
      const seriesNo = r.kind === 'issue' ? r.no : r.seriesNo;
      if (!b) {
        newRows.push({
          id: crypto.randomUUID(), title: nameOf(r), author: r.authors.join(', ') || 'Unknown',
          pub_year: r.year || null, pages: null, duration: null,
          language: r.kind === 'issue' ? 'English' : (r.language || (bn(r.title) ? 'Bengali' : 'English')), format: 'Book',
          status, ownership, youtube_url: null, description: r.description || null,
          genres: r.kind === 'issue' ? ['Comics'] : (r.genres || []), copies: [], finished_at: null, isbn: null,
          cover_url: null, cover_path: coverPath,
          ...(ctx.hooks.hasSeries() ? { series: series || null, series_no: series ? seriesNo : null } : {}),
          ...(ctx.hooks.hasArc() ? { arc: arc || null, arc_no: arc ? r.k : null } : {}),
        });
        step('Prepared');
      } else {
        const patch = {};
        if (coverPath) patch.cover_path = coverPath;
        if (arc && (!b.arc || (b.arc === arc && b.arc_no == null))) { patch.arc = arc; patch.arc_no = r.k; }
        if (!b.series && r.kind === 'issue' && ctx.hooks.hasSeries()) { patch.series = series; patch.series_no = seriesNo; }
        if (!b.description && r.description) patch.description = r.description;
        if (!b.pub_year && r.year) patch.pub_year = r.year;
        if ((!b.author || /^unknown$/i.test(b.author)) && r.authors.length) patch.author = r.authors.join(', ');
        try { if (Object.keys(patch).length) await patchBook(b.id, patch); step('Updated'); } catch (err) { failed = err; }
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);     // four at a time
  if (!failed && newRows.length) {
    newRows.sort((a, b) => (a.arc_no || 0) - (b.arc_no || 0));
    try { $('gi-msg2').textContent = `Saving ${plural(newRows.length, 'new book', 'new books')}…`; await importBooks(newRows); } catch (err) { failed = err; }
  }
  busy = false;
  if (failed) { ctx.hooks.handleErr ? ctx.hooks.handleErr(failed) : ctx.hooks.toast(failed.message || 'Could not save.', true); }
  await ctx.hooks.refresh();
  const updated = todo.length - nNew;
  $('gp-card').innerHTML = `<div class="gi-wrap"><p><b>${failed ? 'Stopped by an error.' : 'Done.'}</b> ${[newRows.length && !failed ? `${plural(newRows.length, 'new book', 'new books')} added` : '', updated ? `${plural(updated, 'book', 'books')} you already had updated` : ''].filter(Boolean).join(', ')}.</p>
    ${coverFails ? `<p class="hint">${plural(coverFails, 'cover', 'covers')} could not be fetched from the wiki; add ${coverFails === 1 ? 'it' : 'them'} later in the form.</p>` : ''}
    ${arc ? `<p class="hint">Story arc: “<span class="${bn(arc)}">${esc(arc)}</span>”.</p>` : ''}
    <div class="gp-act"><button class="btn primary" type="button" data-gi="back">Back to the book</button></div></div>`;
}

// Clicks inside the card that belong to this list. Returns true when handled.
export function onIssuesClick(target) {
  const b = target.closest('[data-gi]'); if (!b) return false;
  const act = b.dataset.gi;
  if (act === 'back') { if (!busy) ctx.back(); }
  else if (act === 'save') save();
  else if (act === 'all' || act === 'none') { rows.forEach((r) => { if (r.plan.state === 'new' || r.plan.state === 'fill') r.sel = act === 'all'; }); drawRows(); }
  return true;
}
