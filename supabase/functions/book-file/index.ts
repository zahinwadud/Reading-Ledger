// Supabase Edge Function "book-file": the gatekeeper between the reader and Backblaze B2.
// (21 November 2026)
//
// The bucket is private. This function is the only thing that holds the Backblaze key, and it only
// helps people who are signed in and allowed to read (is_reader() in supabase/reader.sql).
//
//   POST {action:'open',   book}   -> a link to that one file, valid for an hour   (readers)
//   POST {action:'remove', book}   -> deletes the file from the bucket              (you only)
//   POST ?action=upload&book=<id>&name=<file name>, body = the file  -> stores it   (you only)
//
// Secrets it needs (Supabase dashboard -> Edge Functions -> Secrets). Never put them in the repo:
//   B2_KEY_ID, B2_APP_KEY   the Application Key made for this bucket only
//   B2_BUCKET_ID            the bucket's ID (shown on the Backblaze Buckets page; not secret)
//   B2_BUCKET_NAME          reading-ledger-books
// SUPABASE_URL and SUPABASE_ANON_KEY are provided by Supabase automatically.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const ORIGINS = ['https://reading-ledger.pages.dev', 'http://localhost:8000', 'http://127.0.0.1:8000'];
const KINDS: Record<string, string> = { epub: 'application/epub+zip', pdf: 'application/pdf', cbz: 'application/vnd.comicbook+zip' };

const env = (k: string) => Deno.env.get(k) ?? '';

function cors(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}
const reply = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });

// ---------- Backblaze ----------
// Signing in to Backblaze is kept for 20 hours (it is valid for 24), so most calls skip it.
let b2auth: { apiUrl: string; downloadUrl: string; token: string; at: number } | null = null;

async function b2Auth() {
  if (b2auth && Date.now() - b2auth.at < 20 * 3600 * 1000) return b2auth;
  const r = await fetch('https://api.backblazeb2.com/b2api/v3/b2_authorize_account', {
    headers: { Authorization: 'Basic ' + btoa(`${env('B2_KEY_ID')}:${env('B2_APP_KEY')}`) },
  });
  if (!r.ok) throw new Error(`Backblaze sign-in failed (${r.status})`);
  const j = await r.json();
  b2auth = { apiUrl: j.apiInfo.storageApi.apiUrl, downloadUrl: j.apiInfo.storageApi.downloadUrl, token: j.authorizationToken, at: Date.now() };
  return b2auth;
}

async function b2(name: string, body: unknown, retry = true): Promise<any> {
  const a = await b2Auth();
  const r = await fetch(`${a.apiUrl}/b2api/v3/${name}`, { method: 'POST', headers: { Authorization: a.token }, body: JSON.stringify(body) });
  if (r.status === 401 && retry) { b2auth = null; return b2(name, body, false); }
  const j = await r.json();
  if (!r.ok) throw new Error(`Backblaze ${name}: ${j.message || r.status}`);
  return j;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
// File names in Backblaze headers are sent URL-encoded, but "/" stays as it is.
const b2Name = (path: string) => path.split('/').map(encodeURIComponent).join('/');

// ---------- the function ----------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  if (req.method !== 'POST') return reply(req, 405, { error: 'Use POST.' });

  // Who is asking? The database checks use their own sign-in, so the same rules as the site apply.
  const sb = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY') || env('SUPABASE_PUBLISHABLE_KEY'), {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
  });
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return reply(req, 401, { error: 'Please sign in.' });
  const { data: reader } = await sb.rpc('is_reader');
  if (!reader) return reply(req, 403, { error: 'This account is not allowed to read books here.' });

  const url = new URL(req.url);
  try {
    // ----- upload (you only): the body is the file itself -----
    if (url.searchParams.get('action') === 'upload') {
      const { data: owner } = await sb.rpc('is_owner');
      if (!owner) return reply(req, 403, { error: 'Only the owner can add files.' });
      const book = url.searchParams.get('book') ?? '';
      const name = url.searchParams.get('name') ?? 'book';
      const kind = (name.match(/\.(epub|pdf|cbz)$/i)?.[1] ?? '').toLowerCase();
      if (!kind) return reply(req, 400, { error: 'Only .epub, .pdf and .cbz files can be added.' });
      const { data: row } = await sb.from('books').select('id').eq('id', book).maybeSingle();
      if (!row) return reply(req, 404, { error: 'That book is not on the shelf.' });

      const bytes = await req.arrayBuffer();
      if (!bytes.byteLength) return reply(req, 400, { error: 'The file is empty.' });
      const path = `books/${book}.${kind}`;
      const up = await b2('b2_get_upload_url', { bucketId: env('B2_BUCKET_ID') });
      const sha1 = hex(await crypto.subtle.digest('SHA-1', bytes));
      const put = await fetch(up.uploadUrl, {
        method: 'POST',
        headers: { Authorization: up.authorizationToken, 'X-Bz-File-Name': b2Name(path), 'Content-Type': KINDS[kind], 'X-Bz-Content-Sha1': sha1 },
        body: bytes,
      });
      const saved = await put.json();
      if (!put.ok) throw new Error(`Backblaze upload: ${saved.message || put.status}`);

      // A file of another kind for the same book (say the PDF, now replaced by an EPUB) is removed.
      const { data: before } = await sb.from('book_files').select('path, file_id').eq('book_id', book).maybeSingle();
      if (before && before.path !== path) await b2('b2_delete_file_version', { fileName: before.path, fileId: before.file_id }).catch(() => {});
      const record = { book_id: book, path, file_id: saved.fileId, kind, size: bytes.byteLength, name, uploaded_at: new Date().toISOString() };
      const { error } = await sb.from('book_files').upsert(record);
      if (error) throw new Error(error.message);
      return reply(req, 200, record);
    }

    const body = await req.json().catch(() => ({}));
    const book = String(body.book ?? '');
    const { data: file } = await sb.from('book_files').select('*').eq('book_id', book).maybeSingle();
    if (!file) return reply(req, 404, { error: 'This book has no file yet.' });

    // ----- open (readers): a link to this one file, valid for an hour -----
    if (body.action === 'open') {
      const a = await b2Auth();
      const pass = await b2('b2_get_download_authorization', {
        bucketId: env('B2_BUCKET_ID'), fileNamePrefix: file.path, validDurationInSeconds: 3600,
      });
      const link = `${a.downloadUrl}/file/${env('B2_BUCKET_NAME')}/${b2Name(file.path)}?Authorization=${encodeURIComponent(pass.authorizationToken)}`;
      return reply(req, 200, { url: link, kind: file.kind, size: file.size, file_id: file.file_id });
    }

    // ----- remove (you only) -----
    if (body.action === 'remove') {
      const { data: owner } = await sb.rpc('is_owner');
      if (!owner) return reply(req, 403, { error: 'Only the owner can remove files.' });
      await b2('b2_delete_file_version', { fileName: file.path, fileId: file.file_id }).catch((e) => {
        if (!/not.?found|not present/i.test(String(e))) throw e;   // already gone: fine
      });
      const { error } = await sb.from('book_files').delete().eq('book_id', book);
      if (error) throw new Error(error.message);
      return reply(req, 200, { removed: true });
    }

    return reply(req, 400, { error: 'Unknown action.' });
  } catch (e) {
    return reply(req, 500, { error: String(e instanceof Error ? e.message : e) });
  }
});
