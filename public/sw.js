// Service worker: push notifications, plus a thumbnail cache that survives the
// browser evicting its normal HTTP cache (phones do this aggressively).
//
// Deliberately does NOT cache the app itself. A cached app shell means deploys
// stop showing up until the cache clears, which is worse than re-downloading a
// small bundle.

const THUMB_CACHE = "thumbs-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== THUMB_CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  // Only thumbnails: they're small, immutable, and come back as plain 200s.
  // Video arrives as 206 partial responses, which can't be stored anyway.
  if (url.pathname !== "/api/drive-stream" || !url.searchParams.has("thumb")) return;

  event.respondWith(
    (async () => {
      const cache = await caches.open(THUMB_CACHE);
      const hit = await cache.match(event.request);
      if (hit) return hit;
      const res = await fetch(event.request);
      if (res && res.status === 200) cache.put(event.request, res.clone()).catch(() => {});
      return res;
    })()
  );
});

self.addEventListener("push", (event) => {
  let payload = { title: "Broadcast Desk", body: "" };
  try {
    payload = event.data ? event.data.json() : payload;
  } catch {
    payload.body = event.data ? event.data.text() : "";
  }

  const title = payload.title || "Broadcast Desk";
  const options = {
    body: payload.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: payload.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.focus();
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
