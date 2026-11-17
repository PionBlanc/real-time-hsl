// GET /api/trip?route=2551&dir=1&date=2026-11-17&time=61200
// Resolves a live HFP vehicle to its GTFS trip: path geometry + stops with scheduled times.
import { apiKey, badRequest, canonicalInt, graphql, guard, json, noKey, upstreamError } from './_digitransit'

export const config = { runtime: 'edge' }

const QUERY = `query($r:String!,$d:Int!,$date:String!,$t:Int!){
  fuzzyTrip(route:$r,direction:$d,date:$date,time:$t){
    tripHeadsign
    route{shortName mode}
    pattern{patternGeometry{points}}
    stoptimes{scheduledDeparture stop{gtfsId name code lat lon}}
  }
}`

/**
 * Digitransit GraphQL response (only the fields queried above).
 * fuzzyTrip finds the trip from what HFP knows: route, direction, service day and start time.
 */
interface Resp {
  fuzzyTrip: null | {
    tripHeadsign: string | null // destination, e.g. "Kamppi"
    route: {
      shortName: string // line number shown to passengers, e.g. "551"
      mode: string      // GTFS mode: "BUS", "TRAM", "SUBWAY", "RAIL", "FERRY"
    }
    // A pattern is the sequence of stops/path shared by trips of a route+direction.
    // points: path as a Google encoded polyline (decoded by decodePolyline in src/api.ts)
    pattern: { patternGeometry: { points: string } | null }
    stoptimes: Array<{
      scheduledDeparture: number // s since service-day midnight (may exceed 86400)
      // Same fields as in stops.ts
      stop: { gtfsId: string; name: string; code: string | null; lat: number; lon: number }
    }>
  }
}

export default async function handler(req: Request): Promise<Response> {
  const denied = guard(req, ['route', 'dir', 'date', 'time'])
  if (denied) return denied
  const key = apiKey()
  if (!key) return noKey()
  const q = new URL(req.url).searchParams
  const route = q.get('route') ?? ''
  const dir = q.get('dir') ?? ''
  const date = q.get('date') ?? ''
  const time = canonicalInt(q.get('time'))
  if (
    // HSL route ids: 2–4 digits plus up to 3 more (2551, 1001H, 31M1, 3002U, 4611BK…; checked 2026-11).
    !/^\d{2,4}[0-9A-Z]{0,3}$/.test(route) ||
    !/^[12]$/.test(dir) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    // Live vehicles only run on yesterday's, today's or tomorrow's service day.
    !(Math.abs(Date.parse(`${date}T12:00:00Z`) - Date.now()) < 2 * 86_400_000) ||
    // HFP start times are HH:mm, so whole minutes, at most 48 h into the service day.
    time == null || time % 60 !== 0 || time > 172_800
  ) {
    return badRequest()
  }
  try {
    const d = await graphql<Resp>(key, QUERY, {
      r: `HSL:${route}`,
      d: Number(dir) - 1, // HFP 1/2 -> GTFS 0/1
      date,
      t: time,
    })
    const t = d.fuzzyTrip
    if (!t) return json({ error: 'not_found' }, 404, 'public, s-maxage=300')
    return json(
      {
        h: t.tripHeadsign ?? '',
        n: t.route.shortName,
        m: t.route.mode,
        g: t.pattern.patternGeometry?.points ?? '',
        // [id without "HSL:", name, code, lat, lon, scheduled departure (s since service-day midnight)]
        s: t.stoptimes.map((st) => [
          st.stop.gtfsId.replace(/^HSL:/, ''),
          st.stop.name,
          st.stop.code ?? '',
          st.stop.lat,
          st.stop.lon,
          st.scheduledDeparture,
        ]),
      },
      200,
      // A trip on a given date never changes: cache hard at the edge.
      'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400',
    )
  } catch (e) {
    return upstreamError('trip', e)
  }
}
