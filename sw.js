/* TaskDesk service worker
   - Network-first: always loads the latest version when online,
     falls back to the saved copy only when offline.
   - Focuses the app when a notification is clicked.
   - Receives Web Push (for the future push backend). */

const CACHE = "taskdesk-v2";   // bumped -> clears the old stuck cache
const ASSETS = ["taskdesk.html", "manifest.json", "icon-192.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(ASSETS.map(a => c.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;                 // don't touch sync writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // let Firebase/Worker pass through
  // Network-first: fetch the latest, update the saved copy, fall back if offline.
  e.respondWith(
    fetch(req).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      return resp;
    }).catch(() => caches.match(req).then(c => c || caches.match("taskdesk.html")))
  );
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window" }).then(list => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow("taskdesk.html");
    })
  );
});

self.addEventListener("push", e => {
  let data = { title: "TaskDesk reminder", body: "" };
  try { data = e.data.json(); } catch (_) { if (e.data) data.body = e.data.text(); }
  e.waitUntil(
    self.registration.showNotification(data.title || "TaskDesk reminder", {
      body: data.body || "", tag: data.tag || "taskdesk",
      icon: "icon-192.png", badge: "icon-192.png"
    })
  );
});
