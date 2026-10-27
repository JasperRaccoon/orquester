/* Orquester service worker — hand-written classic script, root scope.
 * Copied verbatim into dist/ by Vite. Keep it dependency-free.
 *
 * Cache strategy:
 *   - navigations: network-first, falling back to cached /index.html when
 *     offline or when the network has not answered in 3.5 s (a bad link)
 *   - /assets/* (content-hashed): cache-first, trimmed to ~200 entries, never
 *     evicting the assets the cached shell (/index.html) loads itself
 *   - root static files (icons, manifest, theme-boot.js): network-first with
 *     the same timeout, cache on success
 * Never-intercepted surfaces: non-GET requests and paths under /api, /events,
 * /ws, /health, /mcp, /devtools-frontend, /ws-devtools reach the network
 * untouched (auth, NDJSON streams, websockets, tokenized downloads, and the
 * proxied Chrome DevTools frontend/CDP must not be handled by the SW — caching
 * or the offline index.html fallback would corrupt them, surfacing as
 * "Failed to convert value to 'Response'").
 */

var VERSION = "v6";
var SHELL_CACHE = "orq-shell-" + VERSION;
var ASSET_CACHE = "orq-assets-" + VERSION;
var CURRENT_CACHES = [SHELL_CACHE, ASSET_CACHE];
// Lazy chunks add up (Mermaid alone is ~36, KaTeX's fonts ~20 more), so the
// cap leaves room for them beside the app's own bundle.
var ASSET_CACHE_LIMIT = 200;

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

