// GET /api/tile?z=13&x=4663&y=2371&r=@2x
// Proxies HSL's background map tiles so the Digitransit key stays server-side.
// Responses are cached hard by Vercel's CDN and the browser.
import { apiKey } from './_digitransit'

export const config = { runtime: 'edge' }

const SOURCE = 'hsl-map-en' // English labels; 512 px tiles (1024 px with @2x)

export default async function handler(req: Request): Promise<Response> {
  const key = apiKey()
  if (!key) return new Response('missing key', { status: 503 })
  const q = new URL(req.url).searchParams
  const z = Number(q.get('z'))
  const x = Number(q.get('x'))
  const y = Number(q.get('y'))
  const r = q.get('r') === '@2x' ? '@2x' : ''
  if (![z, x, y].every(Number.isInteger) || z < 0 || z > 20 || x < 0 || y < 0) {
    return new Response('bad request', { status: 400 })
  }
  const up = await fetch(`https://cdn.digitransit.fi/map/v3/${SOURCE}/${z}/${x}/${y}${r}.png`, {
    headers: { 'digitransit-subscription-key': key },
  })
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
