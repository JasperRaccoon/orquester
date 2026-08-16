/* Orquester service worker — hand-written classic script, root scope.
 * Copied verbatim into dist/ by Vite. Keep it dependency-free.
 *
 * Cache strategy:
 *   - navigations: network-first, offline fallback to cached /index.html
 *   - /assets/* (content-hashed): cache-first, trimmed to ~60 entries
 *   - root static files (icons, manifest): network-first, cache on success
 * Never-intercepted surfaces: non-GET requests and paths under /api, /events,
 * /ws, /health, /mcp, /devtools-frontend, /ws-devtools reach the network
 * untouched (auth, NDJSON streams, websockets, tokenized downloads, and the
 * proxied Chrome DevTools frontend/CDP must not be handled by the SW — caching
 * or the offline index.html fallback would corrupt them, surfacing as
 * "Failed to convert value to 'Response'").
 */

var VERSION = "v5";
var SHELL_CACHE = "orq-shell-" + VERSION;
var ASSET_CACHE = "orq-assets-" + VERSION;
var CURRENT_CACHES = [SHELL_CACHE, ASSET_CACHE];
var ASSET_CACHE_LIMIT = 60;

// Paths whose GETs must always hit the network directly (no respondWith).
// /devtools-frontend serves Chrome's own DevTools bundle (proxied) and must
// never be cached or fall back to index.html; /ws-devtools is its CDP socket.
var BYPASS_PREFIXES = ["/api", "/events", "/ws", "/health", "/mcp", "/devtools-frontend", "/ws-devtools"];

// Precached with the shell: /index.html loads /theme-boot.js synchronously in
// <head> to paint the stored theme before first paint, so an offline start that
// served index.html from cache but had to fetch the script would flash the
// wrong colours (or block on a failing request).
var SHELL_PRECACHE = ["/index.html", "/theme-boot.js"];

self.addEventListener("install", function (event) {
  // Precache the app shell so the offline navigation fallback (which reads
  // SHELL_CACHE's "/index.html") has something to serve from the first load on.
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(function (cache) {
        // Not addAll: it is atomic, so one missing file (an older deploy with
        // no theme-boot.js) would leave the shell — and the offline navigation
        // fallback — uncached entirely.
        return Promise.all(
          SHELL_PRECACHE.map(function (path) {
            return cache.add(path).catch(function () {
              return undefined;
            });
          })
        );
      })
      .then(function () {
        return self.skipWaiting();
      })
      .catch(function () {
        return self.skipWaiting();
      })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (names) {
        return Promise.all(
          names.map(function (name) {
            if (CURRENT_CACHES.indexOf(name) === -1) {
              return caches.delete(name);
            }
            return undefined;
          })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

function isBypassed(url) {
  for (var i = 0; i < BYPASS_PREFIXES.length; i++) {
    var prefix = BYPASS_PREFIXES[i];
    if (url.pathname === prefix || url.pathname.indexOf(prefix + "/") === 0) {
      return true;
    }
  }
  return false;
}

function trimCache(cacheName, limit) {
  return caches.open(cacheName).then(function (cache) {
    return cache.keys().then(function (keys) {
      if (keys.length <= limit) return undefined;
      // Delete oldest entries (keys() is insertion-ordered) until under limit.
      var overflow = keys.length - limit;
      var deletions = [];
      for (var i = 0; i < overflow; i++) {
        deletions.push(cache.delete(keys[i]));
      }
      return Promise.all(deletions);
    });
  });
}

function networkFirstNavigation(event) {
  return fetch(event.request)
    .then(function (response) {
      // Refresh the cached shell on each successful navigation so it stays
      // current across deploys. Key it under "/index.html" (not the request URL,
      // which is "/") to match the offline fallback's cache.match lookup.
      if (response && response.ok) {
        var copy = response.clone();
        event.waitUntil(
          caches.open(SHELL_CACHE).then(function (cache) {
            return cache.put("/index.html", copy);
          })
        );
      }
      return response;
    })
    .catch(function () {
      return caches.open(SHELL_CACHE).then(function (cache) {
        return cache.match("/index.html").then(function (cached) {
          return cached || Response.error();
        });
      });
    });
}

function cacheFirstAsset(event) {
  return caches.open(ASSET_CACHE).then(function (cache) {
    return cache.match(event.request).then(function (cached) {
      if (cached) return cached;
      return fetch(event.request).then(function (response) {
        if (response && response.ok) {
          cache.put(event.request, response.clone());
          event.waitUntil(trimCache(ASSET_CACHE, ASSET_CACHE_LIMIT));
        }
        return response;
      });
    });
  });
}

function networkFirstStatic(event) {
  return fetch(event.request)
    .then(function (response) {
      if (response && response.ok) {
        var copy = response.clone();
        event.waitUntil(
          caches.open(SHELL_CACHE).then(function (cache) {
            return cache.put(event.request, copy);
          })
        );
      }
      return response;
    })
    .catch(function () {
      return caches.open(SHELL_CACHE).then(function (cache) {
        return cache.match(event.request).then(function (cached) {
          // An offline miss must still resolve to a Response: returning the
          // `undefined` from cache.match rejects respondWith with "Failed to
          // convert value to 'Response'" instead of a plain network error.
          return cached || Response.error();
        });
      });
    });
}

self.addEventListener("fetch", function (event) {
  var request = event.request;

  // Only handle GETs; everything else reaches the network untouched.
  if (request.method !== "GET") return;

  var url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }

  // Only same-origin requests; cross-origin left to the network.
  if (url.origin !== self.location.origin) return;

  // Never intercept auth/streaming/websocket/health/mcp surfaces.
  if (isBypassed(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(event));
    return;
  }

  if (url.pathname.indexOf("/assets/") === 0) {
    event.respondWith(cacheFirstAsset(event));
    return;
  }

  // Root static files (icons, manifest, favicons): network-first, cache on ok.
  event.respondWith(networkFirstStatic(event));
});

// --- Web Push -------------------------------------------------------------

self.addEventListener("push", function (event) {
  var payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (err) {
      payload = {};
    }
  }
  var title = payload.title || "Orquester";
  var options = {
    body: payload.body || "",
    tag: payload.tag,
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { sessionId: payload.sessionId }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(function (clientList) {
        for (var i = 0; i < clientList.length; i++) {
          var client = clientList[i];
          if ("focus" in client) {
            return client.focus();
          }
        }
        if (self.clients.openWindow) {
          return self.clients.openWindow("/");
        }
        return undefined;
      })
  );
});
