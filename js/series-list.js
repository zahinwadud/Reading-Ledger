// Dashboard: Tools > Series from a list (added 19 November 2026).
// Copy a whole series page (Goodreads, or any site that lists a series in order: Ctrl+A, Ctrl+C) and paste it.
// The tool reads the numbered entries, finds your books among them, shows what it found, and changes
// nothing until you press Save. It never visits another website: it only reads what you paste.
import { patchBook, importBooks, esc, norm, authorsOf } from './api.js';

const $ = (id) => document.getElementById(id);
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const isBn = (text) => /[ঀ-৿]/.test(text || '');
const bn = (text) => (isBn(text) ? 'bn' : '');
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const STATUS_WORD = { want: 'Want to Read', reading: 'Currently Reading', read: 'Read' };

// START-PURE-HELPERS
// Text for comparing titles and names: same letters, any punctuation, Bengali or English digits,
// and without a "(Series, #4)" left at the end. "কর্নেল সমগ্র - ৪" and "কর্নেল সমগ্র ৪" compare equal.
export function matchKey(text) {
  return String(text ?? '').normalize('NFC').toLowerCase()
    .replace(/[০-৯]/g, (d) => String(BN_DIGITS.indexOf(d)))
    .replace(/\s*\([^()]*#[^()]*\)\s*$/, '')
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

// Read a pasted series page. Returns { name, author, entries: [{ no, title, author, year }] }.
// Goodreads pages list "Book 1", then the title (often twice), "by Author", a ratings line that may say
// "published 2014", a description and shelf buttons. Other sites: lines like "#1 Title" or "1. Title".
// Collections numbered "Book 1-3" are skipped (they are not one place in the series).
export function parseSeriesList(text) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  let name = '';
  for (const l of lines.slice(0, 12)) {
    const m = l.match(/^(.+?)\s+Series$/i);
    if (m) { name = m[1].trim(); break; }
  }
  const entries = [];
  const bookLine = /^Book\s+(\d+(?:\.\d+)?)$/i;
  const anyBook = /^Book\s+\S/i;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(bookLine);
    if (!m) continue;
    const block = [];
    for (let j = i + 1; j < lines.length && !anyBook.test(lines[j]); j += 1) block.push(lines[j]);
    const title = block.find((l) => l && !/^by\s/i.test(l)) || '';
    const by = block.find((l) => /^by\s/i.test(l));
    const author = by ? by.replace(/^by\s+/i, '').replace(/\s*\((Goodreads Author|Editor|Translator|Illustrator)[^)]*\)/gi, '').trim() : '';
    const pub = block.map((l) => l.match(/published\s+(\d{4})/i)).find(Boolean);
    if (title) entries.push({ no: Number(m[1]), title, author, year: pub ? Number(pub[1]) : null });
  }
  if (!entries.length) {
    // any other list: "#1 Title", "1. Title", "1) Title", "1 - Title"
    lines.forEach((l) => {
      const m = l.match(/^#?\s*(\d+(?:\.\d+)?)\s*(?:[.):\-–]\s*|\s+)(\S.*)$/);
      if (m && !/^\d{4}$/.test(m[1])) entries.push({ no: Number(m[1]), title: m[2].trim(), author: '', year: null });
    });
  }
  const seen = new Set();
  const unique = entries.filter((e) => (seen.has(e.no) ? false : seen.add(e.no)));   // the first entry for a number wins
  const authors = new Map();
  unique.forEach((e) => { if (e.author) authors.set(e.author, (authors.get(e.author) || 0) + 1); });
  const author = [...authors.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a)[0] || '';
  return { name, author, entries: unique };
}

// Find your books in the list. books = every book; seriesName = the name to save.
// Each entry gets hits: [{ b, state }] where state is 'free' (no series yet), 'same' (already this series
// and number) or 'other' (in another series, or another number). An author written differently does not
// stop a match on the exact title; when several books share the title, the ones by the same author win.
export function matchSeriesList(parsed, books, seriesName) {
  const byTitle = new Map();
  books.forEach((b) => { const k = matchKey(b.title); if (!byTitle.has(k)) byTitle.set(k, []); byTitle.get(k).push(b); });
  const nameKey = matchKey(seriesName);
  return parsed.entries.map((e) => {
    let hits = byTitle.get(matchKey(e.title)) || [];
    const who = authorsOf(e.author || parsed.author).map(matchKey);
    const sameAuthor = (b) => !who.length || authorsOf(b.author).some((a) => who.includes(matchKey(a)));
    if (hits.length > 1 && hits.some(sameAuthor)) hits = hits.filter(sameAuthor);
    return {
      ...e,
      hits: hits.map((b) => ({
        b,
        authorDiffers: !sameAuthor(b),
        state: !b.series ? 'free' : matchKey(b.series) === nameKey && Number(b.series_no) === e.no ? 'same' : 'other',
      })),
    };
  });
}
// When most matched books already sit in one series at the listed numbers, that is the name your site
// uses for this series (Goodreads may say "Basic Ali" where your site says "বেসিক আলী"). Returns it, or ''.
export function nameOnSite(matched) {
  const hits = matched.flatMap((e) => e.hits.map((h) => ({ e, b: h.b }))).filter((x) => x.b.series);
  if (!hits.length) return '';
  const count = new Map();
  hits.forEach(({ e, b }) => { if (Number(b.series_no) === e.no) count.set(b.series, (count.get(b.series) || 0) + 1); });
  const best = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
  return best && best[1] * 2 >= hits.length ? best[0] : '';
}
// END-PURE-HELPERS

let ctx = null;            // { show, hooks } from tools.js
let pasted = '';           // kept while the dialog is open, so "Back" returns to it
let typedName = '';
let rows = [];             // the matched entries shown in the preview
let parsedNow = null;
let addMissing = false;
let busy = false;

const fmtDate = (iso) => { const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : ''; };
const numText = (n) => (Number.isInteger(n) ? String(n) : String(n));
// The spelling already used on the site, when the pasted name is the same series.
function siteSpelling(name) {
  const k = matchKey(name);
  const counts = new Map();
  ctx.hooks.getBooks().forEach((b) => { if (b.series && matchKey(b.series) === k) counts.set(b.series, (counts.get(b.series) || 0) + 1); });
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s)[0] || '';
}

