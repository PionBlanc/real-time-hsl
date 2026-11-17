import { helsinkiDate, tripStartSeconds } from './hfp'
import type { Mode, Msg } from './hfp'

export interface TripStop {
  id: string // without "HSL:"
  name: string
  code: string
  lat: number
  lng: number
  t: number // scheduled departure, s since service-day midnight
}

export interface Trip {
  headsign: string
  name: string
  shape: Array<[number, number]>
  stops: Array<TripStop>
}

export class MissingKeyError extends Error {}

export const tripKey = (m: Msg): string => `${m.route}|${m.dir}|${m.oday}|${m.start}`

const tripCache = new Map<string, Promise<Trip | null>>()

export function fetchTrip(m: Msg): Promise<Trip | null> {
  const key = tripKey(m)
  let p = tripCache.get(key)
  if (!p) {
    const time = tripStartSeconds(m.start, m.oday, m.tst)
    const qs = new URLSearchParams({ route: m.route, dir: m.dir, date: m.oday, time: String(time) })
    p = fetch(`/api/trip?${qs}`).then(async (r) => {
      if (r.status === 503) throw new MissingKeyError()
      if (r.status === 404) return null
      if (!r.ok) throw new Error(`trip ${r.status}`)
      const d = await r.json()
      return {
        headsign: d.h,
        name: d.n,
        shape: decodePolyline(d.g),
        stops: d.s.map((s: [string, string, string, number, number, number]) => ({
          id: s[0],
          name: s[1],
          code: s[2],
          lat: s[3],
          lng: s[4],
          t: s[5],
        })),
      }
    })
    p.catch(() => tripCache.delete(key)) // allow retry after failures
    tripCache.set(key, p)
  }
  return p
}

export interface RouteRef {
  id: string
  n: string
  m: string
}

const routeCache = new Map<string, Promise<Array<RouteRef>>>()

export function fetchRoutes(line: string): Promise<Array<RouteRef>> {
  const key = line.toUpperCase()
  let p = routeCache.get(key)
  if (!p) {
    p = fetch(`/api/routes?q=${encodeURIComponent(key)}`).then((r) => {
      if (r.status === 503) throw new MissingKeyError()
      if (!r.ok) throw new Error(`routes ${r.status}`)
      return r.json()
    })
    p.catch(() => routeCache.delete(key))
    routeCache.set(key, p)
  }
  return p
}

/** GTFS/OTP mode name → app mode. */
export function gtfsMode(m: string): Mode | null {
  switch (m) {
    case 'BUS':
      return 'bus'
    case 'TRAM':
      return 'tram'
    case 'SUBWAY':
      return 'metro'
    case 'RAIL':
      return 'train'
    case 'FERRY':
      return 'ferry'
    default:
      return null
  }
}

export interface StopRef {
  id: string // without "HSL:"
  name: string
  code: string
  lat: number
  lng: number
  mode: Mode | null
}

export interface Departure {
  line: string
  mode: Mode | null
  headsign: string
  at: number // estimated (or scheduled) departure, unix seconds
  sched: number // scheduled departure, unix seconds
  clockSec: number // estimated departure, s since service-day midnight (for clock())
  realtime: boolean
  canceled: boolean
  // For matching against live HFP vehicles:
  route: string
  dir: string
  date: string // service day YYYY-MM-DD
  start: number // trip start, s since service-day midnight (-1 = unknown)
}

export interface StopBoard {
  stop: StopRef
  platform: string
  departures: Array<Departure>
}

/** Same departure across fetches (realtime estimates change, these don't). */
export function departureKey(d: Departure): string {
  return `${d.route}|${d.dir}|${d.date}|${d.start}|${d.sched}`
}

/** Departures per board request; fixed server-side (PAGE in api/stop.ts). */
export const STOP_PAGE = 20

/**
 * Next STOP_PAGE departures from now, or from `start` (unix s) when paging further ahead.
 * `start` is rounded down to the minute (the API only accepts whole minutes, for caching),
 * so a page may repeat departures from that minute; dedupe with departureKey().
 */
export async function fetchStopBoard(id: string, start?: number): Promise<StopBoard | null> {
  const r = await fetch(
    `/api/stop?id=${encodeURIComponent(id)}${start != null ? `&start=${Math.floor(start / 60) * 60}` : ''}`,
  )
  if (r.status === 503) throw new MissingKeyError()
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`stop ${r.status}`)
  const d = await r.json()
  type Row = [string, string, string, number, number, number, number, number, string, number, number]
  return {
    stop: { id, name: d.n, code: d.c, lat: d.la, lng: d.lo, mode: gtfsMode(d.m) },
    platform: d.p,
    departures: (d.d as Array<Row>).map((x) => ({
      line: x[0],
      mode: gtfsMode(x[1]),
      headsign: x[2],
      at: x[3] + x[5],
      sched: x[3] + x[4],
      clockSec: x[5],
      realtime: x[6] === 1,
      canceled: x[7] === 1,
      route: x[8],
      dir: String(x[9]),
      // Service day starts at local midnight (noon - 12 h), so +12 h lands safely mid-day.
      date: helsinkiDate(new Date((x[3] + 43200) * 1000)),
      start: x[10],
    })),
  }
}

// Stops are fetched per fixed grid cell; keep in sync with api/stops.ts.
export const CELL_LAT = 0.02
export const CELL_LON = 0.04
const cellCache = new Map<string, Promise<Array<StopRef>>>()

export function fetchStopCell(la: number, lo: number): Promise<Array<StopRef>> {
  const key = `${la}/${lo}`
  let p = cellCache.get(key)
  if (!p) {
    p = fetch(`/api/stops?la=${la}&lo=${lo}`).then(async (r) => {
      if (r.status === 503) throw new MissingKeyError()
      if (!r.ok) throw new Error(`stops ${r.status}`)
      const d = (await r.json()) as Array<[string, string, string, number, number, string]>
      return d.map((s) => ({ id: s[0], name: s[1], code: s[2], lat: s[3], lng: s[4], mode: gtfsMode(s[5]) }))
    })
    p.catch(() => cellCache.delete(key))
    cellCache.set(key, p)
  }
  return p
}

/** Google encoded polyline (precision 5) → [lat, lng][] */
export function decodePolyline(s: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let i = 0
  let lat = 0
  let lng = 0
  while (i < s.length) {
    for (let k = 0; k < 2; k++) {
      let shift = 0
      let result = 0
      let b: number
      do {
        b = s.charCodeAt(i++) - 63
        result |= (b & 0x1f) << shift
        shift += 5
      } while (b >= 0x20)
      const d = result & 1 ? ~(result >> 1) : result >> 1
      if (k === 0) lat += d
      else lng += d
    }
    out.push([lat / 1e5, lng / 1e5])
  }
  return out
}
