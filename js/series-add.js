// Dashboard: add a whole short series in one go (Import > A series by hand).
// For comics and book series that no database has: type the details once, give each issue its cover,
// and every issue is created together. "Load from file" fills the form from a small JSON file instead.
import { importBooks, uploadCover, removeCover, esc } from './api.js';
import { shelfKey, seriesCore, issueNo } from './comics.js';

const $ = (id) => document.getElementById(id);
const plural = (n, one, many) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
let hooks = null;      // { getBooks, refresh, toast } from admin.js (through import.js)
let S = null;          // the form's state
let closed = false;

const dlg = () => $('import-panel');
function show(title, body, actions) {
  $('imp-title').textContent = title;
  $('imp-body').innerHTML = body;
  $('imp-actions').innerHTML = actions;
  $('imp-body').scrollTop = 0;
}
const hasSeries = () => { const b = hooks.getBooks(); return b.length > 0 && 'series' in b[0]; };
const hasArc = () => { const b = hooks.getBooks(); return b.length > 0 && 'arc' in b[0]; };

// START-PURE-HELPERS
// The file "Load from file" reads. One series, or a list of them (you then choose one):
//   { "series": "XenoGeist", "author": "Jane Doe", "year": 2024, "language": "English", "arc": "",
//     "comics": true,
//     "issues": [ { "number": 1, "title": "The Signal", "date": "2024-03", "pages": 24,
//                   "author": "", "cover": "https://..." } ] }
// Everything except "series" and "issues" is optional. Returns [{ series, author, year, language, arc, comics, issues }].
export function readSeriesFile(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error('That file is not valid JSON.'); }
  const list = (Array.isArray(data) ? data : (data && Array.isArray(data.series) ? data.series : [data])).filter((x) => x && typeof x === 'object');
  const out = list.map((x) => ({
    series: clean(x.series || x.name),
    author: clean(x.author || x.writer),
    year: /^\d{4}$/.test(String(x.year ?? '')) ? Number(x.year) : null,
    language: x.language === 'Bengali' ? 'Bengali' : 'English',
    arc: clean(x.arc),
    comics: x.comics !== false,
    issues: (Array.isArray(x.issues) ? x.issues : []).filter((i) => i && typeof i === 'object').map((i, n) => ({
      number: clean(i.number ?? n + 1),
      title: clean(i.title || i.name),
      year: /^\d{4}/.test(String(i.date ?? i.year ?? '')) ? Number(String(i.date ?? i.year).slice(0, 4)) : null,
      pages: Number(i.pages) > 0 ? Math.round(Number(i.pages)) : null,
      author: clean(i.author || i.writer),
      link: /^https?:\/\//i.test(String(i.cover || '')) ? String(i.cover).trim() : '',
      about: clean(i.description || i.summary),
    })),
  })).filter((x) => x.series && x.issues.length);
  if (!out.length) throw new Error('No series with issues found in that file.');
  return out;
}
// Which issue is a cover file for? The issue number is read from the file name: "1.png", "vanya-02.jpg",
// "Xenogeist #3 cover.webp". When a name holds several numbers, the last one that is an issue number wins.
// numbers = the issue numbers in the form, as text. Returns the index of the issue, or -1.
export function issueForFile(fileName, numbers) {
  const base = String(fileName || '').replace(/\.[a-z0-9]+$/i, '');
  const found = (base.match(/\d+(?:\.\d+)?/g) || []).map((n) => String(Number(n)));
  const want = numbers.map((n) => (/^\d+(\.\d+)?$/.test(String(n).trim()) ? String(Number(n)) : String(n).trim()));
  for (let i = found.length - 1; i >= 0; i -= 1) { const at = want.indexOf(found[i]); if (at >= 0) return at; }
  return -1;
}
// END-PURE-HELPERS

