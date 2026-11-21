// Dashboard: the "Reader file" box in Edit book (21 November 2026).
// Adds, replaces or removes the book's file in the private Backblaze bucket (through the Edge Function
// "book-file"), and links to the reader. Only shown when editing a book that is already saved.
import { esc, fileOf, uploadBookFile, bookFileAction } from './api.js';

const $ = (id) => document.getElementById(id);
const mb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const MAX = 50 * 1048576;     // the Edge Function reads the whole file at once; bigger files come later
let book = null, toast = () => {}, ticket = 0;

// Books that have a file, remembered for the public site's Read button (same list the reader keeps).
function remember(id, has) {
  try {
    const s = JSON.parse(localStorage.getItem('rl-reader-files') || '{"ids":[]}');
    const ids = new Set(s.ids || []); if (has) ids.add(id); else ids.delete(id);
    localStorage.setItem('rl-reader-files', JSON.stringify({ ids: [...ids], at: Date.now() }));
  } catch (e) { /* storage blocked */ }
}

function draw(file, note) {
  const box = $('g-file');
  if (!box) return;
  box.hidden = false;
  if (!book) { $('rf-state').textContent = 'Save the book first, then add its file here.'; $('rf-acts').hidden = true; return; }
  $('rf-acts').hidden = false;
  $('rf-state').innerHTML = note || (file
    ? `<b>${esc(file.kind.toUpperCase())}</b> · ${mb(file.size)} · added ${esc(String(file.uploaded_at).slice(0, 10))}${file.name ? ` · <span class="hint">${esc(file.name)}</span>` : ''}`
    : 'No file yet. Add an EPUB (best on phones), a PDF or a CBZ.');
  $('rf-pick').textContent = file ? 'Replace file' : 'Add a file';
  $('rf-open').hidden = !file; $('rf-remove').hidden = !file;
  if (file) $('rf-open').href = `./reader.html#${encodeURIComponent(book.id)}`;
}

export async function showFileBox(b, showToast) {
  book = b || null; toast = showToast || toast;
  const my = ++ticket;
  if (!book) return draw(null);
  draw(null, 'Checking…');
  try { const f = await fileOf(book.id); if (my === ticket) { draw(f); remember(book.id, !!f); } }
  catch (e) {
    if (my !== ticket) return;
    draw(null, /book_files|relation|schema cache/i.test(e.message) ? 'Run supabase/reader.sql in Supabase first.' : `Could not check: ${esc(e.message)}`);
    $('rf-acts').hidden = true;
  }
}

export function initFileBox() {
  if (!$('g-file')) return;
  $('rf-input').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file || !book) return;
    if (!/\.(epub|pdf|cbz)$/i.test(file.name)) { toast('Only .epub, .pdf and .cbz files.', true); return; }
    if (file.size > MAX) { toast(`This file is ${mb(file.size)}. Files up to ${mb(MAX)} for now.`, true); return; }
    const my = ++ticket;
    draw(null, `Uploading ${esc(file.name)} (${mb(file.size)})…`); $('rf-acts').hidden = true;
    try {
      const row = await uploadBookFile(book.id, file);
      if (my === ticket) { draw(row); remember(book.id, true); }
      toast(`File added to “${book.title}”.`);
    } catch (err) { if (my === ticket) showFileBox(book); toast(`Upload failed: ${err.message}`, true); }
  });
  $('rf-remove').addEventListener('click', async () => {
    if (!book || !confirm(`Remove the file of “${book.title}” from your library?\nThe book stays on the shelf; only the file is deleted. Copies already on phones stay there until removed.`)) return;
    const my = ++ticket;
    draw(null, 'Removing…'); $('rf-acts').hidden = true;
    try { await bookFileAction('remove', book.id); if (my === ticket) draw(null); remember(book.id, false); toast('File removed.'); }
    catch (err) { if (my === ticket) showFileBox(book); toast(`Could not remove: ${err.message}`, true); }
  });
}
