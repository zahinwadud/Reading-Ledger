// Dashboard: import comic issues from Comic Vine (comicvine.gamespot.com).
// You search for a series or a story arc, choose the issues, check the list, and only then are they saved.
//
// The Comic Vine key is personal. It is typed into the dashboard once and kept in this browser only
// (never in config.js, so it never reaches the public repository).
import { importBooks, patchBook, coverOf, esc, norm } from './api.js';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const KEY_NAME = 'rl-comicvine-key';
let hooks = null;      // { getBooks, refresh, toast } from admin.js (through import.js)
let S = null;          // the import in progress
let stopped = false;   // the dialog was closed: end any running job

const dlg = () => $('import-panel');
function show(title, body, actions) {
  $('imp-title').textContent = title;
  $('imp-body').innerHTML = body;
  $('imp-actions').innerHTML = actions;
  $('imp-body').scrollTop = 0;
}
const getKey = () => { try { return localStorage.getItem(KEY_NAME) || ''; } catch (e) { return ''; } };
const hasSeries = () => { const b = hooks.getBooks(); return b.length > 0 && 'series' in b[0]; };

// ---------- talking to Comic Vine ----------
// Comic Vine answers web pages through "JSONP": the reply arrives as a small script that calls a
// function we name. Requests are spaced about a second apart, as Comic Vine asks.
let lastCall = 0;
let callNo = 0;
async function cv(path, params) {
  const wait = lastCall + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  return new Promise((resolve, reject) => {
    const name = `rlComicVine${Date.now()}n${callNo += 1}`;
    const script = document.createElement('script');
    const finish = (err, data) => { clearTimeout(timer); delete window[name]; script.remove(); if (err) reject(err); else resolve(data); };
    const timer = setTimeout(() => finish(new Error('Comic Vine took too long to answer. Try again in a minute.')), 25000);
    window[name] = (data) => {
      if (data && data.status_code === 1) finish(null, data);
      else finish(new Error(data && data.status_code === 100 ? 'Comic Vine did not accept the key. Check it and save it again.' : `Comic Vine said: ${(data && data.error) || 'unknown error'}`));
    };
    script.onerror = () => finish(new Error('Comic Vine refused the request. Most often the key is wrong; it can also mean too many requests in a short time.'));
    script.src = `https://comicvine.gamespot.com/api/${path}/?${new URLSearchParams({ ...params, api_key: getKey(), format: 'jsonp', json_callback: name })}`;
    document.head.appendChild(script);
  });
}

