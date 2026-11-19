/**
 * Digitransit's GTFS-RT vehicle positions over MQTT (mqtt.digitransit.fi): the live feed for
 * every city except HSL. No API key needed.
 * Docs: https://digitransit.fi/en/developers/apis/5-realtime-api/vehicle-positions/digitransit-mqtt/
 *
 * Topic: /gtfsrt/vp/<feed_id>/<agency_id>/<agency_name>/<mode>/<route_id>/<direction_id>/
 *        <trip_headsign>/<trip_id>/<next_stop>/<start_time>/<vehicle_id>/<geohash_head>/
 *        <geohash_firstdeg>/<geohash_seconddeg>/<geohash_thirddeg>/<short_name>/<color>/
 * Any level may be empty. Payload: a protobuf GTFS-RT FeedMessage with one VehiclePosition.
 * Unlike HFP there is no schedule deviation, door status or "moved ~100 m" level.
 */
import { CITIES } from '../api/_cities'
import type { City } from '../api/_cities'
import { MODES, geohashCells, num } from './feed'
import type { Feed, Mode, Msg } from './feed'
import { helsinkiDate, helsinkiSecondsOfDay } from './time'

export const BROKER = 'wss://mqtt.digitransit.fi:443/'

const BY_FEED = new Map(CITIES.filter((c) => c.live === 'gtfsrt').map((c) => [c.feedId, c]))

/** Topic mode → app mode. */
const MODE_OF: Record<string, Mode> = { BUS: 'bus', TRAM: 'tram', SUBWAY: 'metro', RAIL: 'train', FERRY: 'ferry' }
const TOPIC_MODES: Record<Mode, string> = { bus: 'BUS', tram: 'TRAM', metro: 'SUBWAY', train: 'RAIL', ferry: 'FERRY' }

// ---------------------------------------------------------------- protobuf

/** The parts of a GTFS-RT VehiclePosition this app reads. */
export interface VehiclePosition {
  lat: number | null
  lng: number | null
  bearing: number | null   // degrees clockwise from north
  speed: number | null     // m/s
  timestamp: number | null // unix s of the position
  startDate: string        // trip's service day, "YYYYMMDD" ("" if absent)
  vehicleId: string
  label: string            // per feed: a side number, a destination…
}

/**
 * Calls `on(field, wireType, value, start, end)` for each field of the message in b[start, end).
 * Varints come as `value`; length-delimited and fixed-size fields as their byte range.
 * Returns false if the message is malformed.
 */
function fields(
  b: Uint8Array,
  start: number,
  end: number,
  on: (field: number, wire: number, value: number, s: number, e: number) => void,
): boolean {
  let i = start
  const varint = (): number => {
    let v = 0
    let mul = 1
    for (let k = 0; k < 10; k++) {
      if (i >= end) return NaN
      const c = b[i++]
      v += (c & 127) * mul
      if (!(c & 128)) return v
      mul *= 128
    }
    return NaN
  }
  while (i < end) {
    const key = varint()
    if (Number.isNaN(key)) return false
    const field = Math.floor(key / 8)
    const wire = key % 8
    const s = i
    if (wire === 0) {
      const v = varint()
      if (Number.isNaN(v)) return false
      on(field, wire, v, s, i)
      continue
    }
    const size = wire === 1 ? 8 : wire === 5 ? 4 : wire === 2 ? varint() : NaN
    if (Number.isNaN(size)) return false
    const vs = i
    i += size
    if (i > end) return false
    on(field, wire, 0, vs, i)
  }
  return true
}

const utf8 = new TextDecoder()

/** Decode the first entity's VehiclePosition from a FeedMessage; null if there is none or it's malformed. */
export function decodeVehiclePosition(b: Uint8Array): VehiclePosition | null {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const f32 = (s: number): number | null => num(dv.getFloat32(s, true))
  const str = (s: number, e: number): string => utf8.decode(b.subarray(s, e))
  const out: VehiclePosition = {
    lat: null, lng: null, bearing: null, speed: null, timestamp: null, startDate: '', vehicleId: '', label: '',
  }
  let found = false
  let ok = true
  // FeedMessage: 2 = entity (repeated). FeedEntity: 4 = vehicle.
  ok = fields(b, 0, b.length, (f, w, _v, s, e) => {
    if (f !== 2 || w !== 2 || found) return
    ok &&= fields(b, s, e, (f, w, _v, s, e) => {
      if (f !== 4 || w !== 2) return
      found = true
      // VehiclePosition: 1 trip, 2 position, 5 timestamp, 8 vehicle.
      ok &&= fields(b, s, e, (f, w, v, s, e) => {
        if (f === 1 && w === 2)
          // TripDescriptor: 3 start_date.
          ok &&= fields(b, s, e, (f, w, _v, s, e) => {
            if (f === 3 && w === 2) out.startDate = str(s, e)
          })
        else if (f === 2 && w === 2)
          // Position: 1 latitude, 2 longitude, 3 bearing, 5 speed (floats).
          ok &&= fields(b, s, e, (f, w, _v, s) => {
            if (w !== 5) return
            if (f === 1) out.lat = f32(s)
            else if (f === 2) out.lng = f32(s)
            else if (f === 3) out.bearing = f32(s)
            else if (f === 5) out.speed = f32(s)
          })
        else if (f === 5 && w === 0) out.timestamp = v
        else if (f === 8 && w === 2)
          // VehicleDescriptor: 1 id, 2 label.
          ok &&= fields(b, s, e, (f, w, _v, s, e) => {
            if (w !== 2) return
            if (f === 1) out.vehicleId = str(s, e)
            else if (f === 2) out.label = str(s, e)
          })
      })
    })
  }) && ok
  return ok && found ? out : null
}

