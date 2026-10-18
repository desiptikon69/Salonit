/*
 * SalonIt app shell.
 *
 * Goals: make the site installable, start instantly from the Home Screen and
 * show a branded offline page. Navigation HTML is intentionally never cached:
 * pages contain client sessions, and a stale login page is worse than a clear
 * "no connection" screen. Only immutable build assets, icons and images are
 * stored, all cache-first.
 */
const VERSION = "salonit-2026-10-19-3";
const STATIC_CACHE = VERSION + "-static";
const IMAGE_CACHE = VERSION + "-images";
const OFFLINE_URL = "/offline";
const SHELL_ASSETS = [
  "/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
];
const CACHES = [STATIC_CACHE, IMAGE_CACHE];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      await Promise.all(
        SHELL_ASSETS.map(async (url) => {
          try {
            await cache.add(new Request(url, { cache: "reload" }));
          } catch {
            // A single missing icon must not block installation.
          }
        }),
      );
      await precacheOffline(cache);
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // Only clean this app's old caches; the origin may host other workers.
      await Promise.all(
        keys
          .filter((key) => key.startsWith("salonit-") && !CACHES.includes(key))
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Sessions and RSC navigation payloads must always come from the network.
  if (url.pathname.startsWith("/api/")) return;
  if (request.headers.get("RSC") === "1" || url.searchParams.has("_rsc")) return;

  if (request.mode === "navigate") {
    event.respondWith(navigationRequest(request));
    return;
  }

  if (url.pathname.startsWith("/_next/static/") || isShellAsset(url.pathname)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  if (url.pathname.startsWith("/_next/image")) {
    event.respondWith(cacheFirst(request, IMAGE_CACHE, 80));
  }
});

self.addEventListener("message", (event) => {
  const type = event.data && event.data.type;
  if (type === "SKIP_WAITING") void self.skipWaiting();
  if (type === "CLEAR_CACHES") {
    event.waitUntil(Promise.all(CACHES.map((name) => caches.delete(name))));
  }
});

function isShellAsset(pathname) {
  return (
    pathname === "/icon.svg" ||
    pathname.startsWith("/icons/") ||
    pathname.startsWith("/splash/")
  );
}

async function cacheFirst(request, cacheName, maxEntries = 0) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic") {
      await cache.put(request, response.clone());
      if (maxEntries) await trimCache(cache, maxEntries);
    }
    return response;
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
}

async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((key) => cache.delete(key)));
}

async function navigationRequest(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(STATIC_CACHE);
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    return new Response(
      '<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#f6f4ef;color:#22201f;font:16px/1.5 Arial,sans-serif"><main style="text-align:center;padding:24px"><h1>Нет подключения</h1><p>Проверьте интернет и попробуйте снова.</p><a href="/" style="color:#22201f">Обновить</a></main></body></html>',
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }
}

async function precacheOffline(cache) {
  try {
    const response = await fetch(OFFLINE_URL, { cache: "reload" });
    if (!response.ok) return;
    const html = await response.clone().text();
    await cache.put(OFFLINE_URL, response);
    const assets = new Set(html.match(/\/_next\/static\/[A-Za-z0-9_./~-]+/g) || []);
    await Promise.all(
      [...assets].map(async (url) => {
        try {
          await cache.add(new Request(url, { cache: "reload" }));
        } catch {
          // Non-critical chunk; the offline page copy still renders.
        }
      }),
    );
  } catch {
    // The offline page is a bonus. Installation must succeed without it.
  }
}
