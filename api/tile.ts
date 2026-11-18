// GET /api/tile?z=13&x=4663&y=2371&r=2x
// Proxies HSL's background map tiles so the Digitransit key stays server-side.
// Responses are cached hard by Vercel's CDN and the browser.
import { UPSTREAM_TIMEOUT_MS, apiKey, canonicalInt, guard } from './_digitransit'

export const config = { runtime: 'edge' }

const SOURCE = 'hsl-map-en' // English labels; 512 px tiles (1024 px with @2x)

// The client uses zoomOffset -1 with map zoom 8–18, so it requests tile zooms 7–17.
const MIN_Z = 7
const MAX_Z = 17
// Only tiles around the HSL region are served (lat/lon degrees, generous margin).
const AREA = { south: 59.5, north: 61.0, west: 23.0, east: 27.0 }

const lonToX = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z)
function latToY(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z)
}

/** True for a tile that overlaps AREA (bounds also keep x, y below 2^z). */
export function tileInArea(z: number, x: number, y: number): boolean {
  return (
    z >= MIN_Z &&
    z <= MAX_Z &&
    x >= lonToX(AREA.west, z) &&
    x <= lonToX(AREA.east, z) &&
    y >= latToY(AREA.north, z) && // y grows southwards
    y <= latToY(AREA.south, z)
  )
}

const bad = () => new Response('bad request', { status: 400, headers: { 'cache-control': 'no-store' } })

export default async function handler(req: Request): Promise<Response> {
  const denied = guard(req, ['z', 'x', 'y', 'r'])
  if (denied) return denied
  const key = apiKey()
  if (!key) return new Response('missing key', { status: 503 })
  const q = new URL(req.url).searchParams
  const z = canonicalInt(q.get('z'))
  const x = canonicalInt(q.get('x'))
  const y = canonicalInt(q.get('y'))
  // Leaflet always sends r: empty, or "2x" on high-DPI screens.
  const r = q.get('r')
  if (z == null || x == null || y == null || (r !== '' && r !== '2x') || !tileInArea(z, x, y)) {
    return bad()
  }
  const suffix = r === '2x' ? '@2x' : ''
  let up: Response
  try {
    up = await fetch(`https://cdn.digitransit.fi/map/v3/${SOURCE}/${z}/${x}/${y}${suffix}.png`, {
      headers: { 'digitransit-subscription-key': key },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (e) {
    console.error('tile: upstream error:', e)
    return new Response(null, { status: 502, headers: { 'cache-control': 'public, max-age=0, s-maxage=10' } })
  }
  if (!up.ok) {
    return new Response(null, { status: up.status, headers: { 'cache-control': 'public, s-maxage=60' } })
  }
  return new Response(up.body, {
    headers: {
      'content-type': up.headers.get('content-type') ?? 'image/png',
      'cache-control': 'public, max-age=604800, s-maxage=2592000, stale-while-revalidate=2592000',
    },
  })
}