// Shrink a chosen picture to at most 600px wide and compress it, like the book form does.
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
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  const scale = Math.min(1, 600 / w0);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w0 * scale); canvas.height = Math.round(h0 * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const toBlob = (type, q) => new Promise((r) => canvas.toBlob(r, type, q));
  let blob = await toBlob('image/webp', 0.85);
  if (!blob || blob.type !== 'image/webp') blob = await toBlob('image/jpeg', 0.88);
  if (!blob) throw new Error('could not compress');
  return blob;
}

const blankRow = (n) => ({ number: String(n), title: '', pages: null, year: null, author: '', link: '', about: '', blob: null, preview: '', status: 'want' });

// Keep the list as long as "Number of issues" says; rows already filled in are kept.
function fitRows() {
  const start = issueNo(S.start) ?? 1;
  while (S.rows.length < S.count) S.rows.push(blankRow(start + S.rows.length));
  S.rows.length = S.count;
  if (!S.fromFile) S.rows.forEach((r, i) => { if (!r.touchedNo) r.number = String(start + i); });
}

function form(message = '') {
  const arcs = hasArc();
  show('Add a series', `
    <div class="imp-opts">
      <div class="fgrid">
        <div class="field full"><label for="sa-series">Series name *</label><input id="sa-series" type="text" autocomplete="off" value="${esc(S.series)}" placeholder="e.g. XenoGeist"></div>
        <div class="field full"><label for="sa-author">Writer *</label><input id="sa-author" type="text" autocomplete="off" value="${esc(S.author)}" placeholder="Used for every issue unless a file says otherwise"></div>
        <div class="field"><label for="sa-year">Year</label><input id="sa-year" type="text" inputmode="numeric" maxlength="4" value="${esc(S.year ?? '')}" placeholder="e.g. 2024"></div>
        <div class="field"><label for="sa-lang">Language</label><select id="sa-lang"><option value="English"${S.language === 'English' ? ' selected' : ''}>English</option><option value="Bengali"${S.language === 'Bengali' ? ' selected' : ''}>Bengali</option></select></div>
        <div class="field"><label for="sa-count">Number of issues</label><input id="sa-count" type="number" min="1" max="60" inputmode="numeric" value="${S.count}"></div>
        <div class="field"><label for="sa-start">First issue number</label><input id="sa-start" type="text" inputmode="decimal" value="${esc(S.start)}"></div>
        ${arcs ? `<div class="field full"><label for="sa-arc">Story arc <span class="opt">(optional)</span></label><input id="sa-arc" type="text" autocomplete="off" value="${esc(S.arc)}"></div>` : ''}
        <div class="field"><label for="sa-own">Ownership</label><select id="sa-own"><option value="owned"${S.ownership === 'owned' ? ' selected' : ''}>Owned</option><option value="buy"${S.ownership === 'buy' ? ' selected' : ''}>Want to Buy</option></select></div>
        <div class="field"><label for="sa-copies">Copy</label><select id="sa-copies"><option value="ebook"${S.copies === 'ebook' ? ' selected' : ''}>Ebook (digital)</option><option value="hardcopy"${S.copies === 'hardcopy' ? ' selected' : ''}>Hardcopy</option><option value=""${S.copies === '' ? ' selected' : ''}>Not recorded</option></select></div>
        <div class="field full"><label for="sa-upto">I have read up to</label><select id="sa-upto"></select></div>
      </div>
      <label class="imp-opt"><input type="checkbox" id="sa-comics"${S.comics ? ' checked' : ''}><span>These are comics<span class="hint">Adds the genre “Comics”, so they appear in the Comics section.</span></span></label>
      ${hasSeries() ? '' : '<p class="hint">Series are not switched on in your database yet (Tools → Series), so the issues will be saved without a series name.</p>'}
    </div>
    <p class="err" role="alert" id="sa-err">${esc(message)}</p>
    <p class="tl-note" role="status" id="sa-note"></p>
    <div class="imp-bar"><span id="sa-count-text"></span><button class="btn" type="button" id="sa-covers">Add covers from files</button></div>
    <p class="hint sa-tip">Choose all the cover pictures at once: each goes to the issue whose number is in its file name (1.jpg, vanya-02.png). Or click one cover box, or drop a picture on a row.</p>
    <div class="imp-list" id="sa-list"></div>
    <input id="sa-file" type="file" accept="image/*" hidden>
    <input id="sa-files" type="file" accept="image/*" multiple hidden>
    <input id="sa-json" type="file" accept=".json,application/json" hidden>`,
  '<button class="btn" type="button" id="sa-cancel">Cancel</button><button class="btn" type="button" id="sa-load">Load from file</button><button class="btn primary" type="button" id="sa-save">Add</button>');
  drawRows();
  wire();
}