export function seriesListTool(c) {
  ctx = c;
  if (!ctx.hooks.hasSeries()) { ctx.show('Series from a list', '<p>Series need a one-time database step first. Open Tools → Series to see it.</p>'); return; }
  pasteScreen();
}

function pasteScreen(message = '') {
  ctx.show('Series from a list', `
    <p>Open the series page on Goodreads (or any site that lists a series in order), select everything on it (Ctrl+A), copy, and paste it here.</p>
    <textarea class="sl-paste" id="sl-paste" aria-label="Pasted series page" placeholder="Paste the series page here">${esc(pasted)}</textarea>
    <div class="field sl-name"><label for="sl-name">Series name</label><input id="sl-name" type="text" autocomplete="off" value="${esc(typedName)}">
      <p class="hint" id="sl-name-hint">Read from the pasted page. Change it if you want it written differently on your site.</p></div>
    <p class="err" id="sl-err" role="alert">${esc(message)}</p>`,
    '<button class="btn primary" type="button" data-sl="find">Find my books</button>');
  const box = $('sl-paste');
  box.addEventListener('input', () => {
    pasted = box.value;
    const p = parseSeriesList(pasted);
    if (p.name && (!typedName || typedName === $('sl-name').dataset.auto)) {
      const name = siteSpelling(p.name) || p.name;
      $('sl-name').value = name; $('sl-name').dataset.auto = name; typedName = name;
      $('sl-name-hint').textContent = siteSpelling(p.name) ? `Read from the pasted page. Your site already has this series as “${name}”, so that spelling is used.` : 'Read from the pasted page. Change it if you want it written differently on your site.';
    }
  });
  $('sl-name').addEventListener('input', () => { typedName = $('sl-name').value; });
  if (!pasted) box.focus();
}

function find() {
  pasted = $('sl-paste').value;
  typedName = $('sl-name').value.replace(/\s+/g, ' ').trim();
  parsedNow = parseSeriesList(pasted);
  if (!parsedNow.entries.length) { pasteScreen('No numbered books found in what you pasted. Copy the whole series page (Ctrl+A, then Ctrl+C) and paste it again.'); return; }
  if (!typedName) typedName = siteSpelling(parsedNow.name) || parsedNow.name;
  if (!typedName) { pasteScreen('Type the series name first.'); return; }
  rows = matchSeriesList(parsedNow, ctx.hooks.getBooks(), typedName);
  addMissing = false;
  preview();
}
// Switch to the series name your books already use, and match again.
function useSiteName(name) {
  typedName = name;
  rows = matchSeriesList(parsedNow, ctx.hooks.getBooks(), typedName);
  preview();
}

