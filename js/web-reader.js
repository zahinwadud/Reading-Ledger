// Readers for "Fill from a web page" in the book form (added 20 November 2026). Each returns the same shape as
// readGoodreadsPage in goodreads-page.js, so the form's preview works the same for every source:
//   { source, title, authors, description, genres, pages, year, publisher, format, language, isbn,
//     series: [{ name, numbers }], editions: [], cover, coverName,
//     contains: [{ title } | { series, vol, no }]   (the books a collection or volume holds, in order)
//     containsYear, arcName                          (for those: the year, and a name for their story arc)
//     joinVolume }                                   (Tin Goyenda: the volume this book was republished in, like "2/1")
// readFandomLink fetches from Fandom's own public data service (api.php), which is open to any website.
// Everything else only reads what you saved or pasted.

// START-PURE-HELPERS
const BN = '০১২৩৪৫৬৭৮৯';
const toLatin = (s) => String(s ?? '').replace(/[০-৯]/g, (d) => String(BN.indexOf(d)));
const decode = (s) => String(s ?? '').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&');
const blank = () => ({ source: '', id: null, title: '', authors: [], description: '', genres: [], pages: null, year: null, publisher: '', format: '',
  language: '', isbn: '', series: [], editions: [], cover: '', coverName: '', contains: [], containsYear: null, arcName: '', joinVolume: '' });
const yearIn = (t) => { const m = toLatin(t).match(/\b(1[89]\d\d|20\d\d)\b/); return m ? Number(m[1]) : null; };
const isbnOf = (t) => { const d = toLatin(t).replace(/[^0-9Xx]/g, '').toUpperCase(); return /^(\d{9}[\dX]|\d{13})$/.test(d) ? d : ''; };

