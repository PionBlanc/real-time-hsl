/**
 * What every live vehicle feed has in common. Each city's positions come from one of the
 * feeds implementing `Feed` (src/hfp.ts for HSL, src/gtfsrt.ts for Digitransit's GTFS-RT
 * cities); the rest of the app only sees `Msg` and never needs to know which feed it came from.
 */
import { MODES } from '../api/_cities'
import type { Area, City, CityId, Mode } from '../api/_cities'

export { MODES }
export type { Mode }

/**
 * Mode colours, HSL's palette with metro and ferry darkened (from #FF6319 and #00B9E4) so
 * white labels on them reach 4.5:1. Keep in sync with the .m-* and #modes rules in styles.css.
 */
export const COLORS: Record<Mode, string> = {
  bus: '#007AC9',
  tram: '#00985F',
  metro: '#D34400',
  train: '#8C4799',
  ferry: '#00819F',
}

export type Box = Area

/**
 * One vehicle-position update, the same shape whichever feed it came from.
 *
 * Convention: a fact shown to the user is null when the feed doesn't have it, and the UI
 * leaves it out. Never fill in a default that looks like real data (doors "closed", a
 * guessed vehicle number…). Ids used only for matching are "" when absent.
 */
export interface Msg {
  city: CityId              // which city's feed this vehicle is in
  id: string                // stable vehicle identity, unique across cities
  mode: Mode                // transport mode, normalised
  oper: string | null       // operator id as in the feed
  veh: string | null        // number painted on the vehicle (side number), may be zero-padded ("01234")
  route: string             // route id without the feed prefix, e.g. "2550"
  dir: string               // direction: "1" or "2" (HFP style; GTFS 0/1 is converted)
  headsign: string | null   // destination name shown on the vehicle
  start: string             // scheduled trip start, local "HH:mm"; "" if unknown
  tripId: string            // GTFS trip id without the feed prefix; "" if the feed has none (HSL)
  nextStop: string          // stop id without the feed prefix, or "EOL"/""
  desi: string | null       // route number shown to passengers, e.g. "550"
  lat: number               // latitude, WGS84
  lng: number               // longitude, WGS84
  hdg: number | null        // heading, degrees clockwise from north
  spd: number | null        // speed, m/s
  dl: number | null         // schedule deviation, seconds: negative = late, positive = early
  doorsOpen: boolean | null // some door open
  oday: string              // operating day YYYY-MM-DD; after-midnight trips belong to the previous day
  tst: string               // timestamp of this position, UTC ISO 8601
}

/**
 * A live position feed on one MQTT broker. All topic filters are for one city; a feed may
 * serve several cities (Digitransit's broker carries every GTFS-RT city).
 */
export interface Feed {
  broker: string
  /** Topic + payload → Msg, or null for anything malformed or not a vehicle position. */
  parse(topic: string, payload: Uint8Array): Msg | null
  /**
   * Filters for the vehicles inside `box`, using at most about `maxFilters` filters.
   * `onlyMoved`: only updates after a vehicle moved ~100 m, where the feed supports it.
   */
  area(city: City, box: Box, maxFilters: number, onlyMoved: boolean, modes: ReadonlySet<Mode>): Array<string>
  /** All vehicles on a route (route id without the feed prefix). */
  route(city: City, routeId: string): string
  /** This one vehicle, wherever it goes. */
  vehicle(city: City, m: Msg): string
  /** Vehicles that may have this side number (the app still checks Msg.veh). */
  vehicleNumber(city: City, n: number): string
}

/** A finite number, or null for anything else (missing, null, a string…). */
export const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/**
 * Geohash topic levels for the cell containing (la, lo), both already scaled by 10^p and
 * floored: "60;24" for 1° cells, "60;24/19" for 0.1°, "60;24/19/85" for 0.01°.
 * The same scheme is used by HSL's HFP and Digitransit's GTFS-RT topics.
 */
export function geohash(la: number, lo: number, p: number): string {
  const f = 10 ** p
  const iLat = Math.floor(la / f)
  const iLon = Math.floor(lo / f)
  let s = `${iLat};${iLon}`
  if (p > 0) {
    const a = String(la - iLat * f).padStart(p, '0')
    const b = String(lo - iLon * f).padStart(p, '0')
    for (let i = 0; i < p; i++) s += `/${a[i]}${b[i]}`
  }
  return s
}

/**
 * The geohash cells covering a box: the finest cell size (0.01°, 0.1° or 1°) for which
 * `cells × perCell` stays within maxFilters (1° cells are used regardless).
 */
export function geohashCells(box: Box, maxFilters: number, perCell: number): Array<string> {
  for (const p of [2, 1, 0]) {
    const f = 10 ** p
    const la0 = Math.floor(box.south * f)
    const la1 = Math.floor(box.north * f)
    const lo0 = Math.floor(box.west * f)
    const lo1 = Math.floor(box.east * f)
    const cells = (la1 - la0 + 1) * (lo1 - lo0 + 1)
    if (cells * perCell > maxFilters && p > 0) continue
    const out: Array<string> = []
    for (let la = la0; la <= la1; la++) for (let lo = lo0; lo <= lo1; lo++) out.push(geohash(la, lo, p))
    return out
  }
  return []
}