// The /assets/ paths a shell document loads itself: its entry script, its
// stylesheet and its modulepreloads.
function shellAssetPaths(html) {
  var paths = {};
  var pattern = /\/assets\/[^"'\s?#()<>]+/g;
  var match;
  while ((match = pattern.exec(html)) !== null) {
    paths[match[0]] = true;
  }
  return paths;
}

// What trimming must keep: the assets the cached /index.html loads. An
// offline start serves that document, and without its entry chunk the app is
// blank — so they are never the "oldest" an overflow evicts.
function pinnedAssetPaths() {
  return caches
    .open(SHELL_CACHE)
    .then(function (cache) {
      return cache.match("/index.html");
    })
    .then(function (response) {
      return response ? response.text() : "";
    })
    .then(shellAssetPaths, function () {
      return {};
    });
}

function trimCache(cacheName, limit) {
  return caches.open(cacheName).then(function (cache) {
    return cache.keys().then(function (keys) {
      // Under the limit (the usual case) the shell is not read at all.
      if (keys.length <= limit) return undefined;
      return pinnedAssetPaths().then(function (pinned) {
        // Delete the oldest unpinned entries (keys() is insertion-ordered)
        // until under the limit.
        var overflow = keys.length - limit;
        var deletions = [];
        for (var i = 0; i < keys.length && deletions.length < overflow; i++) {
          if (pinned[new URL(keys[i].url).pathname]) continue;
          deletions.push(cache.delete(keys[i]));
        }
        return Promise.all(deletions);
      });
    });
  });
}

// How long a navigation (or a root static file) waits on the network before a
// cached copy answers instead. A good link answers well inside it; a bad
// mobile one — connected, but losing most packets — can hold a fetch for a
// minute before it fails, and the app would sit on a white screen all that
// time. The network keeps going after the timeout and refreshes the cache for
// the next start. Without a cached copy the network is waited on, as before.
var NETWORK_FIRST_TIMEOUT_MS = 3500;

// Network-first with a timeout: the network's answer when it comes in time (and
// cached under `cacheKey` when ok), else the cached copy, else whatever the
// network eventually answers.
function networkFirstWithTimeout(event, cacheKey) {
  var refreshed = null;
  var network = fetch(event.request).then(function (response) {
    if (response && response.ok) {
      var copy = response.clone();
      refreshed = caches.open(SHELL_CACHE).then(function (cache) {
        return cache.put(cacheKey, copy);
      });
    }
    return response;
  });
  // Keeps the worker alive for a network answer that comes after the timeout,
  // so its copy still lands in the cache.
  event.waitUntil(
    network
      .then(function () {
        return refreshed;
      })
      .catch(function () {
        return undefined;
      })
  );
  var cached = function () {
    return caches.open(SHELL_CACHE).then(function (cache) {
      return cache.match(cacheKey);
    });
  };
  return new Promise(function (resolve) {
    var settled = false;
    var answer = function (response) {
      if (settled) return;
      settled = true;
      resolve(response);
    };
    var timer = setTimeout(function () {
      cached().then(
        function (copy) {
          if (copy) answer(copy);
        },
        function () {
          return undefined;
        }
      );
    }, NETWORK_FIRST_TIMEOUT_MS);
    network.then(
      function (response) {
        clearTimeout(timer);
        answer(response);
      },
      function () {
        clearTimeout(timer);
        cached().then(
          function (copy) {
            // An offline miss must still resolve to a Response: `undefined`
            // rejects respondWith with "Failed to convert value to 'Response'"
            // instead of a plain network error.
            answer(copy || Response.error());
          },
          function () {
            answer(Response.error());
          }
        );
      }
    );
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
    // Cache every successful navigation under the offline shell's lookup key.
    event.respondWith(networkFirstWithTimeout(event, "/index.html"));
    return;
  }

  if (url.pathname.indexOf("/assets/") === 0) {
    event.respondWith(cacheFirstAsset(event));
    return;
  }

  // Root static files (icons, manifest, favicons): network-first, cache on ok.
  event.respondWith(networkFirstWithTimeout(event, request));
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
    data: {
      // A session's notification names the session (its tap opens that tab).
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : undefined,
      // A workflow run's notification names its run (daemon push.ts, notifyWorkflowRun).
      workflowId: typeof payload.workflowId === "string" ? payload.workflowId : undefined,
      runId: typeof payload.runId === "string" ? payload.runId : undefined
    }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// An id as the app's deep links accept it (lib/workflows/deep-link.ts,
// lib/session-deep-link.ts).
function isLinkId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

// What tapping a notification opens, from its data: `url` for a new window
// (the app reads the link on boot and drops it from the address bar), and
// `message` for an open one (the app opens the same thing in place).
//   - a workflow run's (daemon push.ts, notifyWorkflowRun): that run, in the
//     workflow's tab — /?workflow=<id>&run=<runId>;
//   - a session's (needs input, finished, plan ready, approval needed, an
//     agent's notify_user): that session's tab — /?session=<id>;
//   - anything else (the test push, an agent push without a session): the app.
function notificationTarget(data) {
  var record = data || {};
  var workflowId = isLinkId(record.workflowId) ? record.workflowId : null;
  if (workflowId) {
    var runId = isLinkId(record.runId) ? record.runId : null;
    return {
      url: "/?workflow=" + encodeURIComponent(workflowId) + (runId ? "&run=" + encodeURIComponent(runId) : ""),
      message: { type: "orquester:open-workflow-run", workflowId: workflowId, runId: runId }
    };
  }
  var sessionId = isLinkId(record.sessionId) ? record.sessionId : null;
  if (sessionId) {
    return {
      url: "/?session=" + encodeURIComponent(sessionId),
      message: { type: "orquester:open-session", sessionId: sessionId }
    };
  }
  return { url: "/", message: null };
}

// An open window is focused and told what to open; else a new one starts on
// the link.
function openNotificationTarget(clients, target) {
  return clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
    for (var i = 0; i < clientList.length; i++) {
      var client = clientList[i];
      if ("focus" in client) {
        if (target.message) {
          client.postMessage(target.message);
        }
        return client.focus();
      }
    }
    if (clients.openWindow) {
      return clients.openWindow(target.url);
    }
    return undefined;
  });
}

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  event.waitUntil(openNotificationTarget(self.clients, notificationTarget(event.notification.data)));
});
