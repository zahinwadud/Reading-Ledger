// Service worker: makes the site installable and lets the shelf open with no connection.
//
//   Site files (pages, styles, scripts)  -> the network first, so an update you publish shows up straight
//                                           away; the saved copy is used when offline or the network is slow.
//   Cover images and fonts               -> the saved copy first (they never change), fetched once.
//   Book data, login, uploads, YouTube   -> not touched here. The page keeps its own saved copy of the shelf.
//
// Changed this file? Raise VERSION so browsers drop the old saved site files.
const VERSION = 'v1';
const SHELL = `shell-${VERSION}`;
const IMAGES = 'covers-v1';
const FONTS = 'fonts-v1';
const MAX_IMAGES = 600;          // oldest saved covers are dropped beyond this
const SLOW_MS = 4000;            // on a slow connection, show the saved copy after this long

const SHELL_FILES = [
  './', 'index.html', 'css/style.css', 'js/public.js', 'js/core.js', 'js/config.js',
  'manifest.webmanifest', 'favicon.ico', 'icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Site files: network first; fall back to the saved copy when offline, or early when the network is slow.
async function siteFile(request) {
  const cache = await caches.open(SHELL);
  const saved = await cache.match(request, { ignoreSearch: true })
    || (request.mode === 'navigate' && !/admin\.html$/.test(new URL(request.url).pathname) ? await cache.match('index.html') : undefined);
  const fresh = fetch(request).then((res) => {
    if (res.ok) cache.put(request, res.clone());
    return res;
  });
  if (!saved) return fresh;
  fresh.catch(() => {});         // the saved copy answers below; a failed fetch is not an error then
  const slow = new Promise((resolve) => setTimeout(() => resolve(saved), SLOW_MS));
  return Promise.race([fresh.catch(() => saved), slow]);
}

async function trim(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i += 1) await cache.delete(keys[i]);
}

// Covers and thumbnails: saved copy first. The image is fetched in a way the browser lets us store
// cheaply (CORS); hosts that do not allow that are simply shown without being saved.
async function image(request) {
  const cache = await caches.open(IMAGES);
  const saved = await cache.match(request.url);
  if (saved) return saved;
  try {
    const res = await fetch(request.url, { mode: 'cors', credentials: 'omit' });
    if (res.ok) { cache.put(request.url, res.clone()).then(() => trim(IMAGES, MAX_IMAGES)); }
    return res;
  } catch (e) {
    return fetch(request);
  }
}

// Fonts: saved copy first, refreshed quietly in the background.
async function font(request) {
  const cache = await caches.open(FONTS);
  const saved = await cache.match(request);
  const fresh = fetch(request).then((res) => { if (res.ok) cache.put(request, res.clone()); return res; });
  if (saved) { fresh.catch(() => {}); return saved; }
  return fresh;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith(new URL(self.registration.scope).pathname)) event.respondWith(siteFile(request));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') { event.respondWith(font(request)); return; }
  if (request.destination === 'image') event.respondWith(image(request));
});
