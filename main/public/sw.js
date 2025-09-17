const DB_NAME = 'game-idb-cache';
const DB_VERSION = 3;
const STORE_NAME = 'responses';
const ALLOW_STORE = 'allowlist';
const MAX_PREFETCH_DEPTH = 3;
const EXT_CACHE_REGEX = /\.(png)(?:\?|$)/i;
const CACHE_NAME = 'asset-cache-v1';

self.addEventListener('install', (event) => {
	self.skipWaiting();
	event.waitUntil(openDb());
});

self.addEventListener('activate', (event) => {
	event.waitUntil((async () => {
		await openDb();
		await self.clients.claim();
	})());
});

// Cache-first for selected types using Cache Storage (handles opaque/cross-origin),
// plus IDB for readable same-origin responses as a secondary path.
self.addEventListener('fetch', (event) => {
	const { request } = event;
	if (request.method !== 'GET') return;
	const url = new URL(request.url);

	// Optional bypass
	if (url.searchParams.has('no-sw')) {
		event.respondWith(fetch(request));
		return;
	}

	const candidate = EXT_CACHE_REGEX.test(url.pathname) || (request.destination === 'image' && /\.png$/i.test(url.pathname));
	if (!candidate) return; // only handle targeted assets

	event.respondWith((async () => {
		const cache = await caches.open(CACHE_NAME);
		// Try exact match first
		let cached = await cache.match(request);
		if (cached) { console.log('[SW][HIT][PNG]', url.href); return cached; }
		// Try normalized URL (ignore search/hash) as fallback key
		const normalizedHref = normalizeUrl(url.href);
		if (normalizedHref !== url.href) {
			const alt = await cache.match(new Request(normalizedHref, { mode: request.mode, credentials: request.credentials, redirect: request.redirect, referrer: request.referrer }));
			if (alt) { console.log('[SW][HIT-NORM][PNG]', url.href, '->', normalizedHref); return alt; }
		}
		try {
			const network = await fetch(request);
			// Store if successful or opaque; Cache Storage supports opaque directly
			if (network && (network.ok || network.type === 'opaque')) {
				try {
					await cache.put(request, network.clone());
					if (normalizedHref !== url.href) {
						await cache.put(new Request(normalizedHref, { mode: request.mode, credentials: request.credentials, redirect: request.redirect, referrer: request.referrer }), network.clone());
					}
					console.log('[SW][PUT][PNG]', url.href);
				} catch (_e) {}
				// For same-origin and readable bodies, also mirror into IDB (best-effort)
				try {
					if (url.origin === self.location.origin) {
						const ct = (network.headers.get('content-type') || '').toLowerCase();
						if (ct.includes('application/json') || ct.startsWith('text/')) {
							const bodyText = await network.clone().text();
							await idbPut(url.href, new Response(new Blob([bodyText], { type: ct }), { status: network.status, statusText: network.statusText, headers: network.headers }));
						}
					}
				} catch (_e) {}
			}
			return network;
		} catch (_err) {
			cached = await cache.match(request) || (normalizedHref !== url.href ? await cache.match(new Request(normalizedHref, { mode: request.mode, credentials: request.credentials, redirect: request.redirect, referrer: request.referrer })) : null);
			return cached || Response.error();
		}
	})());
});

self.addEventListener('message', (event) => {
	const data = event.data || {};
	if (data && data.type === 'PREFETCH_URL') {
		handlePrefetch(data.url, event.source);
	}
	if (data && data.type === 'SKIP_WAITING') {
		self.skipWaiting();
	}
	if (data && data.type === 'CLEAR_CACHE') {
		event.waitUntil((async () => {
			try { await clearStore(); } catch (_) {}
			try { await caches.delete(CACHE_NAME); } catch (_) {}
			postToClient(event.source, { type: 'CLEAR_CACHE_DONE' });
		})());
	}
	if (data && data.type === 'ALLOW_URL') {
		event.waitUntil(allowPut(String(data.url)).then(() => {
			postToClient(event.source, { type: 'ALLOW_URL_DONE', url: String(data.url) });
		}).catch((e) => {
			postToClient(event.source, { type: 'ALLOW_URL_ERROR', url: String(data.url), message: String(e) });
		}));
	}
	if (data && data.type === 'ALLOW_URLS' && Array.isArray(data.urls)) {
		event.waitUntil((async () => {
			for (const u of data.urls) {
				try { await allowPut(String(u)); } catch (_e) {}
			}
			postToClient(event.source, { type: 'ALLOW_URLS_DONE', count: data.urls.length });
		})());
	}
});