// ---------- wiki text ----------
// Plain text from wiki markup: [[Page|label]] -> label, {{c|X}} -> X, other templates dropped, bold/italic marks removed.
export function wikiPlain(text) {
  let t = String(text ?? '');
  t = t.replace(/<ref[^>]*\/>/gi, '').replace(/<ref[\s\S]*?<\/ref>/gi, '').replace(/<br\s*\/?>/gi, '\n');
  t = t.replace(/\{\{\s*(?:c|v|a|cl|m)\s*\|([^{}|]*)(?:\|[^{}]*)?\}\}/gi, '$1');
  for (let i = 0; i < 5; i += 1) t = t.replace(/\{\{[^{}]*\}\}/g, '');
  t = t.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1');
  t = t.replace(/'''?/g, '').replace(/<[^>]+>/g, '');
  return decode(t).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
// The parameters of the first template whose name matches: { name, params: { key: value } } or null.
// Splits on "|" only at the top level, so links and templates inside a value stay whole.
export function firstTemplate(text, nameTest) {
  const t = String(text ?? '');
  let at = 0;
  while ((at = t.indexOf('{{', at)) !== -1) {
    let depth = 0, i = at, parts = [], cur = '';
    for (; i < t.length; i += 1) {
      const two = t.slice(i, i + 2);
      if (two === '{{' || two === '[[') { depth += 1; if (depth > 1) cur += two; i += 1; continue; }
      if (two === '}}' || two === ']]') { depth -= 1; if (depth === 0) break; cur += two; i += 1; continue; }
      if (t[i] === '|' && depth === 1) { parts.push(cur); cur = ''; continue; }
      cur += t[i];
    }
    parts.push(cur);
    const name = parts[0].trim();
    if (nameTest.test(name)) {
      const params = {};
      parts.slice(1).forEach((p) => { const eq = p.indexOf('='); if (eq > 0) params[p.slice(0, eq).trim()] = p.slice(eq + 1).trim(); });
      return { name, params, end: i + 2 };
    }
    at += 2;
  }
  return null;
}
const section = (text, heading) => {
  const m = String(text).match(new RegExp(`==\\s*${heading}\\s*==([\\s\\S]*?)(?:\\n==[^=]|$)`, 'i'));
  return m ? wikiPlain(m[1]) : '';
};
const params = (p, re) => Object.keys(p).filter((k) => re.test(k)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).map((k) => wikiPlain(p[k])).filter(Boolean);
const uniq = (list) => list.filter((x, i) => list.indexOf(x) === i);

// Read a Fandom page's wiki text. host = "dc.fandom.com"; displayTitle = the page's title as shown.
// Returns the page shape, plus imageFile (the cover's file name on the wiki) for the caller to look up.
export function readWikiText(host, displayTitle, wikitext) {
  const out = { ...blank(), source: 'fandom', title: wikiPlain(displayTitle).replace(/\s+/g, ' ').trim(), imageFile: '' };
  const w = String(wikitext ?? '');
  // DC Database: one issue
  const issue = firstTemplate(w, /^DC Database:Comic Template$/i);
  if (issue) {
    const p = issue.params;
    out.source = 'fandom-dc';
    const name = wikiPlain(p.Title || '');
    if (name && p.Issue) out.title = `${name} #${wikiPlain(p.Issue)}`;
    out.authors = uniq(params(p, /^Writer\d+(_\d+)?$/));
    out.year = Number(toLatin(p.Year)) || null;
    const stories = params(p, /^StoryTitle\d+$/);
    const synopsis = params(p, /^Synopsis\d+$/);
    out.description = [stories.length ? stories.map((s) => `“${s.replace(/"/g, '').trim()}”`).join(', ') : '', ...synopsis].filter(Boolean).join('\n\n');
    out.genres = ['Comics'];
    if (name && p.Issue) out.series = [{ name, numbers: [Number(toLatin(p.Issue))].filter((n) => Number.isFinite(n)) }];
    out.imageFile = wikiPlain(p.Image || '');
    out.language = 'English';
    return out;
  }
  // DC Database: a collected edition (its IssueList is the reading order)
  const coll = firstTemplate(w, /^DC Database:Collected Template$/i);
  if (coll) {
    const p = coll.params;
    out.source = 'fandom-dc';
    out.title = out.title.replace(/\s*\(Collected\)\s*$/i, '');
    out.authors = uniq(params(p, /^Writer\d+$/));
    out.year = Number(toLatin(p.Year)) || null;
    out.isbn = isbnOf(p.ISBN || '');
    out.description = wikiPlain(p.Overview || '');
    out.genres = ['Comics', 'Graphic novels'];
    out.imageFile = wikiPlain(p.Image || '');
    out.language = 'English';
    String(p.IssueList || '').split('\n').forEach((line) => {
      const m = line.match(/\{\{\s*c\s*\|\s*([^}|]+?)\s*(?:\|[^}]*)?\}\}/i);
      if (!m) return;
      const v = m[1].match(/^(.*?)\s+Vol\s+(\d+)\s+(\S+)$/i);
      if (v) out.contains.push({ series: v[1].trim(), vol: Number(v[2]), no: Number(v[3]) || v[3] });
      else out.contains.push({ title: m[1].trim() });
    });
    // an issue is listed once per story in it (main and backup stories): keep its first line only
    const seen = new Set();
    out.contains = out.contains.filter((c) => { const k = c.title || `${c.series}|${c.vol}|${c.no}`; return seen.has(k) ? false : seen.add(k); });
    out.containsYear = out.year;
    const arc = wikiPlain(p.StoryArcs || '').split('\n')[0];
    out.arcName = arc || (out.title.includes(': ') ? out.title.slice(out.title.lastIndexOf(': ') + 2) : out.title);
    return out;
  }
  // Any wiki with a book infobox (Tin Goyenda Wiki: Infobox_book)
  const box = firstTemplate(w, /^Infobox[ _]?book$/i) || firstTemplate(w, /^Infobox/i);
  const p = box ? box.params : {};
  const after = box ? w.slice(box.end) : w;
  const intro = wikiPlain(after.split(/\n==/)[0]);
  if (p.author) out.authors = wikiPlain(p.author).split(/\s*[,;]\s*/).filter(Boolean);
  out.publisher = wikiPlain(p.publisher || '');
  out.year = yearIn(wikiPlain(p.publication_date || p.published || p.release_date || ''));
  out.pages = Number(toLatin(wikiPlain(p.pages || ''))) || null;
  out.isbn = isbnOf(p.isbn || '');
  out.genres = wikiPlain(p.genre || '').split(/\s*[,/]\s*/).filter(Boolean);
  out.imageFile = wikiPlain(p.image1 || p.image || p.cover || '');
  out.description = section(w, 'Plot summary') || section(w, 'Summary') || section(w, 'Synopsis') || '';
  // "প্রেতসাধনা তিন গোয়েন্দা সিরিজের ৭ম বই" -> series তিন গোয়েন্দা, number 7
  const nth = intro.match(/([ঀ-৿][ঀ-৿ ]*?)\s+সিরিজের\s+([০-৯\d]+)/);
  if (nth) out.series = [{ name: nth[1].trim(), numbers: [Number(toLatin(nth[2]))] }];
  // a volume lists its stories: story_1, story_2, ...
  const stories = Object.keys(p).filter((k) => /^story_?\d+$/i.test(k)).sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, ''))).map((k) => wikiPlain(p[k])).filter(Boolean);
  if (stories.length) { out.contains = stories.map((title) => ({ title })); out.arcName = out.title; out.containsYear = out.year; }
  const vol = wikiPlain(p.republished_in_volume || '').match(/Volume\s+([\d০-৯]+(?:\s*\/\s*[\d০-৯]+)?)/i);
  if (vol) out.joinVolume = toLatin(vol[1]).replace(/\s+/g, '');
  if (!out.description && intro) out.description = intro;
  out.language = /tingoyenda/i.test(host) || isBn(out.title + out.description + out.authors.join('')) ? 'Bengali' : 'English';
  return out;
}
const isBn = (t) => /[ঀ-৿]/.test(t || '');

// ---------- a saved page from any site ----------
// Uses what most sites put in their pages for search engines: a schema.org block, Open Graph tags, plain meta tags.
export function readGenericPage(html) {
  const text = String(html ?? '');
  const out = { ...blank(), source: 'web' };
  const meta = (key) => {
    const re1 = new RegExp(`<meta[^>]+(?:property|name)="${key}"[^>]+content="([^"]*)"`, 'i');
    const re2 = new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:property|name)="${key}"`, 'i');
    const m = text.match(re1) || text.match(re2); return m ? decode(m[1]).trim() : '';
  };
  let ld = [];
  [...text.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)].forEach((m) => {
    try { const j = JSON.parse(m[1]); [].concat(j['@graph'] || j).forEach((x) => ld.push(x)); } catch (e) { /* skip a broken block */ }
  });
  ld = ld.filter((x) => x && /Book|Product|CreativeWork|Comic/i.test([].concat(x['@type'] || '').join(' ')));
  const b = ld[0] || {};
  const names = (v) => [].concat(v || []).map((a) => (typeof a === 'string' ? a : a && a.name)).filter(Boolean).map((a) => String(a).trim());
  out.title = String(b.name || meta('og:title') || (text.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim();
  out.title = decode(out.title).replace(/\s*[|–—-]\s*[^|–—-]{2,40}$/, '').trim() || decode(out.title);   // drop "| Site name"
  out.authors = names(b.author).length ? names(b.author) : (meta('author') || meta('book:author')) ? [meta('author') || meta('book:author')] : [];
  out.description = String(b.description || meta('og:description') || meta('description') || '').replace(/\s+/g, ' ').trim();
  out.pages = Number(b.numberOfPages) || null;
  out.isbn = isbnOf(b.isbn || meta('book:isbn') || meta('books:isbn') || '');
  out.year = yearIn(b.datePublished || meta('book:release_date') || '');
  out.publisher = names(b.publisher)[0] || '';
  out.language = /bengali|bangla|^bn/i.test(String(b.inLanguage || '')) ? 'Bengali' : /english|^en/i.test(String(b.inLanguage || '')) ? 'English' : '';
  const img = [].concat(b.image || [])[0];
  out.cover = (typeof img === 'string' ? img : img && img.url) || meta('og:image') || '';
  if (!/^https:\/\//i.test(out.cover)) out.cover = '';
  if (!out.language) out.language = isBn(out.title + out.description) ? 'Bengali' : '';
  return out.title ? out : null;
}

// ---------- pasted text ----------
// Text copied from a page with Ctrl+A, Ctrl+C. Goodreads' layout is read in detail; on other pages,
// lines like "ISBN: 978…", "লেখক: …", "Pages 280" are picked up.
export function readPastedText(raw) {
  const lines = String(raw ?? '').replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+/g, ' ').trim());
  const L = lines.filter(Boolean);
  const out = { ...blank(), source: 'text' };
  const after = (label) => { const i = L.findIndex((l) => l.toLowerCase() === label.toLowerCase()); return i >= 0 && i + 1 < L.length ? L[i + 1] : ''; };
  const ratingAt = L.findIndex((l, i) => /^\d(\.\d{1,2})?$/.test(l) && /ratings/i.test(L[i + 1] || ''));
  if (ratingAt >= 2) {
    out.source = 'text-goodreads';
    out.authors = L[ratingAt - 1].split(/\s*,\s*/).filter(Boolean);
    out.title = L[ratingAt - 2];
    const top = L[ratingAt - 3] || '';
    const tm = top.match(/^(.+?)\s+#(\d+(?:\.\d+)?)$/);
    const genreAt = L.findIndex((l, i) => i > ratingAt && /^Genres/.test(l));
    const end = genreAt > 0 ? genreAt : L.findIndex((l, i) => i > ratingAt && /^\d+ pages/.test(l));
    out.description = lines.slice(lines.indexOf(L[ratingAt + 1]) + 1, end > 0 ? lines.indexOf(L[end]) : undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    // Genres come either on one line ("GenresThrillerMystery...show all") or, as Goodreads copies now
    // (21 November 2026), "Genres" alone with one genre per line below it.
    if (genreAt > 0 && L[genreAt] !== 'Genres') out.genres = L[genreAt].replace(/^Genres/, '').replace(/\.{3}\s*show all$|…\s*show all$|show all$/i, '').trim()
      .split(/(?<=[a-z])(?=[A-Z])/).map((g) => g.trim()).filter(Boolean);
    else if (genreAt > 0) {
      for (let i = genreAt + 1; i < L.length && out.genres.length < 20; i += 1) {
        const g = L[i];
        if (/^(\.{3}|…)?\s*(show all|more|show more)$/i.test(g)) break;
        if (/^\d+ pages|^First published|^Published|^Book details|^Kindle Edition|^Paperback|^Hardcover/i.test(g) || g.length > 40 || !/^[A-Za-z][A-Za-z0-9 '&,.-]*$/.test(g)) break;
        out.genres.push(g);
      }
    }
    const pg = L.find((l) => /^\d+ pages/.test(l));
    if (pg) { const m = pg.match(/^(\d+) pages(?:,\s*(.+))?$/); out.pages = Number(m[1]); out.format = m[2] || ''; }
    const fp = L.find((l) => /^First published /i.test(l));
    out.year = fp ? yearIn(fp) : yearIn(after('Published'));
    const pub = after('Published').match(/\sby\s(.+)$/); if (pub) out.publisher = pub[1].trim();
    out.isbn = isbnOf((after('ISBN').match(/^[\dXx-]+/) || [''])[0]);
    out.language = /bengali/i.test(after('Language')) ? 'Bengali' : /english/i.test(after('Language')) ? 'English' : '';
    const ser = after('Series');
    if (ser) [...ser.matchAll(/([^,]+?)\s*\(#([\d.]+(?:\s*-\s*[\d.]+)?(?:\s*,\s*[\d.]+)*)\)/g)].forEach((m) => {
      const nums = m[2].includes('-') ? (() => { const [a, b] = m[2].split('-').map(Number); return Array.from({ length: Math.max(0, b - a + 1) }, (_, k) => a + k); })() : m[2].split(',').map(Number);
      out.series.push({ name: m[1].trim(), numbers: nums });
    });
    if (!out.series.length && tm) out.series.push({ name: tm[1].trim(), numbers: [Number(tm[2])] });
  } else {
    const pick = (re) => { for (const l of L) { const m = l.match(re); if (m) return m[1].trim(); } return ''; };
    out.title = pick(/^(?:title|শিরোনাম|বইয়ের নাম|বই)\s*[:：]\s*(.+)$/i) || L[0] || '';
    const a = pick(/^(?:author|authors|writer|লেখক|লেখিকা|রচয়িতা)\s*[:：]?\s+(.+)$/i); if (a) out.authors = a.split(/\s*[,;]\s*/);
    out.publisher = pick(/^(?:publisher|প্রকাশক|প্রকাশনী|প্রকাশনা)\s*[:：]?\s+(.+)$/i);
    out.isbn = isbnOf(pick(/^ISBN(?:-1[03])?\s*[:：]?\s*([\dXx০-৯-]+)/i));
    out.pages = Number(toLatin(pick(/^(?:pages|page count|পৃষ্ঠা(?: সংখ্যা)?)\s*[:：]?\s*([\d০-৯]+)/i))) || null;
    out.year = yearIn(pick(/^(?:published|publication date|year|প্রকাশকাল|প্রথম প্রকাশ|প্রকাশ)\s*[:：]?\s*(.+)$/i));
    const lang = pick(/^(?:language|ভাষা)\s*[:：]?\s*(.+)$/i);
    out.language = /bengali|bangla|বাংলা/i.test(lang) ? 'Bengali' : /english|ইংরেজি/i.test(lang) ? 'English' : (isBn(out.title) ? 'Bengali' : '');
  }
  return out.title ? out : null;
}
// END-PURE-HELPERS

// Is this a Fandom page address? Returns { host, page } or null.
export function fandomAddress(url) {
  try {
    const u = new URL(String(url).trim());
    if (!/\.fandom\.com$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/(?:[a-z-]+\/)?wiki\/(.+)$/i);
    return m ? { host: u.hostname, page: decodeURIComponent(m[1]).replace(/_/g, ' ') } : null;
  } catch (e) { return null; }
}
// Fetch a Fandom page through its public api.php, read it, and look up its cover picture's address.
export async function readFandomLink(url) {
  const at = fandomAddress(url);
  if (!at) throw new Error('Only Fandom links (…fandom.com/wiki/…) can be read directly. For other sites, save the page or paste its text.');
  const api = (q) => `https://${at.host}/api.php?${new URLSearchParams({ format: 'json', origin: '*', ...q })}`;
  const res = await fetch(api({ action: 'parse', page: at.page, prop: 'wikitext|displaytitle', redirects: '1' }));
  if (!res.ok) throw new Error(`Fandom did not answer (${res.status}). Try again in a moment.`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.code === 'missingtitle' ? 'That page does not exist on the wiki.' : (data.error.info || 'Fandom could not read that page.'));
  const page = readWikiText(at.host, data.parse.displaytitle || data.parse.title, data.parse.wikitext['*']);
  if (page.imageFile) {
    try {
      const q = await (await fetch(api({ action: 'query', titles: `File:${page.imageFile}`, prop: 'imageinfo', iiprop: 'url' }))).json();
      const info = Object.values((q.query && q.query.pages) || {})[0];
      const src = info && info.imageinfo && info.imageinfo[0] && info.imageinfo[0].url;
      if (src) page.cover = src;
    } catch (e) { /* no cover is fine */ }
  }
  page.link = url;
  return page;
}