function hitRow(e, h, inGroup) {
  const b = h.b;
  const now = h.state === 'free' ? 'no series yet' : `now ${b.series}${b.series_no != null ? ` #${b.series_no}` : ''}`;
  const facts = [STATUS_WORD[b.status] || '', b.created_at ? `added ${fmtDate(b.created_at)}` : '', h.state === 'same' ? '' : now,
    h.authorDiffers ? `author written “${b.author}”` : ''].filter(Boolean).join(' · ');
  const pill = h.state === 'same' ? '<span class="sl-pill sl-done">Already set</span>'
    : h.state === 'other' ? '<span class="sl-pill sl-warn">Already in a series</span>'
    : inGroup ? '' : '<span class="sl-pill sl-ok">Matched</span>';
  const extra = h.state === 'other' ? `<span class="hint">Tick to move it to ${esc(typedName)} #${numText(e.no)}.</span>` : '';
  const box = h.state === 'same' ? '<span class="sl-tick-done" aria-hidden="true">✓</span>'
    : `<input type="checkbox" data-sl-id="${esc(b.id)}" data-sl-no="${e.no}"${h.state === 'free' ? ' checked' : ''}>`;
  return `<label class="tl-row tl-in${h.state === 'same' ? ' sl-same' : ''}">${box}<span>${inGroup ? '' : `<span class="sl-no">#${numText(e.no)}</span>`}<span class="${bn(b.title)}">${esc(b.title)}</span>${pill}<span class="hint">${esc(facts)}</span>${extra}</span></label>`;
}

function preview() {
  const found = rows.filter((e) => e.hits.length);
  const missing = rows.filter((e) => !e.hits.length);
  const single = found.filter((e) => e.hits.length === 1);
  const multi = found.filter((e) => e.hits.length > 1);
  const who = parsedNow.author;
  const groups = multi.map((e) => `<section class="tl-group">
      <div class="tl-row tl-head sl-headrow"><span><span class="sl-no">#${numText(e.no)}</span><b class="${bn(e.title)}">${esc(e.title)}</b><span class="sl-pill sl-warn">${e.hits.length} copies on your shelf</span><span class="hint">If one is a duplicate, untick it (and delete it later with Tools → Find duplicates).</span></span></div>
      ${e.hits.map((h) => hitRow(e, h, true)).join('')}</section>`).join('');
  const singles = single.length ? `<section class="tl-group">${single.map((e) => hitRow(e, e.hits[0], false)).join('')}</section>` : '';
  const list = missing.map((e) => `<li><span class="sl-no">#${numText(e.no)}</span><span class="${bn(e.title)}">${esc(e.title)}</span></li>`).join('');
  ctx.show('Series from a list', `
    <p class="sl-title"><b class="${bn(typedName)}">${esc(typedName)}</b>${who ? ` · <span class="${bn(who)}">${esc(who)}</span>` : ''}</p>
    ${(() => { const other = nameOnSite(rows); return other && matchKey(other) !== matchKey(typedName) ? `<div class="tl-opt sl-rename"><p class="sl-rename-text">Your books here are already in the series <strong class="${bn(other)}">${esc(other)}</strong>, with these numbers. Use that name, so nothing moves to a new series?</p><div class="tl-acts"><button class="btn primary" type="button" data-sl="usename" data-sl-name="${esc(other)}">Use “${esc(other)}”</button></div></div>` : ''; })()}
    <div class="sl-sum"><span><b>${rows.length.toLocaleString()}</b> ${rows.length === 1 ? 'title' : 'titles'} in the list</span><span><b>${found.length.toLocaleString()}</b> on your shelf</span><span><b>${missing.length.toLocaleString()}</b> not on your shelf</span></div>
    <div id="sl-prog" class="imp-center" hidden><p id="sl-msg"></p><div class="progress"><i id="sl-bar"></i></div></div>
    ${found.length ? `<div class="sl-head2"><h3>On your shelf</h3><span class="hint">Ticked books get the series and number</span></div>${groups}${singles}` : '<p class="hint">None of these titles are on your shelf yet.</p>'}
    ${missing.length ? `<div class="sl-head2"><h3>Not on your shelf <small class="hint">${missing.length.toLocaleString()}</small></h3></div>
      <ul class="sl-miss">${list}</ul>
      <label class="imp-opt tl-opt"><input type="checkbox" id="sl-add"${addMissing ? ' checked' : ''}><span>Also add the ${plural(missing.length, 'missing title', 'missing titles')} to Want to Read<span class="hint">As ${isBn(missing.map((e) => e.title).join('')) ? 'Bengali' : 'English'} books${who ? ` by ${esc(who)}` : ''}, with the series and number already set, marked Want to Buy. Leave this off to only update the books you have.</span></span></label>` : ''}`,
    '<button class="btn" type="button" data-sl="back">← Back</button><button class="btn primary" type="button" data-sl="save" id="sl-save"></button>');
  const all = document.querySelector('#tl-actions [data-tool="menu"]');
  if (all) all.remove();                 // Back leads to the paste screen, which has "All tools"
  saveLabel();
}