// ---------------- IDB helpers ----------------
function openDb() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE_NAME)) {
				db.createObjectStore(STORE_NAME, { keyPath: 'url' });
			}
			if (!db.objectStoreNames.contains(ALLOW_STORE)) {
				db.createObjectStore(ALLOW_STORE, { keyPath: 'url' });
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

async function clearStore() {
	const db = await openDb();
	await Promise.all([
		new Promise((res, rej) => {
			const tx = db.transaction(STORE_NAME, 'readwrite');
			tx.objectStore(STORE_NAME).clear();
			tx.oncomplete = () => res();
			tx.onerror = () => rej(tx.error);
		}),
		new Promise((res, rej) => {
			const tx = db.transaction(ALLOW_STORE, 'readwrite');
			tx.objectStore(ALLOW_STORE).clear();
			tx.oncomplete = () => res();
			tx.onerror = () => rej(tx.error);
		})
	]);
}

async function idbPut(url, response) {
	const db = await openDb();
	const tx = db.transaction(STORE_NAME, 'readwrite');
	const store = tx.objectStore(STORE_NAME);
	const headers = {};
	response.headers.forEach((v, k) => { headers[k] = v; });
	const bodyBlob = await response.blob();
	const record = { url, headers, status: response.status, statusText: response.statusText, body: bodyBlob, ts: Date.now() };
	store.put(record);
	// Also store normalized key (ignore search/hash) to survive cache-busting params
	const normalized = normalizeUrl(url);
	if (normalized !== url) {
		store.put({ ...record, url: normalized });
	}
	return tx.complete || new Promise((res, rej) => {
		tx.oncomplete = () => res();
		tx.onerror = () => rej(tx.error);
	});
}

async function idbGet(url) {
	const db = await openDb();
	const tx = db.transaction(STORE_NAME, 'readonly');
	const store = tx.objectStore(STORE_NAME);
	return new Promise((resolve, reject) => {
		const req = store.get(url);
		req.onsuccess = () => resolve(req.result || null);
		req.onerror = () => reject(req.error);
	});
}

async function idbHas(url) {
	return !!(await idbGet(url));
}

async function idbGetResponse(url) {
	let rec = await idbGet(url);
	if (!rec) {
		const normalized = normalizeUrl(url);
		if (normalized !== url) {
			rec = await idbGet(normalized);
		}
	}
	if (!rec) return null;
	try {
		return new Response(rec.body, { status: rec.status, statusText: rec.statusText, headers: rec.headers });
	} catch (_e) {
		return null;
	}
}

function normalizeUrl(input) {
	try {
		const u = new URL(input, self.location.href);
		u.search = '';
		u.hash = '';
		return u.href;
	} catch (_e) {
		return input;
	}
}

async function allowPut(url) {
	const db = await openDb();
	const tx = db.transaction(ALLOW_STORE, 'readwrite');
	const store = tx.objectStore(ALLOW_STORE);
	const normalized = normalizeUrl(url);
	store.put({ url });
	if (normalized !== url) store.put({ url: normalized });
	return tx.complete || new Promise((res, rej) => {
		tx.oncomplete = () => res();
		tx.onerror = () => rej(tx.error);
	});
}

async function allowHas(url) {
	const db = await openDb();
	const tx = db.transaction(ALLOW_STORE, 'readonly');
	const store = tx.objectStore(ALLOW_STORE);
	const normalized = normalizeUrl(url);
	return new Promise((resolve) => {
		const req1 = store.get(url);
		req1.onsuccess = () => {
			if (req1.result) return resolve(true);
			if (normalized === url) return resolve(false);
			const req2 = store.get(normalized);
			req2.onsuccess = () => resolve(!!req2.result);
			req2.onerror = () => resolve(false);
		};
		req1.onerror = () => resolve(false);
	});
}

async function isResponseCacheable(response, url) {
	const contentType = (response.headers.get('content-type') || '').toLowerCase();
	if (contentType.includes('image/png')) return true;
	if (contentType.includes('image/jpeg')) return true;
	if (contentType.includes('image/webp')) return true;
	if (contentType.includes('application/json')) return true;
	if (contentType.includes('application/wasm')) return true;
	if (contentType.startsWith('text/')) return true;
	// Fallback to extension check
	return EXT_CACHE_REGEX.test(new URL(url, self.location.href).pathname);
}

// --------------- Prefetch ----------------
async function handlePrefetch(urlString, source) {
	try {
		const target = new URL(urlString, self.location.href);
		if (target.origin !== self.location.origin) {
			postToClient(source, { type: 'PREFETCH_SKIPPED_CROSS_ORIGIN', url: urlString });
			return;
		}
		await prefetchUrl(target.href, 0);
		postToClient(source, { type: 'PREFETCH_DONE', url: target.href });
	} catch (e) {
		postToClient(source, { type: 'PREFETCH_ERROR', url: urlString, message: String(e) });
	}
}

async function prefetchUrl(url, depth) {
	if (depth > MAX_PREFETCH_DEPTH) return;
	const cache = await caches.open(CACHE_NAME);
	const already = await cache.match(url);
	if (already) return;
	const response = await fetch(url, { credentials: 'include' });
	if (!response.ok && response.type !== 'opaque') throw new Error(`Failed to fetch ${url}: ${response.status}`);
	try { await cache.put(url, response.clone()); } catch (_) {}
	const contentType = (response.headers.get('content-type') || '').toLowerCase();
	if (contentType.includes('text/html')) {
		const text = await response.clone().text();
		const links = extractUrlsFromHtml(text, url);
		for (const link of links) {
			try { await prefetchUrl(link, depth + 1); } catch (_) {}
		}
	} else if (contentType.includes('text/css')) {
		const text = await response.clone().text();
		const links = extractUrlsFromCss(text, url);
		for (const link of links) {
			try { await prefetchUrl(link, depth + 1); } catch (_) {}
		}
	} else if (contentType.includes('application/javascript') || contentType.includes('text/javascript')) {
		const text = await response.clone().text();
		const links = extractImportsFromJs(text, url);
		for (const link of links) {
			try { await prefetchUrl(link, depth + 1); } catch (_) {}
		}
	}
}

function postToClient(source, payload) {
	if (!source || typeof source.postMessage !== 'function') return;
	source.postMessage(payload);
}

function toAbsoluteUrl(resourceUrl, base) {
	try {
		return new URL(resourceUrl, base).href;
	} catch (_) {
		return null;
	}
}

function isSameOrigin(href) {
	try {
		return new URL(href).origin === self.location.origin;
	} catch (_) {
		return false;
	}
}

function extractUrlsFromHtml(html, base) {
	const urls = new Set();
	const attrRegex = /(?:src|href)\s*=\s*["']([^"']+)["']/gi;
	let match;
	while ((match = attrRegex.exec(html))) {
		const abs = toAbsoluteUrl(match[1], base);
		if (abs && isSameOrigin(abs)) urls.add(abs);
	}
	const cssUrlRegex = /url\(\s*["']?([^)"']+)["']?\s*\)/gi;
	while ((match = cssUrlRegex.exec(html))) {
		const abs = toAbsoluteUrl(match[1], base);
		if (abs && isSameOrigin(abs)) urls.add(abs);
	}
	return Array.from(urls);
}

function extractUrlsFromCss(css, base) {
	const urls = new Set();
	const cssUrlRegex = /url\(\s*["']?([^)"']+)["']?\s*\)/gi;
	let match;
	while ((match = cssUrlRegex.exec(css))) {
		const abs = toAbsoluteUrl(match[1], base);
		if (abs && isSameOrigin(abs)) urls.add(abs);
	}
	return Array.from(urls);
}

function extractImportsFromJs(js, base) {
	const urls = new Set();
	const importRegex = /\bfrom\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|new\s+Worker\(\s*["']([^"']+)["']\s*\)|importScripts\(\s*["']([^"']+)["']\s*\)/g;
	let match;
	while ((match = importRegex.exec(js))) {
		const candidate = match[1] || match[2] || match[3] || match[4];
		const abs = toAbsoluteUrl(candidate, base);
		if (abs && isSameOrigin(abs)) urls.add(abs);
	}
	return Array.from(urls);
}