// Issues the shelf already has (same series, same number) are shown but not added again.
function markExisting() {
  const have = new Set();
  hooks.getBooks().forEach((b) => { const k = shelfKey(b); if (k) have.add(k); if (b.series && b.series_no != null) have.add(`${seriesCore(b.series)}#${Number(b.series_no)}`); });
  const core = seriesCore(S.series);
  S.rows.forEach((r) => { const n = issueNo(r.number); r.existing = Boolean(core && n != null && have.has(`${core}#${n}`)); });
}

function drawRows() {
  fitRows();
  markExisting();
  $('sa-list').innerHTML = S.rows.map((r, i) => `<div class="sa-row${r.existing ? ' off' : ''}" data-row="${i}">
      <button type="button" class="sa-cover" data-cover="${i}" aria-label="Cover for issue ${esc(r.number)}">${r.preview || r.link ? `<img src="${esc(r.preview || r.link)}" alt="">` : '<span>Cover</span>'}</button>
      <div class="sa-fields">
        <div class="sa-line"><label>#<input type="text" inputmode="decimal" data-f="number" value="${esc(r.number)}" aria-label="Issue number"></label>
          <input type="text" data-f="title" value="${esc(r.title)}" placeholder="Issue title (optional)" aria-label="Title of issue ${esc(r.number)}">
          <input type="text" inputmode="numeric" maxlength="4" data-f="year" value="${r.year ?? ''}" placeholder="${esc(S.year ?? 'Year')}" aria-label="Year issue ${esc(r.number)} was published" title="Year this issue was published. Leave empty to use the series year.">
          <input type="number" min="1" inputmode="numeric" data-f="pages" value="${r.pages ?? ''}" placeholder="Pages" aria-label="Pages in issue ${esc(r.number)}"></div>
        <div class="sa-line"><input type="url" data-f="link" value="${esc(r.link)}" placeholder="Or paste a cover image address" aria-label="Cover image address for issue ${esc(r.number)}">
          ${r.existing ? '<span class="hint">Already on your shelf: skipped</span>'
    : `<select data-f="status" aria-label="Reading status of issue ${esc(r.number)}"><option value="want"${r.status === 'want' ? ' selected' : ''}>Want to Read</option><option value="reading"${r.status === 'reading' ? ' selected' : ''}>Reading</option><option value="read"${r.status === 'read' ? ' selected' : ''}>Read</option></select>`}</div>
      </div>
    </div>`).join('');
  const fresh = S.rows.filter((r) => !r.existing).length;
  $('sa-count-text').textContent = `${plural(S.rows.length, 'issue', 'issues')}${fresh < S.rows.length ? `, ${S.rows.length - fresh} already on your shelf` : ''}`;
  $('sa-save').textContent = `Add ${plural(fresh, 'issue', 'issues')}`;
  $('sa-save').disabled = fresh === 0;
  const upto = $('sa-upto');
  const keep = upto.value;
  upto.innerHTML = `<option value="">Nothing yet</option>${S.rows.map((r, i) => `<option value="${i}">#${esc(r.number)}</option>`).join('')}`;
  upto.value = S.rows[Number(keep)] && keep !== '' ? keep : '';
}

async function setCover(i, file) {
  if (!file || !file.type.startsWith('image/')) { $('sa-err').textContent = 'Please choose an image file (JPG, PNG or WebP).'; return; }
  if (file.size > 8 * 1024 * 1024) { $('sa-err').textContent = 'That image is larger than 8 MB. Please choose a smaller one.'; return; }
  try {
    const blob = await processImage(file);
    const r = S.rows[i];
    if (r.preview) URL.revokeObjectURL(r.preview);
    r.blob = blob; r.preview = URL.createObjectURL(blob); r.link = '';
    $('sa-err').textContent = '';
    drawRows();
  } catch (e) { $('sa-err').textContent = 'Could not read that image. Try a different file.'; }
}

