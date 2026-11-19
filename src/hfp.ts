/**
 * HSL High-Frequency Positioning (HFP v2): the live feed for the HSL region.
 * Docs: https://digitransit.fi/en/developers/apis/5-realtime-api/vehicle-positions/high-frequency-positioning/
 *
 * Topic: /hfp/v2/journey/ongoing/vp/<mode>/<oper>/<veh>/<route>/<dir>/<headsign>/<start>/<next_stop>/<geohash_level>/<geohash...>
 */
import { CITIES } from '../api/_cities'
import { MODES, geohashCells, num } from './feed'
import type { Box, Feed, Mode, Msg } from './feed'

// VITE_BROKER is only for local testing against a fake broker.
export const BROKER: string = import.meta.env.VITE_BROKER || 'wss://mqtt.hsl.fi:443/'
const BASE = '/hfp/v2/journey/ongoing/vp'
/** The one city on this feed (HFP is HSL's own). */
const CITY = CITIES.find((c) => c.live === 'hfp')!

/**
 * The `VP` (vehicle position) object of an HFP payload: `{"VP": {...}}`.
 * Field names are HSL's abbreviations and must match the wire format.
 * Only the fields this app reads are typed; the payload also carries e.g. tsi (unix
 * seconds), acc (m/s²), odo (odometer, m), loc (position source), stop, occu, jrn, line.
 */
export interface VP {
  desi?: string        // route "designation" shown to passengers, e.g. "550", "M1"
  dir?: string         // direction of the route: "1" or "2"
  oper: number         // operator (transport company) id
  veh: number          // vehicle number, unique only within its operator
  tst: string          // timestamp of this position, UTC ISO 8601, e.g. "2026-11-17T08:15:30.123Z"
  spd: number | null   // speed, m/s
  hdg: number | null   // heading, degrees clockwise from north (0–360)
  lat: number | null   // latitude, WGS84
  long: number | null  // longitude, WGS84
  dl: number | null    // schedule deviation, seconds: negative = late, positive = early
  drst: number | null  // door status: 0 = all closed, 1 = some open
  oday: string | null  // operating day YYYY-MM-DD; after-midnight trips belong to the previous day
  start: string | null // scheduled trip start, local "HH:mm"
  route: string | null // route id, e.g. "2550" (no "HSL:" prefix)
}

const dec = new TextDecoder()

/** HFP topic transport modes that make up each app mode (U-line and robot buses are buses). */
const TOPIC_MODES: Record<Mode, Array<string>> = {
  bus: ['bus', 'ubus', 'robot'],
  tram: ['tram'],
  metro: ['metro'],
  train: ['train'],
  ferry: ['ferry'],
}

/**
 * Topic-level transport modes to subscribe to for the shown app modes, or null for all (`+`).
 * Per-mode filters multiply the filter count (which forces coarser geohash cells), so they
 * only pay off when buses, the bulk of the traffic, are hidden.
 */
export function topicModes(shown: ReadonlySet<Mode>): Array<string> | null {
  if (shown.has('bus')) return null
  return MODES.filter((m) => shown.has(m)).flatMap((m) => TOPIC_MODES[m])
}

function normMode(m: string): Mode | null {
  if (m === 'bus' || m === 'ubus' || m === 'robot') return 'bus'
  if (m === 'tram' || m === 'metro' || m === 'train' || m === 'ferry') return m
  return null
}

export function parseMessage(topic: string, payload: Uint8Array): Msg | null {
  const p = topic.split('/')
  if (p[5] !== 'vp') return null
  const mode = normMode(p[6])
  if (!mode) return null
  let vp: VP | undefined
  try {
    vp = JSON.parse(dec.decode(payload)).VP
  } catch {
    return null
  }
  if (!vp) return null
  // Validate what the rest of the app relies on: one malformed message must not put NaN
  // into Leaflet or make Intl date formatting throw (an invalid Date throws RangeError).
  const lat = num(vp.lat)
  const lng = num(vp.long)
  if (lat == null || lng == null || typeof vp.tst !== 'string' || Number.isNaN(Date.parse(vp.tst))) return null
  const start = p[12] || vp.start || ''
  const oday = vp.oday || ''
  return {
    city: CITY.id,
    id: `${p[7]}/${p[8]}`,
    mode,
    oper: p[7],
    veh: p[8], // zero-padded, as in the topic
    route: p[9] || vp.route || '',
    dir: p[10] || vp.dir || '1',
    headsign: p[11] || '',
    // '' (= unknown, no route lookup) unless well-formed.
    start: /^\d{2}:\d{2}$/.test(start) ? start : '',
    tripId: '', // HFP has none: trips are found from route, direction, day and start time
    nextStop: p[13] || '',
    desi: typeof vp.desi === 'string' ? vp.desi : '',
    lat,
    lng,
    hdg: num(vp.hdg),
    spd: num(vp.spd),
    dl: num(vp.dl),
    doorsOpen: vp.drst === 1,
    oday: /^\d{4}-\d{2}-\d{2}$/.test(oday) ? oday : '',
    tst: vp.tst,
  }
}

/**
 * Topic filters covering a lat/lng box using the geohash topic levels.
 * Picks the finest cell size (0.01°, 0.1° or 1°) that stays under maxFilters.
 * `levels` optionally restricts geohash_level (0–5); e.g. [0,1,2,3] only
 * delivers updates when a vehicle moved ≥ ~100 m, cutting traffic ~90 %.
 * `modes` optionally restricts the topic transport mode (see topicModes); [] = nothing.
 */
export function areaFilters(
  box: Box,
  maxFilters: number,
  levels: Array<number> | null = null,
  modes: Array<string> | null = null,
): Array<string> {
  const lv = levels ? levels.map(String) : ['+']
  const md = modes ?? ['+']
  if (!md.length) return []
  const out: Array<string> = []
  for (const g of geohashCells(box, maxFilters, lv.length * md.length))
    for (const l of lv) for (const m of md) out.push(`${BASE}/${m}/+/+/+/+/+/+/+/${l}/${g}/#`)
  return out
}

/** All vehicles on a route, anywhere (route id as in HFP/GTFS without "HSL:", e.g. "2551"). */
export const routeFilter = (routeId: string): string => `${BASE}/+/+/+/${routeId}/#`

/** One specific vehicle (oper/veh zero-padded as in the topic). */
export const vehicleFilter = (oper: string, veh: string): string =>
  `${BASE}/+/${oper}/${veh}/#`

/** Vehicles with this side number (kylkinumero) at any operator. */
export const vehicleNumberFilter = (n: number): string =>
  `${BASE}/+/+/${String(n).padStart(5, '0')}/#`

/** HSL's own HFP feed (mqtt.hsl.fi). It only covers the HSL region, so the city is ignored. */
export const hfp: Feed = {
  broker: BROKER,
  parse: parseMessage,
  area: (_city, box, maxFilters, onlyMoved, modes) =>
    // Geohash levels 0–3: only updates after the vehicle moved ~100 m (~12 % of the traffic).
    areaFilters(box, maxFilters, onlyMoved ? [0, 1, 2, 3] : null, topicModes(modes)),
  route: (_city, routeId) => routeFilter(routeId),
  vehicle: (_city, m) => vehicleFilter(m.oper, m.veh),
  vehicleNumber: (_city, n) => vehicleNumberFilter(n),
}