// ---------------------------------------------------------------- messages

/** "20261119" → "2026-11-19"; "" if malformed. */
const isoDate = (d: string): string => (/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : '')

/**
 * The operating day of a trip that started at `start` ("HH:mm"), seen at `now`, for feeds
 * that don't send start_date. A start more than 6 h "in the future" means the trip began
 * yesterday evening (it's now after midnight).
 */
export function guessOday(start: string, now: Date): string {
  const [h, m] = start.split(':').map(Number)
  const ahead = h * 3600 + m * 60 - helsinkiSecondsOfDay(now)
  return helsinkiDate(ahead > 6 * 3600 ? new Date(now.getTime() - 86_400_000) : now)
}

/** The side number in a vehicle id: "6852_810" → "810", "80019" → "80019", else "". */
const sideNumber = (vehicleId: string): string => /(?:^|_)(\d{1,6})$/.exec(vehicleId)?.[1] ?? ''

export function parseMessage(topic: string, payload: Uint8Array): Msg | null {
  const p = topic.split('/')
  if (p[1] !== 'gtfsrt' || p[2] !== 'vp') return null
  const city = BY_FEED.get(p[3])
  const mode = MODE_OF[p[6]]
  const vehicleId = p[13]
  if (!city || !mode || !vehicleId) return null
  const vp = decodeVehiclePosition(payload)
  if (!vp || vp.lat == null || vp.lng == null) return null
  const tst = vp.timestamp != null ? new Date(vp.timestamp * 1000) : new Date()
  if (Number.isNaN(tst.getTime())) return null
  const start = /^\d{2}:\d{2}$/.test(p[12]) ? p[12] : ''
  return {
    city: city.id,
    id: `${city.id}/${vehicleId}`,
    mode,
    oper: '',
    veh: sideNumber(vehicleId),
    route: p[7],
    dir: p[8] === '1' ? '2' : '1', // GTFS 0/1 -> HFP 1/2
    headsign: p[9],
    start,
    tripId: p[10],
    nextStop: p[11],
    desi: p[18] ?? '',
    lat: vp.lat,
    lng: vp.lng,
    hdg: vp.bearing,
    spd: vp.speed,
    dl: null,
    doorsOpen: false,
    oday: isoDate(vp.startDate) || (start ? guessOday(start, new Date()) : ''),
    tst: tst.toISOString(),
  }
}

const base = (city: City) => `/gtfsrt/vp/${city.feedId}`
/** Wildcards for the 9 levels between the feed id and the vehicle id (agency_id … start_time). */
const ANY_TRIP = '+/+/+/+/+/+/+/+/+'

/** Digitransit's GTFS-RT feed (mqtt.digitransit.fi), shared by all GTFS-RT cities. */
export const gtfsrt: Feed = {
  broker: BROKER,
  parse: parseMessage,
  area(city, box, maxFilters, _onlyMoved, modes) {
    // As for HFP: per-mode filters only pay off when buses are hidden.
    const md = modes.has('bus') ? ['+'] : MODES.filter((m) => modes.has(m)).map((m) => TOPIC_MODES[m])
    if (!md.length) return []
    const out: Array<string> = []
    for (const g of geohashCells(box, maxFilters, md.length))
      for (const m of md) out.push(`${base(city)}/+/+/${m}/+/+/+/+/+/+/+/${g}/#`)
    return out
  },
  route: (city, routeId) => `${base(city)}/+/+/+/${routeId}/#`,
  vehicle: (city, m) => `${base(city)}/${ANY_TRIP}/${m.id.slice(city.id.length + 1)}/#`,
  // The side number is only part of the vehicle id ("6852_810"), which a topic filter can't
  // match: take the whole city (a few hundred vehicles) and let the app pick by Msg.veh.
  vehicleNumber: (city) => `${base(city)}/#`,
}
