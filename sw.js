// A shell only. No scheduling, notifications, data caching, skipWaiting or forced reloads.
const CACHE_PREFIX = `reading-endurance:${self.registration.scope}:`;
const CACHE = `${CACHE_PREFIX}v22`;
const SHELL = ['./', './index.html', './style.css', './app.js', './core.js',
  './manifest.webmanifest', './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png'];
const urls = SHELL.map(path => new URL(path, self.registration.scope).href);
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(urls)));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE).map(key => caches.delete(key)))));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || !urls.includes(event.request.url)) return;
  event.respondWith(caches.open(CACHE).then(async cache =>
    (await cache.match(event.request)) || fetch(event.request)));
});
