// Service worker: makes the app open instantly (and offline-tolerant) after the first visit.
// - /assets/* are content-hashed → cache-first.
// - The page itself → stale-while-revalidate (instant open, updates next time).
// - /api/* and live data are never touched here (tiles use normal HTTP caching).
const CACHE = 'hsl-live-v3'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return

  if (req.mode === 'navigate') {
    e.respondWith(staleWhileRevalidate(new Request('/'), e, pruneAssets))
  } else if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.open(CACHE).then((c) =>
        c.match(req).then(
          (hit) =>
            hit ||
            fetch(req).then((res) => {
              if (res.ok) c.put(req, res.clone())
              return res
            }),
        ),
      ),
    )
  } else {
    e.respondWith(staleWhileRevalidate(req, e))
  }
})

/**
 * Each deploy adds new content-hashed JS/CSS. Once a new page is cached, delete the JS/CSS it
 * no longer references, so the cache doesn't grow forever. (Other assets, e.g. images from
 * CSS, are left alone: they're small and rarely change.)
 */
function pruneAssets(c, html) {
  const keep = new Set(html.match(/\/assets\/[^"'\s)]+/g) || [])
  return c.keys().then((reqs) =>
    Promise.all(
      reqs
        .map((r) => new URL(r.url).pathname)
        .filter((p) => p.startsWith('/assets/') && /\.(js|css)$/.test(p) && !keep.has(p))
        .map((p) => c.delete(p)),
    ),
  )
}

/** onPage(cache, html): optional, run after a fresh copy of the page has been cached. */
function staleWhileRevalidate(req, e, onPage) {
  return caches.open(CACHE).then((c) =>
    c.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (!res.ok) return res
          const put = c.put(req, res.clone())
          // With a cache hit, `net` is kept alive by waitUntil below, so finish the work first.
          // Without one, the page is waiting for `res`: return it right away.
          if (!hit) return res
          const text = onPage ? res.clone().text() : null
          return put
            .then(() => text && text.then((t) => onPage(c, t)))
            .catch(() => {})
            .then(() => res)
        })
        .catch(() => hit)
      if (hit) {
        e.waitUntil(net)
        return hit
      }
      return net
    }),
  )
}
