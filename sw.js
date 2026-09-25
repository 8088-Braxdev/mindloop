// App files are served from the device copy and refreshed in the background.
// Supabase, Google sign-in and /api/ calls always go to the network.

const CACHE = "mindloop-shell-v15";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "js/ui.js",
  "js/logic.js",
  "js/storage.js",
  "js/auth.js",
  "js/supabase.js",

  "js/insights.js",
  "js/account.js",
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