// Several cover files at once. Each goes to the issue named in its file name. If no name carries an
// issue number at all, the files are taken in name order: first file to the first issue, and so on.
async function addCovers(files) {
  const images = files.filter((f) => f.type.startsWith('image/')).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!images.length) { $('sa-err').textContent = 'Please choose image files (JPG, PNG or WebP).'; return; }
  const numbers = S.rows.map((r) => r.number);
  let pairs = images.map((file) => [file, issueForFile(file.name, numbers)]);
  let note = '';
  if (pairs.every(([, at]) => at < 0)) {
    pairs = images.slice(0, S.rows.length).map((file, i) => [file, i]);
    note = ' No file name had an issue number, so they were placed in name order. Check them.';
  }
  const taken = new Set();
  let done = 0, bad = 0;
  const left = [];
  for (const [file, at] of pairs) {
    if (at < 0 || taken.has(at)) { left.push(file.name); continue; }
    taken.add(at);
    $('sa-err').textContent = '';
    $('sa-note').textContent = `Preparing covers: ${done + 1} of ${pairs.length}\u2026`;
    try {
      const blob = await processImage(file);
      const r = S.rows[at];
      if (r.preview) URL.revokeObjectURL(r.preview);
      r.blob = blob; r.preview = URL.createObjectURL(blob); r.link = '';
      done += 1;
    } catch (e) { bad += 1; }
  }
  drawRows();
  $('sa-note').textContent = `${plural(done, 'cover', 'covers')} added.${note}${left.length ? ` Not placed (no matching issue number): ${left.slice(0, 6).join(', ')}${left.length > 6 ? '\u2026' : ''}.` : ''}${bad ? ` ${plural(bad, 'file', 'files')} could not be read.` : ''}`;
}

function readDetails() {
  S.series = clean($('sa-series').value);
  S.author = clean($('sa-author').value);
  S.year = /^\d{4}$/.test($('sa-year').value.trim()) ? Number($('sa-year').value.trim()) : null;
  S.language = $('sa-lang').value;
  S.arc = $('sa-arc') ? clean($('sa-arc').value) : '';
  S.ownership = $('sa-own').value;
  S.copies = $('sa-copies').value;
  S.comics = $('sa-comics').checked;
}

