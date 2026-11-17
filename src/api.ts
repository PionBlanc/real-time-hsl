import { helsinkiDate, tripStartSeconds } from './hfp'
import type { Mode, Msg } from './hfp'

/*
 * Client-side types for our own /api/* endpoints (see api/*.ts), which wrap the
 * Digitransit GraphQL API. The endpoints send compact JSON (short keys, positional
 * arrays) to save bandwidth; the fetch* functions below expand it into these types.
 * Query params must be in the order api/*.ts lists them in guard() (else 400).
 * Positional arrays are append-only (see api/_digitransit.ts).
 *
 * Time conventions:
 * - "service day": the operating day a trip belongs to. Trips after midnight still
 *   belong to the previous day, so "s since service-day midnight" can exceed 86400.
 * - "unix s": seconds since 1970-01-01 UTC.
 */

/** One stop along a trip (from /api/trip). */
export interface TripStop {
  id: string   // GTFS stop id without "HSL:", e.g. "1130446"
  name: string // stop name, e.g. "Kamppi"
  code: string // short code shown at the stop, e.g. "H1234"; "" if none
  lat: number
  lng: number
  t: number    // scheduled departure, s since service-day midnight
}

/** The scheduled trip a live vehicle is running (from /api/trip). */
export interface Trip {
  headsign: string               // destination, e.g. "Kamppi"
  name: string                   // line number shown to passengers, e.g. "551"
  shape: Array<[number, number]> // path the vehicle drives, [lat, lng] points
  stops: Array<TripStop>         // in driving order
}

export class MissingKeyError extends Error {}

export const tripKey = (m: Msg): string => `${m.route}|${m.dir}|${m.oday}|${m.start}`

/** Trips hold whole route shapes: keep only the most recently used ones (Map order = LRU). */
const TRIP_CACHE_MAX = 50
const tripCache = new Map<string, Promise<Trip | null>>()

export function fetchTrip(m: Msg): Promise<Trip | null> {
  const key = tripKey(m)
  let p = tripCache.get(key)
  if (p) {
    tripCache.delete(key)
    tripCache.set(key, p)
  } else {
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
    if (tripCache.size > TRIP_CACHE_MAX) tripCache.delete(tripCache.keys().next().value!)
  }
  return p
}

/** A route matching a searched line number (from /api/routes, used as-is). */
export interface RouteRef {
  id: string // route id without "HSL:", as in HFP topics, e.g. "2551"
  n: string  // name: line number shown to passengers, e.g. "551"
  m: string  // GTFS mode: "BUS", "TRAM", "SUBWAY", "RAIL", "FERRY" (see gtfsMode)
}

const routeCache = new Map<string, Promise<Array<RouteRef>>>()

export function fetchRoutes(line: string): Promise<Array<RouteRef>> {
  const key = line.toUpperCase()
  let p = routeCache.get(key)
  if (!p) {
    p = fetch(`/api/routes?q=${encodeURIComponent(key)}`).then((r) => {
      if (r.status === 503) throw new MissingKeyError()
      if (r.status === 400) return [] // not shaped like any HSL line name
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

/** A stop on the map (from /api/stops, and the header of /api/stop). */
export interface StopRef {
  id: string        // GTFS stop id without "HSL:", e.g. "1130446"
  name: string      // stop name, e.g. "Kamppi"
  code: string      // short code shown at the stop, e.g. "H1234"; "" if none
  lat: number
  lng: number
  mode: Mode | null // what serves the stop; null if unknown or not an app mode
}

/** One upcoming departure from a stop (from /api/stop). */
export interface Departure {
  line: string      // line number shown to passengers, e.g. "551"
  mode: Mode | null
  headsign: string  // destination, e.g. "Kamppi"
  at: number        // estimated (or scheduled) departure, unix seconds
  sched: number     // scheduled departure, unix seconds
  clockSec: number  // estimated departure, s since service-day midnight (for clock())
  realtime: boolean // true = `at` is a live estimate, false = only the timetable
  canceled: boolean // trip is canceled (still listed, so it can be shown struck out)
  // For matching against live HFP vehicles (same meaning as in Msg):
  route: string // route id without "HSL:", e.g. "2551"
  dir: string   // direction "1" or "2", HFP style
  date: string  // service day YYYY-MM-DD (Msg.oday)
  start: number // trip's start at its first stop, s since service-day midnight (-1 = unknown)
}

/** The departure board ("bus-stop screen") of one stop (from /api/stop). */
export interface StopBoard {
  stop: StopRef
  platform: string             // platform/track number, e.g. "3"; "" if none
  departures: Array<Departure> // in time order, STOP_PAGE at most
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