function ticked() { return [...document.querySelectorAll('#tl-body [data-sl-id]')].filter((x) => x.checked); }
function saveLabel() {
  const btn = $('sl-save'); if (!btn) return;
  const n = ticked().length, m = addMissing ? rows.filter((e) => !e.hits.length).length : 0;
  btn.textContent = n && m ? `Save ${plural(n, 'book', 'books')} and add ${m}` : m ? `Add ${plural(m, 'title', 'titles')}` : n ? `Save the series for ${plural(n, 'book', 'books')}` : 'Nothing to change';
  btn.disabled = !n && !m;
}

async function save() {
  if (busy) return;
  const todo = ticked().map((x) => ({ id: x.dataset.slId, no: Number(x.dataset.slNo) }));
  const missing = addMissing ? rows.filter((e) => !e.hits.length) : [];
  if (!todo.length && !missing.length) return;
  const what = [todo.length ? `set the series “${typedName}” on ${plural(todo.length, 'book', 'books')}` : '', missing.length ? `add ${plural(missing.length, 'new title', 'new titles')} to Want to Read` : ''].filter(Boolean).join(' and ');
  if (!confirm(`This will ${what}. Go ahead?`)) return;
  busy = true; $('sl-save').disabled = true;
  $('sl-prog').hidden = false;
  const total = todo.length + missing.length; let done = 0, failed = null;
  const step = () => { done += 1; $('sl-msg').textContent = `Saved ${done} of ${total}`; $('sl-bar').style.width = `${Math.round((done / total) * 100)}%`; };
  const queue = todo.slice();
  const worker = async () => {
    while (queue.length && !failed) {
      const x = queue.shift();
      try { await patchBook(x.id, { series: typedName, series_no: x.no }); step(); } catch (err) { failed = err; }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);   // four at a time: quick, but gentle on the database
  if (!failed && missing.length) {
    const who = parsedNow.author || 'Unknown';
    const newRows = missing.map((e) => ({
      title: e.title, author: e.author || who, pub_year: e.year && e.year >= 1000 && e.year <= 2999 ? e.year : null,
      language: isBn(e.title + (e.author || who)) ? 'Bengali' : 'English', format: 'Book', status: 'want', ownership: 'buy',
      genres: [], copies: [], series: typedName, series_no: e.no,
    }));
    try { await importBooks(newRows); done += newRows.length; } catch (err) { failed = err; }
  }
  busy = false;
  if (failed) ctx.hooks.handleErr(failed);
  else ctx.hooks.toast(`Done: ${[todo.length ? plural(todo.length, 'book', 'books') + ' updated' : '', missing.length ? plural(missing.length, 'title', 'titles') + ' added' : ''].filter(Boolean).join(', ')}`);
  await ctx.hooks.refresh();
  rows = matchSeriesList(parsedNow, ctx.hooks.getBooks(), typedName);   // show the result
  addMissing = false;
  preview();
}

// Clicks and ticks inside the Tools dialog that belong to this tool. Returns true when handled.
export function onSeriesListClick(target) {
  const btn = target.closest('[data-sl]');
  if (!btn) return false;
  const act = btn.dataset.sl;
  if (act === 'find') find();
  else if (act === 'back') pasteScreen();
  else if (act === 'save') save();
  else if (act === 'usename') useSiteName(btn.dataset.slName);
  return true;
}
export function onSeriesListChange(box) {
  if (box.id === 'sl-add') { addMissing = box.checked; saveLabel(); return true; }
  if (box.dataset.slId) { saveLabel(); return true; }
  return false;
}
