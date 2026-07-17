/* TaskDesk service worker
   - Network-first: always loads the latest version when online,
     falls back to the saved copy only when offline.
   - Focuses the app when a notification is clicked.
   - Receives Web Push (for the future push backend). */

const CACHE = "taskdesk-v4";   // bumped for Phase 2 push
const ASSETS = ["./", "index.html", "manifest.json", "icon-192.png", "icon-512.png", "badge.png"];
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
  const id = (e.notification.tag || "").split("_")[0];
  const url = id ? ("./?task=" + encodeURIComponent(id)) : "./";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ("focus" in c) { c.postMessage({ openTask: id }); return c.focus(); }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
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
        icon: "icon-192.png", badge: "badge.png"
      });
    }
    // Otherwise it's a silent ping from the Worker — look up what's due right now.
    let shown = false;
    const fallback = () => { if (!shown) { shown = true; return self.registration.showNotification("ADHDBP Control Panel", { body: "You have a reminder — tap to open your board.", tag: "td-reminder", icon: "icon-192.png", badge: "badge.png" }); } };
    try {
      // Morning summary signal?
      try {
        const sr = await fetch(FB_URL + "/_summary.json", { cache: "no-store" });
        if (sr.ok) {
          const sig = await sr.json();
          if (sig && sig.ms && (Date.now() - sig.ms) < 180000) {
            const tr = await fetch(FB_URL + "/" + FB_PATH + ".json", { cache: "no-store" });
            const dd = tr.ok ? await tr.json() : null;
            const tk = Array.isArray(dd) ? dd : (dd ? Object.values(dd) : []);
            const now2 = Date.now();
            const today = new Date(); today.setHours(23,59,59,999); const endToday = today.getTime();
            const active = tk.filter(t => t && !t.deleted && t.status !== "done");
            const dueToday = active.filter(t => t.dueMs && t.dueMs <= endToday).length;
            const overdue = active.filter(t => t.dueMs && t.dueMs < now2).length;
            const starred = active.filter(t => t.focusDay).length;
            const bits = [];
            bits.push(dueToday + " due today");
            if (overdue) bits.push(overdue + " overdue");
            if (starred) bits.push(starred + " starred");
            shown = true;
            return self.registration.showNotification("Good morning \u2600\uFE0F", {
              body: bits.join(" \u00B7 ") + ". Tap to open your board.",
              tag: "morning-summary", icon: "icon-192.png", badge: "badge.png"
            });
          }
        }
      } catch (_) {}
      const r = await fetch(FB_URL + "/" + FB_PATH + ".json", { cache: "no-store" });
      if (!r.ok) { return fallback(); }
      const d = await r.json();
      const tasks = Array.isArray(d) ? d : (d ? Object.values(d) : []);
      const now = Date.now();
      const due = tasks.filter(t => t && !t.deleted && t.status !== "done" && (
        (t.dueMs && t.dueMs <= now) ||
        (Array.isArray(t.remindMs) && t.remindMs.some(ms => ms <= now))
      ));
      if (!due.length) {
        shown = true;
        return self.registration.showNotification("ADHDBP Control Panel", { body: "Checked your reminders — nothing due right now.", tag: "td-check", icon: "icon-192.png", badge: "badge.png" });
      }
      for (const t of due.slice(0, 6)) {
        shown = true;
        await self.registration.showNotification(t.status === "waiting" ? "Time to follow up" : "Reminder", {
          body: t.title, tag: t.id, icon: "icon-192.png", badge: "badge.png"
        });
      }
    } catch (_) {
      return fallback();
    }
    return fallback();
  })());
});
