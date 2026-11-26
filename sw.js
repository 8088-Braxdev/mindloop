// App files are served from the device copy and refreshed in the background.
// Supabase, Google sign-in and /api/ calls always go to the network.

const CACHE = "mindloop-shell-v60";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "js/ui.js",
  "js/logic.js",
  "js/storage.js",
  "js/auth.js",
  "js/supabase.js",
  "js/swipe.js",
  "js/insights.js",
  "js/account.js",
  "js/settings.js",
  "js/reminders.js",
  "js/rescue.js",
  "js/measure.js",
  "js/feedback.js",
  "js/notify.js",
  "js/push.js",
  "js/timesheet.js",
  "privacy.html",
  "terms.html",
  "manifest.webmanifest",
  "favicon.ico",
  "icons/icon-192.png",
  "icons/apple-touch-icon.png",
  "icons/icon-512.png",
  "icons/favicon-32.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      const results = await Promise.allSettled(
        SHELL.map(async (file) => {
          const response = await fetch(file, { cache: "no-cache" });
          if (!response.ok) throw new Error(`${file}: ${response.status}`);
          await cache.put(file, response);
        }),
      );
      results
        .filter((result) => result.status === "rejected")
        .forEach((result) =>
          console.warn("MindLoop: shell asset was not cached", result.reason),
        );
    }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      ),
  );
  self.clients.claim();
});

// Closed-app reminders (spec §5): the server sends one small message per
// priority whose start time has arrived. The service worker is the only place
// that can show it while MindLoop is not open.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }
  const options = {
    body: payload.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/favicon-32.png",
    data: { url: payload.url || "./" },
  };
  if (payload.tag) options.tag = payload.tag;
  event.waitUntil(
    self.registration.showNotification(payload.title || "MindLoop", options),
  );
});

// The browser can replace a subscription on its own (for example after the
// push service rotates it). Renew it with the same key, then tell any open
// MindLoop tab so the new endpoint is saved to the account. If no tab is open,
// the app's next start saves it (js/push.js reuses the live subscription).
self.addEventListener("pushsubscriptionchange", (event) => {
  const key = event.oldSubscription?.options?.applicationServerKey;
  if (!key) return;
  event.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: key })
      .then((subscription) =>
        self.clients
          .matchAll({ type: "window", includeUncontrolled: true })
          .then((list) => {
            for (const client of list) {
              client.postMessage({
                type: "mindloop:push-renewed",
                endpoint: subscription.endpoint,
              });
            }
          }),
      )
      .catch((err) =>
        console.warn("MindLoop: push subscription was not renewed", err),
      ),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "./";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((list) => {
        const open = list.find((client) => "focus" in client);
        if (open) return open.focus();
        return self.clients.openWindow(target);
      }),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const cdn = url.hostname === "cdn.jsdelivr.net";
  if (!sameOrigin && !cdn) return;
  if (sameOrigin && url.pathname.startsWith("/api/")) return;

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req)
        .then((res) => {
          if (res.ok && !url.search) {
            cache
              .put(req, res.clone())
              .catch((err) =>
                console.warn("MindLoop: response was not cached", err),
              );
          }
          return res;
        })
        .catch(() => cached || Response.error());
      return cached || network;
    }),
  );
});
