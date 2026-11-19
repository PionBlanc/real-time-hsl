// GET /api/routes?city=hsl&q=551  ->  [{ id: "2551", n: "551", m: "BUS" }]
// Maps a line number as shown to passengers to the city's route ids (as in its live feed).
import { localId } from './_cities'
import { apiKey, badRequest, cityParam, graphql, guard, json, noKey, upstreamError } from './_digitransit'

export const config = { runtime: 'edge' }

const QUERY = `query($f:[String],$n:String!){routes(feeds:$f,name:$n){gtfsId shortName mode}}`

export default async function handler(req: Request): Promise<Response> {
  const denied = guard(req, ['city', 'q'])
  if (denied) return denied
  const key = apiKey()
  if (!key) return noKey()
  const params = new URL(req.url).searchParams
  const city = cityParam(params)
  const q = params.get('q') ?? ''
  // Upper case only (the client upper-cases), so "m1" and "M1" don't cache separately.
  if (!city || !city.ids.line.test(q)) return badRequest()
  try {
    const d = await graphql<{ routes: Array<{ gtfsId: string; shortName: string | null; mode: string }> }>(
      key,
      city,
      QUERY,
      { f: [city.feedId], n: q },
    )
    const out = (d.routes ?? []).flatMap((r) => {
      const id = localId(city, r.gtfsId)
      return id != null && (r.shortName ?? '').toLowerCase() === q.toLowerCase()
        ? [{ id, n: r.shortName, m: r.mode }]
        : []
    })
    return json(out, 200, 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800')
  } catch (e) {
    return upstreamError('routes', e)
  }
}
