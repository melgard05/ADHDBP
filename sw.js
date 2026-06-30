/* TaskDesk service worker
   - Network-first: always loads the latest version when online,
     falls back to the saved copy only when offline.
   - Focuses the app when a notification is clicked.
   - Receives Web Push (for the future push backend). */

const CACHE = "taskdesk-v4";   // bumped for Phase 2 push
const ASSETS = ["./", "index.html", "manifest.json", "icon-192.png", "icon-512.png"];
const FB_URL = "https://adhd-bipolar-organization-default-rtdb.firebaseio.com";
const FB_PATH = "td_k9m4x7qz2p";

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
    }).catch(() => caches.match(req).then(c => c || caches.match("index.html")))
  );
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window" }).then(list => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })
  );
});

self.addEventListener("push", e => {
  e.waitUntil((async () => {
    // If the push carried explicit data, show it directly.
    let data = null;
    try { data = e.data ? e.data.json() : null; } catch (_) {}
    if (data && data.title) {
      return self.registration.showNotification(data.title, {
        body: data.body || "", tag: data.tag || "taskdesk",
        icon: "icon-192.png", badge: "icon-192.png"
      });
    }
    // Otherwise it's a silent ping from the Worker — look up what's due right now.
    try {
      const r = await fetch(FB_URL + "/" + FB_PATH + ".json", { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      const tasks = Array.isArray(d) ? d : (d ? Object.values(d) : []);
      const now = Date.now();
      const due = tasks.filter(t => t && !t.deleted && t.status !== "done" && (
        (t.dueMs && t.dueMs <= now) ||
        (Array.isArray(t.remindMs) && t.remindMs.some(ms => ms <= now))
      ));
      if (!due.length) {
        return self.registration.showNotification("ADHDBP Control Panel", { body: "Checked your reminders — nothing due right now.", tag: "td-check", icon: "icon-192.png", badge: "icon-192.png" });
      }
      for (const t of due.slice(0, 6)) {
        await self.registration.showNotification(t.status === "waiting" ? "Time to follow up" : "Reminder", {
          body: t.title, tag: t.id, icon: "icon-192.png", badge: "icon-192.png"
        });
      }
    } catch (_) {}
  })());
});
