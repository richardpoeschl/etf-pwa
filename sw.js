const CACHE_VERSION = "etf-pwa-v2";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const API_CACHE = `${CACHE_VERSION}-api`;
const APP_SHELL = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];
const API_MAX_AGE_MS = 5 * 60 * 1000;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith("etf-pwa-") && ![STATIC_CACHE, API_CACHE].includes(name))
        .map((name) => caches.delete(name))
    );
    await self.clients.claim();
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    clients.forEach((client) => client.postMessage({ type: "SW_UPDATED", version: CACHE_VERSION }));
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
  if (event.data?.type === "CLEAR_API_CACHE") {
    event.waitUntil(caches.delete(API_CACHE));
  }
});

function isApiRequest(url) {
  return url.hostname === "script.google.com" ||
         url.hostname === "script.googleusercontent.com" ||
         url.searchParams.has("apiKey") ||
         url.searchParams.has("action");
}

async function networkFirst(request, cacheName, timeoutMs = 8000) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(request, { signal: controller.signal });
    clearTimeout(timeout);
    if (response.ok) {
      const copy = response.clone();
      const headers = new Headers(copy.headers);
      headers.set("x-etf-cached-at", String(Date.now()));
      const body = await copy.blob();
      await cache.put(request, new Response(body, {
        status: copy.status,
        statusText: copy.statusText,
        headers
      }));
    }
    return response;
  } catch (error) {
    clearTimeout(timeout);
    if (cached) return cached;
    throw error;
  }
}

async function apiNetworkFirst(request) {
  const cache = await caches.open(API_CACHE);
  const cached = await cache.match(request);
  if (cached) {
    const cachedAt = Number(cached.headers.get("x-etf-cached-at") || 0);
    if (Date.now() - cachedAt <= API_MAX_AGE_MS) {
      fetch(request).then(async (response) => {
        if (!response.ok) return;
        const headers = new Headers(response.headers);
        headers.set("x-etf-cached-at", String(Date.now()));
        const body = await response.clone().blob();
        await cache.put(request, new Response(body, {
          status: response.status,
          statusText: response.statusText,
          headers
        }));
      }).catch(() => {});
      return cached;
    }
  }
  return networkFirst(request, API_CACHE, 10000);
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (isApiRequest(url)) {
    event.respondWith(apiNetworkFirst(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, STATIC_CACHE, 5000));
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(STATIC_CACHE);
    const cached = await cache.match(request);
    const network = fetch(request).then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    });
    return cached || network;
  })());
});
