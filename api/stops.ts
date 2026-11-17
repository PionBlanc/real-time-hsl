// GET /api/stops?la=3008&lo=623
// All stops in one fixed grid cell (CELL_LAT x CELL_LON degrees), so responses cache well.
import { apiKey, badRequest, canonicalInt, graphql, guard, json, noKey, upstreamError } from './_digitransit'

export const config = { runtime: 'edge' }

// Keep in sync with src/stops.ts
const CELL_LAT = 0.02
const CELL_LON = 0.04

const QUERY = `query($a:Float!,$b:Float!,$c:Float!,$d:Float!){
  stopsByBbox(minLat:$a,minLon:$b,maxLat:$c,maxLon:$d){gtfsId name code lat lon vehicleMode}
}`

interface Resp {
  stopsByBbox: Array<{
    gtfsId: string
    name: string
    code: string | null
    lat: number
    lon: number
    vehicleMode: string | null
  }> | null
}

export default async function handler(req: Request): Promise<Response> {
  const denied = guard(req, ['la', 'lo'])
  if (denied) return denied
  const key = apiKey()
  if (!key) return noKey()
  const q = new URL(req.url).searchParams
  const la = canonicalInt(q.get('la'))
  const lo = canonicalInt(q.get('lo'))
  // Roughly the HSL region and its surroundings.
  if (la == null || lo == null || la < 2900 || la > 3150 || lo < 500 || lo > 750) return badRequest()
  try {
    const d = await graphql<Resp>(key, QUERY, {
      a: la * CELL_LAT,
      b: lo * CELL_LON,
      c: (la + 1) * CELL_LAT,
      d: (lo + 1) * CELL_LON,
    })
    const out = (d.stopsByBbox ?? [])
      .filter((s) => s.gtfsId.startsWith('HSL:'))
      // [id without "HSL:", name, code, lat, lon, mode]
      .map((s) => [s.gtfsId.slice(4), s.name, s.code ?? '', s.lat, s.lon, s.vehicleMode ?? ''])
    return json(out, 200, 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800')
  } catch (e) {
    return upstreamError('stops', e)
  }
}
