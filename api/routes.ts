// GET /api/routes?q=551  ->  [{ id: "2551", n: "551", m: "BUS" }]
// Maps a line number as shown to passengers to HFP/GTFS route ids.
import { apiKey, badRequest, graphql, guard, json, noKey, upstreamError } from './_digitransit'

export const config = { runtime: 'edge' }

const QUERY = `query($n:String!){routes(name:$n){gtfsId shortName mode}}`

export default async function handler(req: Request): Promise<Response> {
  const denied = guard(req, ['q'])
  if (denied) return denied
  const key = apiKey()
  if (!key) return noKey()
  const q = new URL(req.url).searchParams.get('q') ?? ''
  // Shapes of real HSL line names (checked 2026-11: 551, 550B, 15, 9N, M1, I, U1A, 200AB…),
  // with a little slack. Keeps the uncacheable keyspace small. Upper case only (the client
  // upper-cases), so "m1" and "M1" don't cache separately.
  if (!/^(?:[A-Z]\d{0,2}[A-Z]?|\d{1,4}[A-Z]{0,2})$/.test(q)) return badRequest()
  try {
    const d = await graphql<{ routes: Array<{ gtfsId: string; shortName: string | null; mode: string }> }>(
      key,
      QUERY,
      { n: q },
    )
    const out = (d.routes ?? [])
      .filter((r) => r.gtfsId.startsWith('HSL:') && (r.shortName ?? '').toLowerCase() === q.toLowerCase())
      .map((r) => ({ id: r.gtfsId.slice(4), n: r.shortName, m: r.mode }))
    return json(out, 200, 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800')
  } catch (e) {
    return upstreamError('routes', e)
  }
}