function wire() {
  let coverFor = 0;
  $('sa-cancel').addEventListener('click', () => dlg().close());
  $('sa-series').addEventListener('change', () => { readDetails(); drawRows(); });
  $('sa-year').addEventListener('change', () => { readDetails(); drawRows(); });      // the rows show the series year as their hint
  const resize = () => {
    S.count = Math.max(1, Math.min(60, Math.round(Number($('sa-count').value)) || 1));
    S.start = $('sa-start').value.trim() || '1';
    S.fromFile = false;
    drawRows();
  };
  $('sa-count').addEventListener('change', resize);
  $('sa-start').addEventListener('change', resize);
  $('sa-upto').addEventListener('change', (e) => {
    const at = e.target.value === '' ? -1 : Number(e.target.value);
    S.rows.forEach((r, i) => { r.status = i <= at ? 'read' : 'want'; });
    drawRows();
    $('sa-upto').value = e.target.value;
  });
  const list = $('sa-list');
  list.addEventListener('change', (e) => {
    const row = e.target.closest('[data-row]'); const f = e.target.dataset.f;
    if (!row || !f) return;
    const r = S.rows[Number(row.dataset.row)];
    if (f === 'pages') r.pages = Number(e.target.value) > 0 ? Math.round(Number(e.target.value)) : null;
    else if (f === 'year') {      // each issue can have its own year; empty means "use the series year"
      const y = e.target.value.trim();
      r.year = /^\d{4}$/.test(y) ? Number(y) : null;
      e.target.setAttribute('aria-invalid', String(Boolean(y) && r.year === null));
    }
    else if (f === 'link') { r.link = /^https?:\/\//i.test(e.target.value.trim()) ? e.target.value.trim() : ''; if (r.link) { r.blob = null; r.preview = ''; } drawRows(); }
    else if (f === 'number') { r.number = clean(e.target.value); r.touchedNo = true; drawRows(); }
    else r[f] = f === 'status' ? e.target.value : clean(e.target.value);
  });
  list.addEventListener('click', (e) => { const b = e.target.closest('[data-cover]'); if (b) { coverFor = Number(b.dataset.cover); $('sa-file').click(); } });
  $('sa-file').addEventListener('change', () => { setCover(coverFor, $('sa-file').files[0]); $('sa-file').value = ''; });
  ['dragenter', 'dragover'].forEach((ev) => list.addEventListener(ev, (e) => { const b = e.target.closest('[data-row]'); if (b) { e.preventDefault(); b.classList.add('over'); } }));
  ['dragleave', 'drop'].forEach((ev) => list.addEventListener(ev, (e) => { const b = e.target.closest('[data-row]'); if (b) b.classList.remove('over'); }));
  list.addEventListener('drop', (e) => {
    const row = e.target.closest('[data-row]');
    if (!row) return;
    e.preventDefault();
    const i = Number(row.dataset.row);
    if (e.dataTransfer.files.length) { setCover(i, e.dataTransfer.files[0]); return; }
    const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');     // a picture dragged from another tab
    if (/^https?:\/\//i.test(url || '')) { const r = S.rows[i]; r.link = url.trim(); r.blob = null; r.preview = ''; drawRows(); }
  });
  $('sa-covers').addEventListener('click', () => $('sa-files').click());
  $('sa-files').addEventListener('change', () => { addCovers([...$('sa-files').files]); $('sa-files').value = ''; });
  $('sa-load').addEventListener('click', () => $('sa-json').click());
  $('sa-json').addEventListener('change', async () => {
    const file = $('sa-json').files[0];
    $('sa-json').value = '';
    if (!file) return;
    try { chooseFromFile(readSeriesFile(await file.text())); }
    catch (err) { $('sa-err').textContent = err.message; }
  });
  $('sa-save').addEventListener('click', save);
}

// A file can hold several series: fill the form from the one chosen.
function chooseFromFile(list) {
  const use = (x) => {
    S = { ...S, series: x.series, author: x.author || S.author, year: x.year, language: x.language, arc: x.arc, comics: x.comics, fromFile: true,
      count: Math.min(60, x.issues.length), start: x.issues[0].number || '1',
      rows: x.issues.slice(0, 60).map((i) => ({ ...blankRow(1), ...i, touchedNo: true })) };
    form(x.issues.length > 60 ? 'Only the first 60 issues were loaded. Add the rest in a second go.' : '');
  };
  if (list.length === 1) { use(list[0]); return; }
  show('Add a series', `<p style="margin-top:0">That file holds ${list.length} series. Which one do you want to add now?</p>
    <div class="imp-list">${list.map((x, i) => `<button type="button" class="cv-row sa-pick" data-pick="${i}"><span></span><span><b>${esc(x.series)}</b><span class="hint">${plural(x.issues.length, 'issue', 'issues')}${x.author ? ` · ${esc(x.author)}` : ''}${x.year ? ` · ${x.year}` : ''}</span></span></button>`).join('')}</div>`,
  '<button class="btn" type="button" id="sa-back">Back</button>');
  $('sa-back').addEventListener('click', () => form());
  $('imp-body').querySelector('.imp-list').addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (b) use(list[Number(b.dataset.pick)]); });
}

