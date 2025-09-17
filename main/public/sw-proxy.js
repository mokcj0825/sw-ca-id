/* Minimal SW to cache Cocos assets for /project-1 and /project-2, ignoring sw-ca-id */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

const CACHE_NAME = 'cocos-assets-v1';
const SCOPE_PREFIXES = ['/project-1/', '/project-2/'];

function isInScope(url) {
  return SCOPE_PREFIXES.some((p) => url.pathname.startsWith(p));
}

function normalizeRequest(request) {
  const originalUrl = new URL(request.url);
  if (!isInScope(originalUrl)) return null;

  // Remove cache-busting params we want to ignore
  originalUrl.searchParams.delete('sw-ca-id');
  originalUrl.searchParams.delete('v');
  originalUrl.searchParams.delete('ts');

  return new Request(originalUrl.toString(), {
    method: request.method,
    headers: request.headers,
    mode: request.mode,
    credentials: request.credentials,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    integrity: request.integrity,
    cache: 'no-cache'
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (!isInScope(url)) return;

  const normalized = normalizeRequest(req);
  if (!normalized) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(normalized);
    if (cached) return cached;

    // Fetch with original request in case of credentials/headers
    const res = await fetch(req);
    if (res && res.ok && req.method === 'GET') {
      try {
        await cache.put(normalized, res.clone());
      } catch (error) {
        // Handle put failures to satisfy linters and aid debugging in dev.
        console.warn('[sw-proxy] cache.put failed', error);
      }
    }
    return res;
  })());
});

self.addEventListener('message', (event) => {
  if (!event || !event.data) return;
  if (event.data.type === 'PURGE') {
    event.waitUntil(caches.delete(CACHE_NAME));
  }
});


