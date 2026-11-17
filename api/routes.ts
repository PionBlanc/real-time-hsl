// GET /api/routes?q=551  ->  [{ id: "2551", n: "551", m: "BUS" }]
// Maps a line number as shown to passengers to HFP/GTFS route ids.
import { apiKey, graphql, json, noKey } from './_digitransit'

export const config = { runtime: 'edge' }

const QUERY = `query($n:String!){routes(name:$n){gtfsId shortName mode}}`

export default async function handler(req: Request): Promise<Response> {
  const key = apiKey()
  if (!key) return noKey()
  const q = (new URL(req.url).searchParams.get('q') ?? '').trim()
  if (!/^[0-9A-Za-z]{1,8}$/.test(q)) return json({ error: 'bad_request' }, 400, 'no-store')
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
    return json({ error: 'upstream', detail: String(e) }, 502, 'no-store')
  }
}
