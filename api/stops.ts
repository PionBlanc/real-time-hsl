// GET /api/stops?city=hsl&la=3008&lo=623
// All stops in one fixed grid cell (CELL_LAT x CELL_LON degrees), so responses cache well.
import { localId } from './_cities'
import { apiKey, badRequest, canonicalInt, cityParam, graphql, guard, json, noKey, upstreamError } from './_digitransit'

export const config = { runtime: 'edge' }

// Keep in sync with src/stops.ts
const CELL_LAT = 0.02
const CELL_LON = 0.04

const QUERY = `query($a:Float!,$b:Float!,$c:Float!,$d:Float!){
  stopsByBbox(minLat:$a,minLon:$b,maxLat:$c,maxLon:$d){gtfsId name code lat lon vehicleMode}
}`

/** Digitransit GraphQL response (only the fields queried above). */
interface Resp {
  stopsByBbox: Array<{
    gtfsId: string             // feed-prefixed stop id, e.g. "HSL:1130446" (other regions' stops have other prefixes)
    name: string               // e.g. "Kamppi"
    code: string | null        // short code shown at the stop, e.g. "H1234"
    lat: number
    lon: number
    vehicleMode: string | null // GTFS mode serving the stop: "BUS", "TRAM", "SUBWAY", "RAIL", "FERRY"…
  }> | null
}

export default async function handler(req: Request): Promise<Response> {
  const denied = guard(req, ['city', 'la', 'lo'])
  if (denied) return denied
  const key = apiKey()
  if (!key) return noKey()
  const q = new URL(req.url).searchParams
  const city = cityParam(q)
  const la = canonicalInt(q.get('la'))
  const lo = canonicalInt(q.get('lo'))
  // Only cells overlapping the city's service area.
  if (
    !city ||
    la == null ||
    lo == null ||
    la < Math.floor(city.area.south / CELL_LAT) ||
    la > Math.floor(city.area.north / CELL_LAT) ||
    lo < Math.floor(city.area.west / CELL_LON) ||
    lo > Math.floor(city.area.east / CELL_LON)
  )
    return badRequest()
  try {
    const d = await graphql<Resp>(key, city, QUERY, {
      a: la * CELL_LAT,
      b: lo * CELL_LON,
      c: (la + 1) * CELL_LAT,
      d: (lo + 1) * CELL_LON,
    })
    // Only this city's stops (a router can serve several feeds).
    const out = (d.stopsByBbox ?? []).flatMap((s) => {
      const id = localId(city, s.gtfsId)
      // [id without the feed prefix, name, code, lat, lon, mode]
      return id == null ? [] : [[id, s.name, s.code ?? '', s.lat, s.lon, s.vehicleMode ?? '']]
    })
    return json(out, 200, 'public, max-age=86400, s-maxage=86400, stale-while-revalidate=604800')
  } catch (e) {
    return upstreamError('stops', e)
  }
}
