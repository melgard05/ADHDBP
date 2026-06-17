/* TaskDesk service worker
   - Caches the app for offline use
   - Focuses the app when a notification is clicked
   - Receives Web Push messages (used once you add a push sender, e.g. a Cloudflare Worker)
   NOTE: a service worker alone cannot fire timed reminders while the app is fully closed.
   That needs a push *sender*. This SW is already a valid push *receiver* for that backend. */

const CACHE = "taskdesk-v1";
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
  if (req.method !== "GET") return;                 // don't touch Firebase writes
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // let cross-origin (Firebase) pass through
  e.respondWith(
    caches.match(req).then(cached =>
      cached || fetch(req).catch(() => caches.match("taskdesk.html"))
    )
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

/* Web Push receiver — only fires when a sender (your future Worker) delivers a push. */
self.addEventListener("push", e => {
  let data = { title: "TaskDesk reminder", body: "" };
  try { data = e.data.json(); } catch (_) { if (e.data) data.body = e.data.text(); }
  e.waitUntil(
    self.registration.showNotification(data.title || "TaskDesk reminder", {
      body: data.body || "",
      tag: data.tag || "taskdesk",
      icon: "icon-192.png",
      badge: "icon-192.png"
    })
  );
});
