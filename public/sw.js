const CACHE_STATIC = "cvl-static-v2";
const CACHE_RUNTIME = "cvl-runtime-v2";

const ASSETS = [
  "/",
  "/index.html",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/extra.js",
  "/admin/dashboard/",
  "/admin/dashboard/index.html",
  "/admin/dashboard/dashboard.js"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_STATIC).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => ![CACHE_STATIC, CACHE_RUNTIME].includes(k))
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);

  if (req.method !== "GET") return;

  const isSameOrigin = url.origin === self.location.origin;
  const isHTML = req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html");
  const isPublicApiGet = isSameOrigin && url.pathname.startsWith("/api/public/");

  // HTML navigation: network-first
  if (isSameOrigin && isHTML) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_RUNTIME);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match(req);
        return cached || caches.match("/index.html");
      }
    })());
    return;
  }

  // Public API GET: network-first
  if (isPublicApiGet) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE_RUNTIME);
      try {
        const fresh = await fetch(req);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        const cached = await cache.match(req);
        return cached || new Response(JSON.stringify({ error: "offline" }), {
          status: 503,
          headers: { "Content-Type": "application/json" }
        });
      }
    })());
    return;
  }

  // Static assets: cache-first
  if (isSameOrigin) {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const fresh = await fetch(req);
      const cache = await caches.open(CACHE_RUNTIME);
      cache.put(req, fresh.clone());
      return fresh;
    })());
  }
});

// ---------- PUSH ----------
self.addEventListener("push", (event) => {
  const data = (() => {
    try { return event.data ? event.data.json() : {}; }
    catch { return {}; }
  })();

  const title = data.title || "CVL";
  const options = {
    body: data.body || "",
    icon: data.icon || "/icon-192.png",
    badge: data.badge || "/icon-192.png",
    tag: data.tag || "cvl",
    data: { url: data.url || "/" }
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.url || "/";

  event.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of allClients) {
      if ("focus" in c) {
        c.focus();
        c.navigate(targetUrl);
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
  })());
});
