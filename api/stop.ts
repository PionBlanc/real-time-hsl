// GET /api/stop?id=1130446[&start=<unix s, whole minute>]
// Next departures from one stop, with realtime estimates where available ("bus-stop screen").
// `start` pages further into the future (departures at or after that time).
import { apiKey, badRequest, canonicalInt, graphql, guard, json, noKey } from './_digitransit'

export const config = { runtime: 'edge' }

const QUERY = `query($id:String!,$start:Long!,$n:Int!){
  stop(id:$id){
    name code platformCode lat lon vehicleMode
    stoptimesWithoutPatterns(startTime:$start,numberOfDepartures:$n,omitNonPickups:true,omitCanceled:false){
      serviceDay scheduledDeparture realtimeDeparture realtime realtimeState headsign
      trip{ directionId route{gtfsId shortName mode} departureStoptime{scheduledDeparture} }
    }
  }
}`

interface Resp {
  stop: null | {
    name: string
    code: string | null
    platformCode: string | null
    lat: number
    lon: number
    vehicleMode: string | null
    stoptimesWithoutPatterns: Array<{
      serviceDay: number
      scheduledDeparture: number
      realtimeDeparture: number
      realtime: boolean
      realtimeState: string | null
      headsign: string | null
      trip: {
        directionId: string | null
        route: { gtfsId: string; shortName: string | null; mode: string }
        departureStoptime: { scheduledDeparture: number } | null
      }
    }>
  }
}

// Departures per request. Fixed (not a parameter) so it can't be varied to bypass the cache.
// Keep in sync with STOP_PAGE in src/api.ts.
const PAGE = 20

export default async function handler(req: Request): Promise<Response> {
  const denied = guard(req, ['id', 'start'])
  if (denied) return denied
  const key = apiKey()
  if (!key) return noKey()
  const q = new URL(req.url).searchParams
  const id = q.get('id') ?? ''
  const startS = q.get('start')
  const start = startS == null ? 0 : canonicalInt(startS) // 0 = now
  const nowS = Date.now() / 1000
  if (
    !/^[0-9A-Za-z_]{1,20}$/.test(id) ||
    start == null ||
    // Paging is by whole minutes, so at most one cache entry per stop per minute.
    (start !== 0 && (start % 60 !== 0 || start < nowS - 3600 || start > nowS + 7 * 86400))
  )
    return badRequest()
  try {
    const d = await graphql<Resp>(key, QUERY, { id: `HSL:${id}`, start, n: PAGE })
    const s = d.stop
    if (!s) return json({ error: 'not_found' }, 404, 'public, s-maxage=3600')
    return json(
      {
        n: s.name,
        c: s.code ?? '',
        p: s.platformCode ?? '',
        la: s.lat,
        lo: s.lon,
        m: s.vehicleMode ?? '',
        // [line, mode, headsign, service day (unix s), scheduled (s since service day),
        //  estimated (s), realtime 0/1, canceled 0/1, route id, HFP dir 1/2, trip start (s)]
        d: s.stoptimesWithoutPatterns.map((st) => [
          st.trip.route.shortName ?? '',
          st.trip.route.mode,
          st.headsign ?? '',
          st.serviceDay,
          st.scheduledDeparture,
          st.realtimeDeparture,
          st.realtime ? 1 : 0,
          st.realtimeState === 'CANCELED' ? 1 : 0,
          st.trip.route.gtfsId.replace(/^HSL:/, ''),
          Number(st.trip.directionId ?? 0) + 1, // GTFS 0/1 -> HFP 1/2
          st.trip.departureStoptime?.scheduledDeparture ?? -1,
        ]),
      },
      200,
      // Realtime estimates: keep it fresh, but let the edge absorb bursts.
      'public, max-age=10, s-maxage=15, stale-while-revalidate=15',
    )
  } catch (e) {
    return json({ error: 'upstream', detail: String(e) }, 502, 'no-store')
  }
}
