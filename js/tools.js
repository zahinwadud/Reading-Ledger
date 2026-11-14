// Dashboard tools: backup, duplicates, author names, series, covers.
// Every tool shows what it found and changes nothing until you press its button.
import { coverOf, deleteBook, updateBooks, patchBook, setCoverUrl, readSettings, saveSetting, esc, norm, authorsOf } from './api.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const isBn = (text) => /[ঀ-৿]/.test(text || '');
const bn = (text) => (isBn(text) ? 'bn' : '');
let hooks = null;          // { getBooks, refresh, toast, handleErr, hasSeries, seriesNumber } from admin.js
let stop = false;          // set when the dialog closes, so a running job ends

const dlg = () => $('tools-panel');
function show(title, body, actions = '') {
  $('tl-title').textContent = title;
  $('tl-body').innerHTML = body;
  $('tl-actions').innerHTML = `${title === 'Tools' ? '' : '<button class="btn tl-back" type="button" data-tool="menu">← All tools</button>'}${actions}`;
  $('tl-body').scrollTop = 0;
}

// Things you have already said "no" to (not duplicates, not the same author, no cover found) are
// remembered in this browser, so the tools do not ask again.
function memory(name) {
  const key = `rl-tools-${name}`;
  let set;
  try { set = new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch (e) { set = new Set(); }
  return {
    has: (v) => set.has(v),
    add: (v) => { set.add(v); try { localStorage.setItem(key, JSON.stringify([...set].slice(-4000))); } catch (e) { /* storage full: ignore */ } },
  };
}

// START-PURE-HELPERS
// ---------- names: the same author written in Bengali and in English letters ----------
// A name is reduced to its consonant "skeleton", which comes out the same in both scripts:
//   "সত্যজিৎ রায়" -> "styjtr"      "Satyajit Ray" -> "styjtr"
// It is only used to SUGGEST names that may be the same person; you confirm each merge.
const BN_LETTERS = {
  'ক': 'k', 'খ': 'k', 'গ': 'g', 'ঘ': 'g', 'ঙ': 'n', 'চ': 'c', 'ছ': 'c', 'জ': 'j', 'ঝ': 'j', 'ঞ': 'n', 'ট': 't', 'ঠ': 't', 'ড': 'd', 'ঢ': 'd',
  'ণ': 'n', 'ত': 't', 'থ': 't', 'দ': 'd', 'ধ': 'd', 'ন': 'n', 'প': 'p', 'ফ': 'p', 'ব': 'b', 'ভ': 'b', 'ম': 'm', 'য': 'j', 'র': 'r', 'ল': 'l',
  'শ': 's', 'ষ': 's', 'স': 's', 'হ': 'h', 'ৎ': 't', 'ং': 'n',
};
export function skeleton(name) {
  const words = String(name || '').normalize('NFC').toLowerCase().split(/[\s.,|/()\-]+/).filter(Boolean).map((w) => {
    let s = w;
    if (isBn(s)) {
      s = s.replace(/ড়|ঢ়/g, 'r').replace(/য়|্য/g, 'y').replace(/ক্ষ/g, 'ks').replace(/জ্ঞ/g, 'g');
      s = [...s].map((ch) => BN_LETTERS[ch] ?? (/[a-z]/.test(ch) ? ch : '')).join('');
    } else {
      s = s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
      s = s.replace(/sh/g, 's').replace(/ch+/g, 'c').replace(/ph/g, 'p').replace(/([kgtdpbj])h/g, '$1').replace(/x/g, 'ks').replace(/z/g, 'j')
        .replace(/[vw]/g, 'b').replace(/f/g, 'p').replace(/q/g, 'k').replace(/y(?=[aeiou])/g, 'Y').replace(/[aeiouy]/g, '').replace(/Y/g, 'y');
    }
    return s.replace(/h/g, '').replace(/y+$/, '').replace(/(.)\1+/g, '$1');
  });
  return words.join('');
}

// How many single-letter edits turn a into b (stops caring beyond 2).
export function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// Groups of author names that are probably one person: [[name, name, ...], ...]
export function authorGroups(names) {
  const sk = new Map(names.map((n) => [n, skeleton(n)]));
  const used = new Set();
  const groups = [];
  names.forEach((a, i) => {
    if (used.has(a) || sk.get(a).length < 4) return;
    const group = [a];
    for (let j = i + 1; j < names.length; j += 1) {
      const b = names[j];
      if (used.has(b) || sk.get(b).length < 4) continue;
      const x = sk.get(a), y = sk.get(b);
      const d = x === y ? 0 : editDistance(x, y);
      if (d === 0 || (d === 1 && x[0] === y[0] && Math.min(x.length, y.length) >= 7)) { group.push(b); used.add(b); }
    }
    if (group.length > 1) { used.add(a); groups.push(group); }
  });
  return groups;
}

// ---------- duplicates ----------
// Two entries are the same book when the format, the title and the author all match. Titles are compared
// without spaces or punctuation; authors by skeleton, so a Bengali and an English spelling still match.
// loose = also ignore a subtitle after ":" or " - " and anything in brackets.
export function titleKey(title, loose) {
  let t = String(title || '').normalize('NFC').toLowerCase();
  if (loose) t = t.replace(/\([^()]*\)|\[[^\]]*\]/g, ' ').replace(/\s[-–—|]\s.*$|:.*$/, '');
  return t.replace(/[^\p{L}\p{N}\p{M}]+/gu, '');
}
export function duplicateGroups(books, loose) {
  const map = new Map();
  books.forEach((b) => {
    const t = titleKey(b.title, loose);
    if (!t) return;
    const key = `${b.format}|${t}|${skeleton(b.author) || norm(b.author)}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(b);
  });
  return [...map.entries()].filter(([, list]) => list.length > 1).map(([key, list]) => ({ key, list }));
}
// Which copy has the most filled in? (That one is offered as the copy to keep.)
export const richness = (b) => (b.cover_path ? 3 : 0) + (b.cover_url ? 2 : 0) + (b.finished_at ? 2 : 0) + (b.status === 'read' ? 1 : 0)
  + (b.description ? 1 : 0) + (b.pages ? 1 : 0) + (b.pub_year ? 1 : 0) + (b.isbn ? 1 : 0) + ((b.genres || []).length ? 1 : 0) + ((b.copies || []).length ? 1 : 0);

// ---------- series written inside the title ----------
// "ছায়াশ্বাপদ (তিন গোয়েন্দা, #৪)" -> title "ছায়াশ্বাপদ", series "তিন গোয়েন্দা", number 4
// "Teen Titans #12"              -> title unchanged,   series "Teen Titans",   number 12
const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const toNumber = (text) => Number(String(text).replace(/[০-৯]/g, (d) => BN_DIGITS.indexOf(d)));
export function seriesInTitle(title) {
  const t = String(title || '').normalize('NFC').trim();
  let m = t.match(/^(.+?)\s*\(\s*([^()]+?)\s*,?\s*#\s*([\d০-৯]+(?:\.[\d০-৯]+)?)\s*\)$/);
  if (m) return { title: m[1].trim(), series: m[2].trim(), no: toNumber(m[3]) };
  m = t.match(/^(.+?)\s*#\s*([\d০-৯]+)$/);
  if (m) return { title: t, series: m[1].replace(/[\s,:\-]+$/, '').trim(), no: toNumber(m[2]), issue: true };
  return null;
}

// ---------- backup files ----------
export function toCSV(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    const text = v == null ? '' : Array.isArray(v) ? v.join('; ') : String(v);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
}
// END-PURE-HELPERS

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const ICON = {
  backup: '<path d="M8 2.5v8M5 7.8l3 3 3-3M2.5 10.5V13a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5v-2.5"/>',
  dupes: '<rect x="2.5" y="2.5" width="8" height="8" rx="1.2"/><path d="M5.5 13.5h7a1 1 0 0 0 1-1v-7"/>',
  authors: '<circle cx="6" cy="5.5" r="2.5"/><path d="M1.8 13.5c.4-2.6 2.1-4 4.2-4s3.8 1.4 4.2 4M10.5 3.2a2.5 2.5 0 0 1 0 4.6M12 9.8c1.2.6 2 1.8 2.3 3.7"/>',
  series: '<path d="M3 2.5h2.5v11H3zM6.8 2.5h2.5v11H6.8zM10.6 4l2.4-.6 2 9.6-2.4.6z"/>',
  goal: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2.2"/><path d="M8 8l5-5M11.5 3H13v1.5"/>',
  covers: '<rect x="2.5" y="2" width="11" height="12" rx="1.2"/><path d="M2.5 11l3-3 2.5 2.5 2-2 3.5 3.5"/><circle cx="10" cy="5.5" r="1"/>',
};
const svg = (inner) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

// ====================================================================
// Menu
// ====================================================================
const notDupes = memory('not-dupes');
const notSame = memory('not-same-author');
const noCover = memory('no-cover');

const needsCover = (b) => b.format === 'Book' && !coverOf(b);
const dupesNow = (loose) => duplicateGroups(hooks.getBooks(), loose).filter((g) => !notDupes.has(g.key));
const authorCounts = () => {
  const count = new Map();
  // each person is counted on their own, also when a book lists several authors
  hooks.getBooks().forEach((b) => authorsOf(b.author).forEach((a) => count.set(a, (count.get(a) || 0) + 1)));
  return count;
};
const authorSuggestions = () => authorGroups([...authorCounts().keys()]).filter((g) => !notSame.has(g.slice().sort().join('|')));
const seriesFound = () => hooks.getBooks().filter((b) => !b.series).map((b) => ({ b, found: seriesInTitle(b.title) })).filter((x) => x.found);

function menu() {
  const books = hooks.getBooks();
  const item = (tool, icon, title, text) =>
    `<button type="button" class="tl-item" data-tool="${tool}"><span class="tl-ic">${svg(ICON[icon])}</span><span><b>${title}</b><span class="hint">${text}</span></span></button>`;
  show('Tools', `<div class="tl-menu">
    ${item('goal', 'goal', 'Reading goal', 'Set how many titles you want to finish this year. The Stats page tracks it.')}
    ${item('backup', 'backup', 'Download a backup', `Save all ${plural(books.length, 'book', 'books')} to a file on this device. Do this before big changes.`)}
    ${item('dupes', 'dupes', 'Find duplicates', `${plural(dupesNow(false).length, 'title appears', 'titles appear')} more than once.`)}
    ${item('authors', 'authors', 'Tidy author names', `${plural(authorSuggestions().length, 'author looks', 'authors look')} to be written in more than one way.`)}
    ${item('series', 'series', 'Series', hooks.hasSeries() ? `${plural(seriesFound().length, 'title carries', 'titles carry')} a series name inside the title.` : 'Needs a one-time database step. Open this to see it.')}
    ${item('covers', 'covers', 'Find covers', `${plural(books.filter(needsCover).length, 'book has', 'books have')} no cover picture.`)}
  </div>`);
}

// ====================================================================
// Reading goal (shared by every device through a small "settings" table)
// ====================================================================
export const SETTINGS_SQL = `create table if not exists public.settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.settings enable row level security;
drop policy if exists "Anyone can read settings" on public.settings;
drop policy if exists "Owner can change settings" on public.settings;
create policy "Anyone can read settings" on public.settings for select using (true);
create policy "Owner can change settings" on public.settings for all using (public.is_owner()) with check (public.is_owner());
grant select on public.settings to anon, authenticated;
grant insert, update, delete on public.settings to authenticated;`;

async function goal() {
  show('Reading goal', '<p class="imp-center">Loading\u2026</p>');
  let all;
  try { all = await readSettings(); } catch (err) { hooks.handleErr(err); return; }
  if (all === null) {
    show('Reading goal', `<p>To keep one goal for every device, the database needs a small settings table. This is a one-time step and it does not touch your books.</p>
      <ol class="imp-steps"><li>Open your project at supabase.com and go to <b>SQL Editor \u2192 New query</b>.</li><li>Paste the lines below and click <b>Run</b>.</li><li>Come back here and open this tool again.</li></ol>
      <pre class="tl-code">${esc(SETTINGS_SQL)}</pre>
      <div class="tl-acts"><button class="btn primary" type="button" id="goal-copy">Copy the lines</button></div>
      <p class="hint">Until then, the Stats page keeps a separate goal on each device.</p>`);
    $('goal-copy').addEventListener('click', () => { navigator.clipboard.writeText(SETTINGS_SQL).then(() => hooks.toast('Copied'), () => hooks.toast('Could not copy. Select the text and copy it by hand.', true)); });
    return;
  }
  const year = new Date().getFullYear();
  const now = Number(all[`goal-${year}`]) || 0;
  const done = hooks.getBooks().filter((b) => b.status === 'read' && String(b.finished_at || '').startsWith(String(year))).length;
  show('Reading goal', `<p>How many titles do you want to finish in ${year}? Books, comics and audiobooks all count. You have finished ${done} so far.</p>
    <div class="field"><label for="goal-n">Goal for ${year}</label><input id="goal-n" class="tl-input" type="number" min="1" max="5000" inputmode="numeric" value="${now || ''}" placeholder="e.g. 80"></div>
    <p class="hint">The goal shows on the Stats page on every device.</p>`,
  `${now ? '<button class="btn" type="button" id="goal-remove">Remove goal</button>' : ''}<button class="btn primary" type="button" id="goal-save">Save goal</button>`);
  const save = async (value) => {
    try { await saveSetting(`goal-${year}`, value); hooks.toast(value ? `Goal for ${year}: ${value} titles` : 'Goal removed'); goal(); }
    catch (err) { hooks.handleErr(err); }
  };
  $('goal-save').addEventListener('click', () => {
    const n = Math.round(Number($('goal-n').value));
    if (!(n > 0)) { hooks.toast('Enter a number above 0.', true); return; }
    save(n);
  });
  if ($('goal-remove')) $('goal-remove').addEventListener('click', () => save(null));
}

// ====================================================================
// Backup
// ====================================================================
function backup() {
  const n = hooks.getBooks().length;
  show('Download a backup', `<p>This saves a copy of all ${plural(n, 'book', 'books')} as they are right now. Keep the file somewhere safe; nothing on the site changes.</p>
    <div class="tl-choices">
      <button class="btn primary" type="button" id="bk-json">Backup file (.json)</button>
      <button class="btn" type="button" id="bk-csv">Spreadsheet (.csv)</button>
    </div>
    <p class="hint">The .json file is the complete backup (it can be loaded back into the database). The .csv opens in Excel or Google Sheets. Uploaded cover pictures are not inside either file; they stay in your Supabase storage.</p>`);
  const stamp = new Date().toISOString().slice(0, 10);
  $('bk-json').addEventListener('click', () => { download(`reading-ledger-backup-${stamp}.json`, JSON.stringify(hooks.getBooks(), null, 1), 'application/json'); hooks.toast('Backup downloaded'); });
  $('bk-csv').addEventListener('click', () => { download(`reading-ledger-${stamp}.csv`, `﻿${toCSV(hooks.getBooks())}`, 'text/csv'); hooks.toast('Spreadsheet downloaded'); });
}

// ====================================================================
// Duplicates
// ====================================================================
let looseDupes = false;
const keepChoice = new Map();        // group key -> id of the copy to keep

function dupes() {
  const groups = dupesNow(looseDupes);
  const facts = (b) => [
    b.status === 'read' ? `Read${b.finished_at ? ' ' + b.finished_at : ''}` : b.status === 'reading' ? 'Reading' : 'Want to read',
    coverOf(b) ? 'has cover' : 'no cover', b.pages ? `${b.pages} pages` : '', b.pub_year || '', b.isbn ? 'ISBN' : '',
    (b.genres || []).length ? `${b.genres.length} ${b.genres.length === 1 ? 'genre' : 'genres'}` : '', `added ${String(b.created_at || '').slice(0, 10)}`,
  ].filter(Boolean).join(' · ');
  const body = groups.slice(0, 40).map((g) => {
    const best = keepChoice.get(g.key) || g.list.slice().sort((a, b) => richness(b) - richness(a))[0].id;
    return `<section class="tl-group" data-key="${esc(g.key)}">
      ${g.list.map((b) => `<label class="tl-row"><input type="radio" name="keep-${esc(g.key)}" value="${esc(b.id)}"${String(b.id) === String(best) ? ' checked' : ''}>
        <span><b class="${bn(b.title)}">${esc(b.title)}</b><span class="tl-sub ${bn(b.author)}">${esc(b.author)} · ${esc(b.format)}</span><span class="hint">${esc(facts(b))}</span></span></label>`).join('')}
      <div class="tl-acts"><button class="btn danger" type="button" data-dupe="delete">Keep the ticked one, delete ${g.list.length - 1 === 1 ? 'the other' : `the other ${g.list.length - 1}`}</button>
        <button class="btn" type="button" data-dupe="skip">Not duplicates</button></div>
    </section>`;
  }).join('');
  show('Find duplicates', `<p>${groups.length ? `${plural(groups.length, 'title appears', 'titles appear')} more than once. In each group, tick the copy to keep; the copy with the most details is ticked for you.` : 'No duplicates found.'}</p>
    <label class="imp-opt tl-opt"><input type="checkbox" id="dupe-loose"${looseDupes ? ' checked' : ''}><span>Also match titles that differ only by a subtitle or text in brackets<span class="hint">Finds more, but check each group: different editions or volumes can look alike.</span></span></label>
    ${body}${groups.length > 40 ? `<p class="hint">Showing the first 40 groups. More appear as you work through these.</p>` : ''}`);
  $('dupe-loose').addEventListener('change', (e) => { looseDupes = e.target.checked; dupes(); });
}

async function onDupe(btn) {
  const section = btn.closest('.tl-group');
  const key = section.dataset.key;
  if (btn.dataset.dupe === 'skip') { notDupes.add(key); section.remove(); return; }
  const group = dupesNow(looseDupes).find((g) => g.key === key);
  const keepId = (section.querySelector('input[type=radio]:checked') || {}).value;
  if (!group || !keepId) return;
  const gone = group.list.filter((b) => String(b.id) !== String(keepId));
  if (!confirm(`Delete ${plural(gone.length, 'copy', 'copies')} of “${group.list[0].title}”? This cannot be undone.`)) return;
  btn.disabled = true;
  try {
    for (const b of gone) await deleteBook(b);
    hooks.toast(`${plural(gone.length, 'duplicate', 'duplicates')} deleted`);
  } catch (err) { hooks.handleErr(err); }
  const top = $('tl-body').scrollTop;
  await hooks.refresh();
  dupes();
  $('tl-body').scrollTop = top;
}

// ====================================================================
// Author names
// ====================================================================
let authorFilter = '';
const mergePick = new Set();         // names ticked in the "merge other names" list

function authors() {
  const count = authorCounts();
  const groups = authorSuggestions();
  const groupHtml = groups.map((g, gi) => {
    const sorted = g.slice().sort((a, b) => count.get(b) - count.get(a));
    return `<section class="tl-group" data-group="${gi}">
      ${sorted.map((name, i) => `<div class="tl-row tl-name"><label class="tl-check"><input type="checkbox" data-name="${esc(name)}" checked aria-label="Include ${esc(name)}"></label>
        <label class="tl-keep"><input type="radio" name="keepname-${gi}" value="${esc(name)}"${i === 0 ? ' checked' : ''}><span><b class="${bn(name)}">${esc(name)}</b><span class="hint">${plural(count.get(name), 'book', 'books')}</span></span></label></div>`).join('')}
      <div class="tl-acts"><button class="btn primary" type="button" data-author="merge">Use the chosen name for all ticked</button>
        <button class="btn" type="button" data-author="skip">Different people</button></div>
    </section>`;
  }).join('');
  show('Tidy author names', `<p>${groups.length ? `These names look like the same author written in more than one way. In each group, choose the spelling to keep (the round button) and untick any name that is a different person.` : 'No look-alike author names found.'}</p>
    ${groupHtml}
    <h3 class="tl-h">Merge other names</h3>
    <p class="hint">Search for an author, tick the spellings that are the same person, then choose which one to keep.</p>
    <input id="au-filter" class="tl-input" type="search" placeholder="Search author names" value="${esc(authorFilter)}" aria-label="Search author names">
    <div id="au-list"></div>
    <div id="au-merge"></div>`);
  $('au-filter').addEventListener('input', (e) => { authorFilter = e.target.value; authorList(); });
  authorList();
}

function authorList() {
  const count = authorCounts();
  const q = norm(authorFilter);
  const qs = skeleton(authorFilter);
  // Typing a name finds it in the other script too (the skeletons match).
  const names = [...count.keys()].filter((n) => mergePick.has(n) || (q.length >= 2 && (norm(n).includes(q) || (qs.length >= 3 && skeleton(n).includes(qs)))))
    .sort((a, b) => count.get(b) - count.get(a)).slice(0, 40);
  $('au-list').innerHTML = names.map((n) => `<label class="tl-row"><input type="checkbox" data-merge="${esc(n)}"${mergePick.has(n) ? ' checked' : ''}><span><b class="${bn(n)}">${esc(n)}</b><span class="hint">${plural(count.get(n), 'book', 'books')}</span></span></label>`).join('')
    || (q.length >= 2 ? '<p class="hint">No author matches.</p>' : '');
  const chosen = [...mergePick].filter((n) => count.has(n));
  $('au-merge').innerHTML = chosen.length >= 2
    ? `<div class="tl-acts"><label class="tl-inline">Keep <select id="au-keep">${chosen.sort((a, b) => count.get(b) - count.get(a)).map((n) => `<option>${esc(n)}</option>`).join('')}</select></label>
       <button class="btn primary" type="button" data-author="merge-picked">Merge ${chosen.length} names</button></div>` : '';
}

async function mergeAuthors(names, keep, btn) {
  const others = names.filter((n) => n !== keep);
  // Swap the name inside each book's author list, so co-authors on the same book are kept.
  const groups = new Map();           // new author text -> ids of the books that get it
  hooks.getBooks().forEach((b) => {
    const list = authorsOf(b.author);
    if (!list.some((a) => others.includes(a))) return;
    const next = [];
    list.forEach((a) => { const name = others.includes(a) ? keep : a; if (!next.includes(name)) next.push(name); });
    const text = next.join(', ');
    if (!groups.has(text)) groups.set(text, []);
    groups.get(text).push(b.id);
  });
  const ids = [...groups.values()].flat();
  if (!ids.length) return;
  if (!confirm(`Change the author of ${plural(ids.length, 'book', 'books')} to \u201c${keep}\u201d?`)) return;
  btn.disabled = true;
  try {
    for (const [text, list] of groups) await updateBooks(list, { author: text });
    hooks.toast(`${plural(ids.length, 'book', 'books')} now by ${keep}`);
    mergePick.clear();
  } catch (err) { hooks.handleErr(err); }
  const top = $('tl-body').scrollTop;
  await hooks.refresh();
  authors();
  $('tl-body').scrollTop = top;
}

function onAuthor(btn) {
  if (btn.dataset.author === 'merge-picked') { mergeAuthors([...mergePick], $('au-keep').value, btn); return; }
  const section = btn.closest('.tl-group');
  const all = [...section.querySelectorAll('[data-name]')];
  if (btn.dataset.author === 'skip') { notSame.add(all.map((el) => el.dataset.name).sort().join('|')); section.remove(); return; }
  const keep = (section.querySelector('input[type=radio]:checked') || {}).value;
  const names = all.filter((el) => el.checked).map((el) => el.dataset.name);
  if (!keep || !names.includes(keep) || names.length < 2) { hooks.toast('Tick at least two names, including the one to keep.', true); return; }
  mergeAuthors(names, keep, btn);
}

// ====================================================================
// Series
// ====================================================================
export const SERIES_SQL = `alter table public.books add column if not exists series text;
alter table public.books add column if not exists series_no numeric;`;
export const ARC_SQL = `alter table public.books add column if not exists arc text;
alter table public.books add column if not exists arc_no numeric;`;
const seriesOff = new Set();          // book ids unticked in the list
const seriesComics = new Map();       // series name -> true/false: also give these titles the genre "Comics"
const isComic = (b) => (b.genres || []).some((g) => /comic|manga|graphic novel/i.test(g));

function series() {
  if (!hooks.hasSeries()) {
    show('Series', `<p>Series need two new columns in the database. This is a one-time step and it does not touch your existing books.</p>
      <ol class="imp-steps"><li>Open your project at supabase.com and go to <b>SQL Editor → New query</b>.</li><li>Paste the two lines below and click <b>Run</b>.</li><li>Come back here and reload this page.</li></ol>
      <pre class="tl-code" id="series-sql">${esc(SERIES_SQL)}</pre>
      <div class="tl-acts"><button class="btn primary" type="button" id="series-copy">Copy the two lines</button></div>
      <p class="hint">After that, the book form gets a Series field, the public site gets a page per series, and this tool can lift series names out of your titles.</p>`);
    $('series-copy').addEventListener('click', () => { navigator.clipboard.writeText(SERIES_SQL).then(() => hooks.toast('Copied'), () => hooks.toast('Could not copy. Select the text and copy it by hand.', true)); });
    return;
  }
  // Comics have one more level, the story arc. It needs its own two columns.
  const arcStep = hooks.hasArc() ? '' : `<div class="tl-opt"><b>Story arcs for comics</b>
      <p class="hint">A comic issue can also belong to a story arc (Batman #608 is part of \u201cHush\u201d). To switch that on, run these two lines in Supabase (SQL Editor \u2192 New query), then reload this page.</p>
      <pre class="tl-code">${esc(ARC_SQL)}</pre>
      <div class="tl-acts"><button class="btn" type="button" id="arc-copy">Copy the two lines</button></div></div>`;
  const found = seriesFound();
  const bySeries = new Map();
  found.forEach((x) => { if (!bySeries.has(x.found.series)) bySeries.set(x.found.series, []); bySeries.get(x.found.series).push(x); });
  const groups = [...bySeries.entries()].sort((a, b) => b[1].length - a[1].length);
  // A guess to start from: titles written like "Teen Titans #12" are comic issues.
  groups.forEach(([name, list]) => { if (!seriesComics.has(name)) seriesComics.set(name, list.some((x) => x.found.issue || isComic(x.b))); });
  const html = groups.map(([name, list]) => `<section class="tl-group">
      <label class="tl-row tl-head"><input type="checkbox" data-series-all="${esc(name)}"${list.every((x) => !seriesOff.has(String(x.b.id))) ? ' checked' : ''}><span><b class="${bn(name)}">${esc(name)}</b><span class="hint">${plural(list.length, 'title', 'titles')}</span></span></label>
      <label class="tl-row tl-in tl-comic"><input type="checkbox" data-series-comic="${esc(name)}"${seriesComics.get(name) ? ' checked' : ''}><span>These are comics<span class="hint">Adds the genre \u201cComics\u201d, so they appear in the Comics section.</span></span></label>
      ${list.sort((a, b) => a.found.no - b.found.no).map((x) => `<label class="tl-row tl-in"><input type="checkbox" data-series-id="${esc(x.b.id)}" data-series-of="${esc(name)}"${seriesOff.has(String(x.b.id)) ? '' : ' checked'}>
        <span><span class="${bn(x.b.title)}">${esc(x.found.title)}</span><span class="hint">#${x.found.no}${x.found.title !== x.b.title ? ` · now “${esc(x.b.title)}”` : ''}</span></span></label>`).join('')}
    </section>`).join('');
  show('Series', `<p>${found.length ? `${plural(found.length, 'title carries', 'titles carry')} a series name and number inside the title. Ticked titles get the series and number filled in.` : 'No series names found inside titles. You can set a series in each book’s form, or tick books in the list and use Change → Series.'}</p>
    ${found.length ? `<label class="imp-opt tl-opt"><input type="checkbox" id="series-clean" checked><span>Also remove the series text from the title<span class="hint">“ছায়াশ্বাপদ (তিন গোয়েন্দা, #৪)” becomes “ছায়াশ্বাপদ”. Titles like “Teen Titans #12” stay as they are.</span></span></label>` : ''}
    ${arcStep}
    <div id="series-prog" class="imp-center" hidden><p id="series-msg"></p><div class="progress"><i id="series-bar"></i></div></div>
    ${html}`, found.length ? '<button class="btn primary" type="button" data-series="apply">Fill in the ticked titles</button>' : '');
  if ($('arc-copy')) $('arc-copy').addEventListener('click', () => { navigator.clipboard.writeText(ARC_SQL).then(() => hooks.toast('Copied'), () => hooks.toast('Could not copy. Select the text and copy it by hand.', true)); });
}

function onSeriesTick(box) {
  if (box.dataset.seriesAll !== undefined) {
    document.querySelectorAll(`[data-series-of="${CSS.escape(box.dataset.seriesAll)}"]`).forEach((el) => { el.checked = box.checked; if (box.checked) seriesOff.delete(el.dataset.seriesId); else seriesOff.add(el.dataset.seriesId); });
  } else if (box.dataset.seriesId) {
    if (box.checked) seriesOff.delete(box.dataset.seriesId); else seriesOff.add(box.dataset.seriesId);
  }
}

async function applySeries(btn) {
  const todo = seriesFound().filter((x) => !seriesOff.has(String(x.b.id)));
  if (!todo.length) { hooks.toast('Tick at least one title.', true); return; }
  const clean = $('series-clean').checked;
  if (!confirm(`Fill in the series for ${plural(todo.length, 'book', 'books')}${clean ? ' and shorten their titles' : ''}?`)) return;
  btn.disabled = true; stop = false;
  $('series-prog').hidden = false;
  let done = 0, failed = null;
  // Four at a time: quick, but gentle on the database.
  const queue = todo.slice();
  const worker = async () => {
    while (queue.length && !stop && !failed) {
      const x = queue.shift();
      const patch = { series: x.found.series, series_no: x.found.no, ...(clean && x.found.title !== x.b.title ? { title: x.found.title } : {}) };
      if (seriesComics.get(x.found.series) && !isComic(x.b)) patch.genres = [...(x.b.genres || []), 'Comics'];
      try { await patchBook(x.b.id, patch); }
      catch (err) { failed = err; return; }
      done += 1;
      $('series-msg').textContent = `Saved ${done} of ${todo.length}`;
      $('series-bar').style.width = `${Math.round((done / todo.length) * 100)}%`;
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (failed) hooks.handleErr(failed); else hooks.toast(`Series filled in for ${plural(done, 'book', 'books')}`);
  await hooks.refresh();
  series();
}

// ====================================================================
// Find covers (Open Library, by title and author)
// ====================================================================
let coverLang = 'English';
const coverResults = new Map();       // book id -> [{ thumb, full, title, author, year }]

async function lookUp(b) {
  const title = (seriesInTitle(b.title) || { title: b.title }).title.replace(/\([^()]*\)/g, ' ').replace(/[:–—|].*$/, '').trim() || b.title;
  const ask = async (params) => {
    const res = await fetch(`https://openlibrary.org/search.json?${new URLSearchParams({ ...params, limit: '8', fields: 'cover_i,title,author_name,first_publish_year' })}`);
    if (!res.ok) throw new Error(`Open Library answered ${res.status}`);
    return ((await res.json()).docs || []).filter((d) => d.cover_i);
  };
  let docs = await ask({ title, author: b.author });
  if (!docs.length) { await sleep(600); docs = await ask({ title }); }
  const seen = new Set();
  return docs.filter((d) => (seen.has(d.cover_i) ? false : seen.add(d.cover_i))).slice(0, 5).map((d) => ({
    thumb: `https://covers.openlibrary.org/b/id/${d.cover_i}-M.jpg`,
    full: `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`,
    title: d.title || '', author: (d.author_name || []).slice(0, 2).join(', '), year: d.first_publish_year || '',
  }));
}

const coverQueue = () => hooks.getBooks().filter((b) => needsCover(b) && (!coverLang || b.language === coverLang));

function covers(message = '') {
  const queue = coverQueue();
  const fresh = queue.filter((b) => !coverResults.has(String(b.id)) && !noCover.has(String(b.id)));
  const shownRows = queue.filter((b) => coverResults.has(String(b.id))).map((b) => {
    const list = coverResults.get(String(b.id));
    return `<section class="tl-group" data-cover-book="${esc(b.id)}">
      <p class="tl-ctitle"><b class="${bn(b.title)}">${esc(b.title)}</b><span class="tl-sub ${bn(b.author)}">${esc(b.author)}${b.pub_year ? ` · ${b.pub_year}` : ''}</span></p>
      <div class="tl-covers">${list.map((c, i) => `<button type="button" class="tl-cover" data-cover="${i}" title="Use this cover"><img src="${esc(c.thumb)}" alt="Cover: ${esc(c.title)}" loading="lazy"><span class="hint">${esc(c.title)}${c.author ? `<br>${esc(c.author)}` : ''}${c.year ? ` · ${c.year}` : ''}</span></button>`).join('')}</div>
      <div class="tl-acts"><button class="btn" type="button" data-cover-none>None of these</button></div>
    </section>`;
  }).join('');
  const tried = queue.length - fresh.length - queue.filter((b) => coverResults.has(String(b.id))).length;
  show('Find covers', `<p>This looks each book up on Open Library by title and author and shows the covers it finds. Click the right one to use it; the site then links to that picture, so it uses none of your storage.</p>
    <label class="tl-inline">Look at <select id="cover-lang"><option value="English"${coverLang === 'English' ? ' selected' : ''}>English books</option><option value="Bengali"${coverLang === 'Bengali' ? ' selected' : ''}>Bengali books</option><option value=""${coverLang === '' ? ' selected' : ''}>all books</option></select></label>
    <p class="hint">${plural(queue.length, 'book', 'books')} without a cover here${tried ? `, ${tried} already tried with nothing found` : ''}. Open Library has few Bengali books, so those rarely match.</p>
    ${message ? `<p class="tl-note">${esc(message)}</p>` : ''}
    <div id="cover-prog" class="imp-center" hidden><p id="cover-msg"></p><div class="progress"><i id="cover-bar"></i></div></div>
    ${shownRows}`,
  fresh.length ? `<button class="btn primary" type="button" data-covers="next">Look up the next ${Math.min(10, fresh.length)}</button>` : '');
  $('cover-lang').addEventListener('change', (e) => { coverLang = e.target.value; covers(); });
}

async function coversNext(btn) {
  const batch = coverQueue().filter((b) => !coverResults.has(String(b.id)) && !noCover.has(String(b.id))).slice(0, 10);
  btn.disabled = true; stop = false;
  $('cover-prog').hidden = false;
  let found = 0, error = '';
  for (let i = 0; i < batch.length && !stop; i += 1) {
    $('cover-msg').textContent = `Looking up ${i + 1} of ${batch.length}: ${batch[i].title}`;
    $('cover-bar').style.width = `${Math.round((i / batch.length) * 100)}%`;
    try {
      const list = await lookUp(batch[i]);
      if (list.length) { coverResults.set(String(batch[i].id), list); found += 1; } else noCover.add(String(batch[i].id));
    } catch (err) { error = 'Open Library could not be reached. Check your connection and try again in a minute.'; break; }
    await sleep(700);                                   // be polite: about one question a second
  }
  if (!stop) covers(error || `${plural(found, 'book', 'books')} of ${batch.length} had covers on Open Library.`);
}

async function onCover(btn) {
  const section = btn.closest('[data-cover-book]');
  const id = section.dataset.coverBook;
  if (btn.dataset.coverNone !== undefined) { coverResults.delete(id); noCover.add(id); section.remove(); return; }
  const choice = (coverResults.get(id) || [])[Number(btn.dataset.cover)];
  if (!choice) return;
  section.querySelectorAll('button').forEach((el) => { el.disabled = true; });
  try {
    await setCoverUrl(id, choice.full);
    const book = hooks.getBooks().find((b) => String(b.id) === id);
    if (book) book.cover_url = choice.full;
    coverResults.delete(id);
    section.innerHTML = `<p class="tl-ctitle"><b>${esc(book ? book.title : '')}</b><span class="tl-sub">Cover saved ✓</span></p>`;
    changed = true;
  } catch (err) { section.querySelectorAll('button').forEach((el) => { el.disabled = false; }); hooks.handleErr(err); }
}

// ====================================================================
// Wiring
// ====================================================================
let changed = false;                  // a cover was saved: refresh the list when the dialog closes
const TOOLS = { menu, goal, backup, dupes, authors, series, covers };
// Open one tool directly (the Stats page's "Change the goal" link uses this).
export function openTool(name) { if (!TOOLS[name]) return; stop = false; dlg().showModal(); TOOLS[name](); }

export function initTools(h) {
  hooks = h;
  $('tools-btn').addEventListener('click', () => { stop = false; menu(); dlg().showModal(); });
  $('tl-close').addEventListener('click', () => dlg().close());
  dlg().addEventListener('close', () => { stop = true; if (changed) { changed = false; hooks.refresh(); } });
  dlg().addEventListener('click', (e) => {
    const t = (sel) => e.target.closest(sel);
    if (t('[data-tool]')) { stop = true; TOOLS[t('[data-tool]').dataset.tool](); return; }
    if (t('[data-dupe]')) { onDupe(t('[data-dupe]')); return; }
    if (t('[data-author]')) { onAuthor(t('[data-author]')); return; }
    if (t('[data-series]')) { applySeries(t('[data-series]')); return; }
    if (t('[data-covers]')) { coversNext(t('[data-covers]')); return; }
    if (t('[data-cover]') || t('[data-cover-none]')) onCover(t('[data-cover]') || t('[data-cover-none]'));
  });
  dlg().addEventListener('change', (e) => {
    const box = e.target;
    if (box.name && box.name.startsWith('keep-')) keepChoice.set(box.closest('.tl-group').dataset.key, box.value);
    if (box.dataset.merge !== undefined) { if (box.checked) mergePick.add(box.dataset.merge); else mergePick.delete(box.dataset.merge); authorList(); }
    if (box.dataset.seriesComic !== undefined) { seriesComics.set(box.dataset.seriesComic, box.checked); return; }
    if (box.dataset.seriesAll !== undefined || box.dataset.seriesId) onSeriesTick(box);
  });
}
