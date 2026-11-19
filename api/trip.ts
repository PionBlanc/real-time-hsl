// GET /api/trip?city=hsl&route=2551&dir=1&date=2026-11-17&time=61200   (HSL)
// GET /api/trip?city=tampere&trip=137_22357_17849130           (GTFS-RT cities)
// Resolves a live vehicle to its GTFS trip: path geometry + stops with scheduled times.
// Vehicles that know their trip id (GTFS-RT) are looked up by it; others (HFP has none) are
// matched by route, direction, day and start time. Which one is up to what the vehicle sends.
import { localId } from './_cities'
import type { City } from './_cities'
import {
  apiKey,
  badRequest,
  canonicalInt,
  cityParam,
  graphql,
  guard,
  json,
  noKey,
  upstreamError,
} from './_digitransit'

export const config = { runtime: 'edge' }

const TRIP_FIELDS = `
    tripHeadsign
    route{shortName mode}
    pattern{patternGeometry{points}}
    stoptimes{scheduledDeparture stop{gtfsId name code lat lon}}`

const FUZZY_QUERY = `query($r:String!,$d:Int!,$date:String!,$t:Int!){
  trip: fuzzyTrip(route:$r,direction:$d,date:$date,time:$t){${TRIP_FIELDS}}
}`

const ID_QUERY = `query($id:String!){
  trip(id:$id){${TRIP_FIELDS}}
}`

/** Digitransit GraphQL response (only the fields queried above). */
interface Resp {
  trip: null | {
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

/** The GraphQL query and variables for this request, or null if it's malformed. */
function lookup(city: City, q: URLSearchParams): { query: string; vars: Record<string, unknown> } | null {
  if (q.has('trip')) {
    const trip = q.get('trip') ?? ''
    if ([...q.keys()].length !== 2 || !city.ids.trip.test(trip)) return null
    return { query: ID_QUERY, vars: { id: `${city.feedId}:${trip}` } }
  }
  const route = q.get('route') ?? ''
  const dir = q.get('dir') ?? ''
  const date = q.get('date') ?? ''
  const time = canonicalInt(q.get('time'))
  if (
    !city.ids.route.test(route) ||
    !/^[12]$/.test(dir) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    // Live vehicles only run on yesterday's, today's or tomorrow's service day.
    !(Math.abs(Date.parse(`${date}T12:00:00Z`) - Date.now()) < 2 * 86_400_000) ||
    // HFP start times are HH:mm, so whole minutes, at most 48 h into the service day.
    time == null || time % 60 !== 0 || time > 172_800
  ) {
    return null
  }
  return {
    query: FUZZY_QUERY,
    vars: { r: `${city.feedId}:${route}`, d: Number(dir) - 1 /* HFP 1/2 -> GTFS 0/1 */, date, t: time },
  }
}

export default async function handler(req: Request): Promise<Response> {
  const denied = guard(req, ['city', 'route', 'dir', 'date', 'time', 'trip'])
  if (denied) return denied
  const key = apiKey()
  if (!key) return noKey()
  const q = new URL(req.url).searchParams
  const city = cityParam(q)
  const l = city && lookup(city, q)
  if (!city || !l) return badRequest()
  try {
    const t = (await graphql<Resp>(key, city, l.query, l.vars)).trip
    if (!t) return json({ error: 'not_found' }, 404, 'public, s-maxage=300')
    return json(
      {
        h: t.tripHeadsign ?? '',
        n: t.route.shortName,
        m: t.route.mode,
        g: t.pattern.patternGeometry?.points ?? '',
        // [id without the feed prefix, name, code, lat, lon, scheduled departure (s since service-day midnight)]
        s: t.stoptimes.map((st) => [
          localId(city, st.stop.gtfsId) ?? st.stop.gtfsId,
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