async function save() {
  readDetails();
  if (!S.series) { $('sa-err').textContent = 'Please enter the series name.'; $('sa-series').focus(); return; }
  drawRows();                                                   // the series name decides which issues already exist
  const todo = S.rows.filter((r) => !r.existing);
  if (!todo.length) { $('sa-err').textContent = 'Every one of these issues is already on your shelf.'; return; }
  if (!S.author && todo.some((r) => !r.author)) { $('sa-err').textContent = 'Please enter the writer.'; $('sa-author').focus(); return; }
  if ($('sa-year').value.trim() && S.year === null) { $('sa-err').textContent = 'Enter a 4-digit year, like 2024.'; $('sa-year').focus(); return; }
  if ([...$('sa-list').querySelectorAll('[data-f="year"]')].some((el) => el.value.trim() && !/^\d{4}$/.test(el.value.trim()))) { $('sa-err').textContent = 'An issue has a year that is not 4 digits. Fix it or clear it.'; return; }
  const numbers = todo.map((r) => r.number);
  if (numbers.some((n) => !n) || new Set(numbers).size !== numbers.length) { $('sa-err').textContent = 'Each issue needs its own number.'; return; }
  const withSeries = hasSeries(), withArc = hasArc();
  const uploaded = [];
  show('Adding', '<div class="imp-center"><p id="imp-msg">Saving…</p><div class="progress"><i id="imp-prog"></i></div></div>', '');
  const tick = (text, done, total) => { if ($('imp-msg')) $('imp-msg').textContent = text; if ($('imp-prog')) $('imp-prog').style.width = `${total ? Math.round((done / total) * 100) : 0}%`; };
  try {
    const covers = todo.filter((r) => r.blob);
    for (let i = 0; i < covers.length; i += 1) {
      if (closed) throw new Error('Stopped.');
      tick(`Uploading covers: ${i + 1} of ${covers.length}`, i, covers.length);
      covers[i].path = await uploadCover(covers[i].blob);
      uploaded.push(covers[i].path);
    }
    tick('Saving the issues…', 1, 1);
    const rows = todo.map((r, i) => ({
      id: crypto.randomUUID(),
      title: `${S.series} #${r.number}`,
      author: r.author || S.author,
      pub_year: r.year || S.year,
      pages: r.pages, duration: null, language: S.language, format: 'Book',
      status: r.status, ownership: S.ownership, youtube_url: null,
      description: [r.title, r.about].filter(Boolean).join('\n\n') || null,
      genres: S.comics ? ['Comics'] : [], copies: S.copies ? [S.copies] : [], finished_at: null, isbn: null,
      cover_url: r.path ? null : (r.link || null), cover_path: r.path || null,
      ...(withSeries ? { series: S.series, series_no: issueNo(r.number) } : {}),
      ...(withArc ? { arc: S.arc || null, arc_no: S.arc ? i + 1 : null } : {}),
    }));
    const saved = await importBooks(rows);
    await hooks.refresh();
    show('Done', `<div class="imp-center"><p><b>${plural(saved, 'issue', 'issues')} added</b> to “${esc(S.series)}”.</p>
      ${rows.some((r) => r.status === 'read') ? '<p class="hint">Issues marked Read have no finish date. Add one in the book form if you want them in the yearly stats.</p>' : ''}</div>`,
    '<button class="btn" type="button" id="sa-more">Add another series</button><button class="btn primary" type="button" id="sa-done">Done</button>');
    $('sa-more').addEventListener('click', () => { start(); });
    $('sa-done').addEventListener('click', () => dlg().close());
  } catch (err) {
    uploaded.forEach((path) => removeCover(path));               // do not leave cover files behind for issues that were not saved
    S.rows.forEach((r) => { delete r.path; });
    if (!closed) form(`Could not save: ${err.message || err}`);
  }
}

function start() {
  S = { series: '', author: '', year: null, language: 'English', arc: '', ownership: 'owned', copies: 'ebook', comics: true, count: 4, start: '1', rows: [], fromFile: false };
  form();
}

// Called by the Import dialog's "A series by hand" choice.
export function openSeriesAdd(h) {
  hooks = h;
  closed = false;
  if (!dlg().dataset.saBound) { dlg().dataset.saBound = '1'; dlg().addEventListener('close', () => { closed = true; }); }
  start();
}
