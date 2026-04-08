// RockStock Service Worker — runtime caching only
const CACHE_VERSION = "v1";
const RUNTIME_CACHE = `rockstock-runtime-${CACHE_VERSION}`;

// Cache duration by category (milliseconds)
const TTL = {
  realtime: 30 * 1000,        // 30 seconds
  semiStatic: 60 * 60 * 1000, // 1 hour
  static: 24 * 60 * 60 * 1000 // 24 hours
};

// Routes that should NEVER be cached (streaming, heavy compute, mutations)
const NETWORK_ONLY = [
  "/api/chat",
  "/api/ai/",
  "/api/scanner/",
  "/api/backtest/",
  "/api/daytrade/",
  "/api/notify/",
  "/api/cron/",
];

// Routes with short TTL (realtime stock data)
const SHORT_TTL = [
  "/api/realtime",
  "/api/stock",
  "/api/portfolio/quotes",
];

// Routes with medium TTL (fundamentals, chip data)
const MEDIUM_TTL = [
  "/api/fundamentals",
  "/api/chip",
  "/api/institutional",
  "/api/news",
  "/api/watchlist",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== RUNTIME_CACHE)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

function matchesAny(url, patterns) {
  return patterns.some((p) => url.pathname.startsWith(p));
}

function isExpired(response, maxAge) {
  const date = response.headers.get("sw-cache-time");
  if (!date) return true;
  return Date.now() - Number(date) > maxAge;
}

async function networkFirst(request, maxAge) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(RUNTIME_CACHE);
      const clone = response.clone();
      const headers = new Headers(clone.headers);
      headers.set("sw-cache-time", String(Date.now()));
      const cached = new Response(clone.body, {
        status: clone.status,
        statusText: clone.statusText,
        headers,
      });
      cache.put(request, cached);
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response("Network error", { status: 503 });
  }
}

async function staleWhileRevalidate(request, maxAge) {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then((response) => {
    if (response.ok) {
      const headers = new Headers(response.headers);
      headers.set("sw-cache-time", String(Date.now()));
      const cloned = new Response(response.clone().body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
      cache.put(request, cloned);
    }
    return response;
  }).catch(() => cached);

  if (cached && !isExpired(cached, maxAge)) {
    return cached;
  }
  return fetchPromise;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin requests
  if (url.origin !== self.location.origin) return;

  // Skip non-GET requests
  if (request.method !== "GET") return;

  // Network-only routes (SSE streaming, heavy compute)
  if (matchesAny(url, NETWORK_ONLY)) return;

  // Short TTL routes (realtime stock data) — network first
  if (matchesAny(url, SHORT_TTL)) {
    event.respondWith(networkFirst(request, TTL.realtime));
    return;
  }

  // Medium TTL routes (fundamentals, chip) — stale while revalidate
  if (matchesAny(url, MEDIUM_TTL)) {
    event.respondWith(staleWhileRevalidate(request, TTL.semiStatic));
    return;
  }

  // Static assets (JS, CSS, images) — stale while revalidate with long TTL
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.match(/\.(js|css|png|jpg|svg|ico|woff2?)$/)
  ) {
    event.respondWith(staleWhileRevalidate(request, TTL.static));
    return;
  }

  // All other routes — let browser handle normally
});
