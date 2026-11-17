// Service worker: makes the app open instantly (and offline-tolerant) after the first visit.
// - /assets/* are content-hashed → cache-first.
// - The page itself → stale-while-revalidate (instant open, updates next time).
// - /api/* and live data are never touched here (tiles use normal HTTP caching).
const CACHE = 'hsl-live-v2'

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
    e.respondWith(staleWhileRevalidate(new Request('/'), e))
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

function staleWhileRevalidate(req, e) {
  return caches.open(CACHE).then((c) =>
    c.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res.ok) c.put(req, res.clone())
          return res
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