// START-PURE-HELPERS
// "608", "608.1", "½" -> a number, or null when the issue number is not a plain number ("Annual", "1A")
export function issueNo(text) {
  const t = String(text ?? '').trim();
  if (t === '½') return 0.5;
  return /^\d+(\.\d+)?$/.test(t) ? Number(t) : null;
}
// The writers among an issue's credits: [{ name, role: "writer, cover" }, ...] -> "Jeph Loeb"
export function writersOf(credits) {
  const people = Array.isArray(credits) ? credits : [];
  const has = (p, word) => String(p.role || '').toLowerCase().split(/[,/]\s*/).includes(word);
  const pick = people.filter((p) => has(p, 'writer'));
  const list = pick.length ? pick : people.filter((p) => has(p, 'artist') || has(p, 'penciler'));
  return list.slice(0, 3).map((p) => String(p.name || '').trim()).filter(Boolean).join(', ');
}
// Comic Vine descriptions are HTML: keep the words only.
export function plainText(html, max = 1200) {
  const text = String(html || '').replace(/<(br|\/p|\/h\d|\/li)\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&lsquo;/g, '’').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  return text.length > max ? `${text.slice(0, max).replace(/\s+\S*$/, '')}…` : text;
}
const imageOf = (img, size) => (img && (img[`${size}_url`] || img.medium_url || img.small_url || img.original_url)) || '';
// One issue as Comic Vine sends it -> the few things the review list needs
export function tidyIssue(raw) {
  return {
    id: raw.id,
    number: String(raw.issue_number ?? '').trim(),
    no: issueNo(raw.issue_number),
    name: String(raw.name || '').trim(),
    date: String(raw.cover_date || raw.store_date || '').slice(0, 10),
    thumb: imageOf(raw.image, 'small'),
    cover: imageOf(raw.image, 'medium'),
    volume: (raw.volume && raw.volume.name) || '',
  };
}
// "Batman (1940-2011)" and "Batman" are the same series: compare names without the bracketed part.
export const seriesCore = (name) => String(name || '').normalize('NFC').toLowerCase().replace(/\([^()]*\)/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// A book already on the shelf, as "series core#number" (from a title like "Batman #608", or its series fields).
export function shelfKey(b) {
  const m = String(b.title || '').match(/^(.+?)\s*#\s*(\d+(?:\.\d+)?)\s*$/);
  if (m) return `${seriesCore(m[1])}#${Number(m[2])}`;
  return b.series && b.series_no != null ? `${seriesCore(b.series)}#${Number(b.series_no)}` : '';
}
// END-PURE-HELPERS

// ---------- step 1: the key ----------
function stepKey(message = '') {
  show('Import comics', `
    <p style="margin-top:0">Comics come from <b>Comic Vine</b>, a large comics database. It needs your free personal key.</p>
    <ol class="imp-steps"><li>Sign in at comicvine.gamespot.com and open <b>comicvine.gamespot.com/api</b>.</li><li>Copy the long code shown as your API key and paste it below.</li></ol>
    <div class="field"><label for="cv-key">Comic Vine API key</label><input id="cv-key" type="password" autocomplete="off" spellcheck="false" value="${esc(getKey())}"></div>
    <p class="hint">The key is saved in this browser only. It is not written to the site's files, so it never appears on GitHub. On another device you paste it once more.</p>
    <p class="err" role="alert">${esc(message)}</p>`,
  `<button class="btn" type="button" id="cv-cancel">Cancel</button>${getKey() ? '<button class="btn" type="button" id="cv-forget">Forget the key</button>' : ''}<button class="btn primary" type="button" id="cv-save">Save and continue</button>`);
  $('cv-cancel').addEventListener('click', () => dlg().close());
  if ($('cv-forget')) $('cv-forget').addEventListener('click', () => { try { localStorage.removeItem(KEY_NAME); } catch (e) { /* ignore */ } stepKey('The key was removed from this browser.'); });
  $('cv-save').addEventListener('click', () => {
    const key = $('cv-key').value.trim();
    if (!/^[0-9a-f]{30,50}$/i.test(key)) { stepKey('That does not look like a Comic Vine key (a long code of letters a–f and digits).'); return; }
    try { localStorage.setItem(KEY_NAME, key); } catch (e) { stepKey('This browser would not save the key (storage is blocked).'); return; }
    stepSearch();
  });
}

// ---------- step 2: search ----------
function stepSearch(message = '') {
  show('Import comics', `
    <p style="margin-top:0">Search for a series (like <i>Batman</i>) or a story arc (like <i>Batman: Hush</i>).</p>
    <form id="cv-form" class="genre-add"><input id="cv-q" type="search" placeholder="Series or story arc" autocomplete="off" aria-label="Series or story arc" value="${esc(S.query || '')}"><button class="btn primary" type="submit">Search</button></form>
    <p class="err" role="alert">${esc(message)}</p>
    <div id="cv-results" class="imp-list">${resultsHtml()}</div>`,
  '<button class="btn" type="button" id="cv-cancel">Cancel</button><button class="btn" type="button" id="cv-key-btn">Change key</button>');
  $('cv-cancel').addEventListener('click', () => dlg().close());
  $('cv-key-btn').addEventListener('click', () => stepKey());
  $('cv-form').addEventListener('submit', (e) => { e.preventDefault(); search(); });
  $('cv-results').addEventListener('click', (e) => { const row = e.target.closest('[data-pick]'); if (row) pick(S.results[Number(row.dataset.pick)]); });
  $('cv-q').focus();
}

function resultsHtml() {
  if (!S.results) return '';
  if (!S.results.length) return '<p class="hint">Nothing found. Try fewer words.</p>';
  return S.results.map((r, i) => `<button type="button" class="cv-row" data-pick="${i}">
      <span class="thumb">${r.thumb ? `<img src="${esc(r.thumb)}" alt="" loading="lazy">` : ''}</span>
      <span><b>${esc(r.name)}${r.year ? ` (${esc(r.year)})` : ''}</b>
        <span class="hint">${r.arc ? 'Story arc' : 'Series'}${r.publisher ? ` · ${esc(r.publisher)}` : ''}${r.count ? ` · ${plural(r.count, 'issue', 'issues')}` : ''}</span>
        ${r.deck ? `<span class="hint">${esc(r.deck)}</span>` : ''}</span>
    </button>`).join('');
}

async function search() {
  const q = $('cv-q').value.trim();
  if (!q) return;
  S.query = q;
  $('cv-results').innerHTML = '<p class="hint">Searching…</p>';
  try {
    const data = await cv('search', { query: q, resources: 'volume,story_arc', limit: '20', field_list: 'id,name,start_year,publisher,count_of_issues,image,deck,resource_type' });
    S.results = (data.results || []).map((r) => ({
      id: r.id, arc: r.resource_type === 'story_arc', name: r.name || '', year: r.start_year || '', count: Number(r.count_of_issues) || 0,
      publisher: (r.publisher && r.publisher.name) || '', deck: plainText(r.deck, 140), thumb: imageOf(r.image, 'thumb'),
    }));
    // series with the most issues first; story arcs keep Comic Vine's order after them
    S.results.sort((a, b) => (a.arc ? 1 : 0) - (b.arc ? 1 : 0) || b.count - a.count);
    if (!stopped) $('cv-results').innerHTML = resultsHtml();
  } catch (err) { if (!stopped) stepSearch(err.message); }
}

// ---------- step 3: fetch the issues ----------
function stepRange(item) {
  show(item.name, `
    <p style="margin-top:0"><b>${esc(item.name)}</b>${item.year ? ` (${esc(item.year)})` : ''} has ${plural(item.count, 'issue', 'issues')}. Which ones do you want?</p>
    <div class="fgrid"><div class="field"><label for="cv-from">From issue</label><input id="cv-from" type="text" inputmode="decimal" placeholder="e.g. 608"></div>
      <div class="field"><label for="cv-to">To issue</label><input id="cv-to" type="text" inputmode="decimal" placeholder="e.g. 619"></div></div>
    <p class="hint">Leave both empty for every issue. A long series is read from Comic Vine 100 issues at a time, about a second each.</p>
    <p class="err" role="alert" id="cv-range-err"></p>`,
  '<button class="btn" type="button" id="cv-back">Back</button><button class="btn primary" type="button" id="cv-go">Show the issues</button>');
  $('cv-back').addEventListener('click', () => stepSearch());
  $('cv-go').addEventListener('click', () => {
    const from = $('cv-from').value.trim(), to = $('cv-to').value.trim();
    if ((from && issueNo(from) === null) || (to && issueNo(to) === null)) { $('cv-range-err').textContent = 'Use plain numbers, like 608.'; return; }
    loadVolume(item, from ? issueNo(from) : -Infinity, to ? issueNo(to) : Infinity);
  });
}

function stepBusy(title, message) {
  show(title, `<div class="imp-center"><p id="imp-msg">${esc(message)}</p><div class="progress"><i id="imp-prog"></i></div></div>`, '<button class="btn" type="button" id="cv-stop">Stop</button>');
  $('cv-stop').addEventListener('click', () => { S.run += 1; stepSearch('Stopped.'); });
}
function tick(text, done, total) {
  if ($('imp-msg')) $('imp-msg').textContent = text;
  if ($('imp-prog')) $('imp-prog').style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
}

const ISSUE_FIELDS = 'id,name,issue_number,cover_date,store_date,image,volume';
// Each job gets a number; pressing Stop (or starting another job) raises it, and the old job then ends quietly.
const stale = (run) => stopped || S.run !== run;
async function loadVolume(item, from, to) {
  const run = (S.run += 1);
  stepBusy(item.name, 'Reading the issue list…');
  try {
    const all = [];
    for (let offset = 0; offset < Math.max(item.count, 1) && offset < 3000 && !stale(run); offset += 100) {
      const data = await cv('issues', { filter: `volume:${item.id}`, sort: 'cover_date:asc', limit: '100', offset: String(offset), field_list: ISSUE_FIELDS });
      all.push(...(data.results || []));
      const total = Number(data.number_of_total_results) || item.count;
      tick(`Read ${Math.min(all.length, total)} of ${total} issues`, all.length, total);
      if (!(data.results || []).length || all.length >= total) break;
    }
    if (stale(run)) return;
    const issues = all.map(tidyIssue).filter((x) => (from === -Infinity && to === Infinity) || (x.no !== null && x.no >= from && x.no <= to));
    issues.sort((a, b) => (a.no ?? Infinity) - (b.no ?? Infinity) || a.date.localeCompare(b.date));
    startReview(item.name, issues, true, true);
  } catch (err) { if (!stale(run)) stepSearch(err.message); }
}

async function loadArc(item) {
  const run = (S.run += 1);
  stepBusy(item.name, 'Reading the story arc…');
  try {
    const arc = await cv(`story_arc/4045-${item.id}`, { field_list: 'id,name,issues' });
    const ids = ((arc.results && arc.results.issues) || []).map((x) => x.id).filter(Boolean);
    if (!ids.length) { stepSearch('Comic Vine lists no issues for that story arc. Try searching for the series instead.'); return; }
    const found = [];
    for (let i = 0; i < ids.length && !stale(run); i += 100) {
      const data = await cv('issues', { filter: `id:${ids.slice(i, i + 100).join('|')}`, limit: '100', field_list: ISSUE_FIELDS });
      found.push(...(data.results || []));
      tick(`Read ${found.length} of ${ids.length} issues`, found.length, ids.length);
    }
    if (stale(run)) return;
    const byId = new Map(found.map((x) => [x.id, x]));
    const issues = ids.map((id) => byId.get(id)).filter(Boolean).map(tidyIssue);          // keep the arc's reading order
    const oneVolume = new Set(issues.map((x) => x.volume)).size === 1 && issues.every((x) => x.no !== null);
    if (oneVolume) issues.sort((a, b) => a.no - b.no);
    startReview(item.name, issues, oneVolume);
  } catch (err) { if (!stale(run)) stepSearch(err.message); }
}

function pick(item) { if (item.arc) loadArc(item); else if (item.count > 40) stepRange(item); else loadVolume(item, -Infinity, Infinity); }

// ---------- step 4: review ----------
// useNumbers = the series number is the comic's own issue number; otherwise it is the place in the list.
// fromSeries = the issues all come from the one series that was picked (their titles then follow the series name you type).
function startReview(name, issues, useNumbers, fromSeries = false) {
  if (!issues.length) { stepSearch('No issues matched. Check the issue numbers.'); return; }
  // Issues already on the shelf are not added again; they can receive their cover instead.
  const have = new Map();
  hooks.getBooks().forEach((b) => { const k = shelfKey(b); if (k && !have.has(k)) have.set(k, b); if (b.series && b.series_no != null) { const k2 = `${seriesCore(b.series)}#${Number(b.series_no)}`; if (!have.has(k2)) have.set(k2, b); } });
  S.series = name;
  S.useNumbers = useNumbers;
  S.fromSeries = fromSeries;
  S.rows = issues.map((x, i) => {
    const seriesNo = useNumbers ? x.no : i + 1;
    const title = `${x.volume || name} #${x.number || i + 1}`;
    const existing = (x.no != null && (have.get(`${seriesCore(x.volume || name)}#${x.no}`) || have.get(`${seriesCore(name)}#${x.no}`))) || null;
    const needsCover = Boolean(existing && !coverOf(existing) && x.cover);
    return { ...x, seriesNo, title, existing, needsCover, sel: existing ? needsCover : true, status: 'want' };
  });
  stepReview();
}

function stepReview() {
  const rows = S.rows;
  const numbered = rows.filter((r) => r.seriesNo != null);
  show('Check the list', `
    <div class="imp-opts">
      <div class="field"><label for="cv-series">Series name on your site</label><input id="cv-series" type="text" value="${esc(S.series)}"></div>
      <div class="fgrid">
        <div class="field"><label for="cv-own">Ownership</label><select id="cv-own"><option value="owned">Owned</option><option value="buy">Want to Buy</option></select></div>
        <div class="field"><label for="cv-copies">Copy</label><select id="cv-copies"><option value="ebook">Ebook (digital)</option><option value="hardcopy">Hardcopy</option><option value="">Not recorded</option></select></div>
      </div>
      ${numbered.length ? `<div class="field"><label for="cv-upto">I have read up to</label><select id="cv-upto"><option value="">Nothing yet</option>${numbered.map((r) => `<option value="${r.seriesNo}">#${esc(r.seriesNo)}</option>`).join('')}</select><p class="hint">Marks every issue up to that one as Read. You can still change each issue below.</p></div>` : ''}
      <label class="imp-opt"><input type="checkbox" id="cv-writers" checked><span>Look up the writers and summaries<span class="hint">One extra question to Comic Vine per issue, about a second each. Without it the author is saved as “Unknown”.</span></span></label>
      ${hasSeries() ? '' : '<p class="hint">Series are not switched on in your database yet (Tools → Series), so the issues will be saved without a series name.</p>'}
    </div>
    <div class="imp-bar"><span id="cv-count"></span><span><button class="btn" type="button" id="cv-all">All</button> <button class="btn" type="button" id="cv-none">None</button></span></div>
    <div class="imp-list" id="cv-list"></div>`,
  '<button class="btn" type="button" id="cv-back">Back</button><button class="btn primary" type="button" id="cv-import">Import</button>');
  const draw = () => {
    $('cv-list').innerHTML = rows.map((r, i) => `<div class="cv-issue${r.sel ? '' : ' off'}">
        <input type="checkbox" data-sel="${i}" aria-label="Import ${esc(r.title)}"${r.sel ? ' checked' : ''}${r.existing && !r.needsCover ? ' disabled' : ''}>
        <span class="thumb">${r.thumb ? `<img src="${esc(r.thumb)}" alt="" loading="lazy">` : ''}</span>
        <span class="cv-info"><b>${esc(r.title)}</b>${r.name ? `<span class="hint">${esc(r.name)}</span>` : ''}<span class="hint">${esc(r.date.slice(0, 7))}</span></span>
        ${r.existing
    ? `<span class="hint cv-have">${r.needsCover ? 'On your shelf already:<br>only its cover is added' : 'On your shelf already,<br>with a cover'}</span>`
    : `<select data-status="${i}" aria-label="Reading status of ${esc(r.title)}"><option value="want"${r.status === 'want' ? ' selected' : ''}>Want to Read</option><option value="reading"${r.status === 'reading' ? ' selected' : ''}>Reading</option><option value="read"${r.status === 'read' ? ' selected' : ''}>Read</option></select>`}
      </div>`).join('');
    const n = rows.filter((r) => r.sel).length;
    $('cv-count').textContent = `${n} of ${rows.length} selected`;
    $('cv-import').disabled = n === 0;
    const fresh = rows.filter((r) => r.sel && !r.existing).length;
    $('cv-import').textContent = fresh === n ? `Import ${plural(n, 'issue', 'issues')}` : fresh ? `Import ${fresh} and add ${n - fresh} ${n - fresh === 1 ? 'cover' : 'covers'}` : `Add ${plural(n, 'cover', 'covers')}`;
  };
  draw();
  $('cv-list').addEventListener('change', (e) => {
    if (e.target.dataset.sel !== undefined) { rows[Number(e.target.dataset.sel)].sel = e.target.checked; draw(); }
    if (e.target.dataset.status !== undefined) rows[Number(e.target.dataset.status)].status = e.target.value;
  });
  $('cv-all').addEventListener('click', () => { rows.forEach((r) => { r.sel = !r.existing || r.needsCover; }); draw(); });
  $('cv-none').addEventListener('click', () => { rows.forEach((r) => { r.sel = false; }); draw(); });
  if ($('cv-upto')) $('cv-upto').addEventListener('change', (e) => {
    const upto = e.target.value === '' ? -Infinity : Number(e.target.value);
    rows.forEach((r) => { if (r.seriesNo != null) r.status = r.seriesNo <= upto ? 'read' : 'want'; });
    draw();
  });
  $('cv-back').addEventListener('click', () => stepSearch());
  $('cv-import').addEventListener('click', runImport);
}

// ---------- step 5: save ----------
async function runImport() {
  const picked = S.rows.filter((r) => r.sel);
  const chosen = picked.filter((r) => !r.existing);                  // new issues to add
  const covers = picked.filter((r) => r.existing && r.needsCover);   // issues already on the shelf: cover only
  const series = $('cv-series').value.replace(/\s+/g, ' ').trim() || S.series;
  const ownership = $('cv-own').value;
  const copies = $('cv-copies').value ? [$('cv-copies').value] : [];
  const details = $('cv-writers').checked;
  const run = (S.run += 1);
  stepBusy('Importing', details ? 'Looking up the writers…' : 'Saving…');
  if (details) {
    for (let i = 0; i < chosen.length && !stale(run); i += 1) {
      tick(`Looking up ${i + 1} of ${chosen.length}: ${chosen[i].title}`, i, chosen.length);
      try {
        const d = (await cv(`issue/4000-${chosen[i].id}`, { field_list: 'person_credits,deck,description' })).results || {};
        chosen[i].author = writersOf(d.person_credits);
        chosen[i].about = plainText(d.deck || d.description);
      } catch (err) { chosen[i].author = ''; }             // one missing answer should not stop the import
    }
    if (stale(run)) return;
  }
  const withSeries = hasSeries();
  const rows = chosen.map((r) => ({
    id: crypto.randomUUID(),
    title: S.fromSeries ? `${series} #${r.number}` : r.title,
    author: r.author || 'Unknown',
    pub_year: /^\d{4}/.test(r.date) ? Number(r.date.slice(0, 4)) : null,
    pages: null, duration: null, language: 'English', format: 'Book',
    status: r.status, ownership, youtube_url: null,
    description: [r.name, r.about].filter(Boolean).join('\n\n') || null,
    genres: ['Comics'], copies, finished_at: null, isbn: null,
    cover_url: r.cover || null, cover_path: null,
    ...(withSeries ? { series, series_no: r.seriesNo } : {}),
  }));
  tick('Saving…', 1, 1);
  try {
    const saved = rows.length ? await importBooks(rows) : 0;
    let covered = 0;
    for (const r of covers) {
      if (stale(run)) break;
      tick(`Adding covers: ${covered + 1} of ${covers.length}`, covered, covers.length);
      await patchBook(r.existing.id, { cover_url: r.cover });
      covered += 1;
    }
    await hooks.refresh();
    const unknown = rows.filter((r) => r.author === 'Unknown').length;
    show('Done', `<div class="imp-center"><p><b>${[saved ? `${plural(saved, 'issue', 'issues')} added${withSeries ? ` to “${esc(series)}”` : ''}` : '', covered ? `${plural(covered, 'cover', 'covers')} added to issues you already had` : ''].filter(Boolean).join(', and ')}</b>.</p>
      ${unknown ? `<p class="hint">${plural(unknown, 'issue has', 'issues have')} no writer on Comic Vine and were saved as “Unknown”.</p>` : ''}
      ${saved ? '<p class="hint">Issues marked Read have no finish date. Add one in the book form if you want them in the yearly stats.</p>' : ''}</div>`,
    '<button class="btn" type="button" id="cv-more">Import more</button><button class="btn primary" type="button" id="cv-done">Done</button>');
    $('cv-more').addEventListener('click', () => { S.results = null; S.query = ''; stepSearch(); });
    $('cv-done').addEventListener('click', () => dlg().close());
  } catch (err) {
    stepSearch(`Could not save: ${err.message || err}${err.saved ? ` (${err.saved} were saved before the error)` : ''}`);
    if (err.saved) hooks.refresh();
  }
}

// Called by the Import dialog's "Comics" choice.
export function openComics(h) {
  hooks = h;
  stopped = false;
  S = { query: '', results: null, rows: [], series: '', run: 0 };
  if (!dlg().dataset.cvBound) { dlg().dataset.cvBound = '1'; dlg().addEventListener('close', () => { stopped = true; }); }
  if (getKey()) stepSearch(); else stepKey();
}
