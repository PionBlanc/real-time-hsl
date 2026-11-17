/**
 * HSL High-Frequency Positioning (HFP v2) helpers.
 * Docs: https://digitransit.fi/en/developers/apis/5-realtime-api/vehicle-positions/high-frequency-positioning/
 *
 * Topic: /hfp/v2/journey/ongoing/vp/<mode>/<oper>/<veh>/<route>/<dir>/<headsign>/<start>/<next_stop>/<geohash_level>/<geohash...>
 */

// VITE_BROKER is only for local testing against a fake broker.
export const BROKER: string = import.meta.env.VITE_BROKER || 'wss://mqtt.hsl.fi:443/'
const BASE = '/hfp/v2/journey/ongoing/vp'

export type Mode = 'bus' | 'tram' | 'metro' | 'train' | 'ferry'
export const MODES: Array<Mode> = ['bus', 'tram', 'metro', 'train', 'ferry']

export const COLORS: Record<Mode, string> = {
  bus: '#007AC9',
  tram: '#00985F',
  metro: '#FF6319',
  train: '#8C4799',
  ferry: '#00B9E4',
}

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

/** One parsed vehicle-position update, combining topic levels and the VP payload. */
export interface Msg {
  id: string         // "<topicOper>/<topicVeh>", stable vehicle identity
  mode: Mode         // transport mode, normalised (ubus/robot → bus)
  oper: string       // operator id, zero-padded, as in topic
  veh: string        // vehicle number, zero-padded, as in topic
  route: string      // route id, e.g. "2550"
  dir: string        // direction: "1" or "2"
  headsign: string   // destination name shown on the vehicle
  start: string      // scheduled trip start, local "HH:mm"
  nextStop: string   // stop id without "HSL:" prefix, or "EOL"/""
  desi: string       // route number shown to passengers, e.g. "550"
  lat: number        // latitude, WGS84
  lng: number        // longitude, WGS84
  hdg: number | null // heading, degrees clockwise from north
  spd: number | null // speed, m/s
  dl: number | null  // schedule deviation, seconds: negative = late, positive = early
  doorsOpen: boolean // from drst
  oday: string       // operating day YYYY-MM-DD (see VP.oday)
  tst: string        // timestamp of this position, UTC ISO 8601
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
    id: `${p[7]}/${p[8]}`,
    mode,
    oper: p[7],
    veh: p[8],
    route: p[9] || vp.route || '',
    dir: p[10] || vp.dir || '1',
    headsign: p[11] || '',
    // '' (= unknown, no route lookup) unless well-formed.
    start: /^\d{2}:\d{2}$/.test(start) ? start : '',
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

/** A finite number, or null for anything else (missing, null, a string…). */
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** Geohash topic levels for the cell containing (la, lo), both already scaled by 10^p and floored. */
function geohash(la: number, lo: number, p: number): string {
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

export interface Box {
  south: number
  west: number
  north: number
  east: number
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
  for (const p of [2, 1, 0]) {
    const f = 10 ** p
    const la0 = Math.floor(box.south * f)
    const la1 = Math.floor(box.north * f)
    const lo0 = Math.floor(box.west * f)
    const lo1 = Math.floor(box.east * f)
    const cells = (la1 - la0 + 1) * (lo1 - lo0 + 1)
    if (cells * lv.length * md.length > maxFilters && p > 0) continue
    const out: Array<string> = []
    for (let la = la0; la <= la1; la++)
      for (let lo = lo0; lo <= lo1; lo++)
        for (const l of lv)
          for (const m of md) out.push(`${BASE}/${m}/+/+/+/+/+/+/+/${l}/${geohash(la, lo, p)}/#`)
    return out
  }
  return []
}

/** All vehicles on a route, anywhere (route id as in HFP/GTFS without "HSL:", e.g. "2551"). */
export const routeFilter = (routeId: string): string => `${BASE}/+/+/+/${routeId}/#`

/** One specific vehicle (oper/veh zero-padded as in the topic). */
export const vehicleFilter = (oper: string, veh: string): string =>
  `${BASE}/+/${oper}/${veh}/#`

/** Vehicles with this side number (kylkinumero) at any operator. */
export const vehicleNumberFilter = (n: number): string =>
  `${BASE}/+/+/${String(n).padStart(5, '0')}/#`

// ---------- time helpers (Helsinki local time) ----------

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Helsinki',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Helsinki',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

export function helsinkiDate(d: Date): string {
  return dateFmt.format(d) // YYYY-MM-DD
}

function helsinkiSecondsOfDay(d: Date): number {
  const [h, m, s] = timeFmt.format(d).split(':').map(Number)
  return h * 3600 + m * 60 + s
}

/**
 * Trip start in seconds since the operating day's midnight (GTFS style, may exceed 24 h).
 * HFP gives start as 24 h "HH:mm"; a trip starting after midnight still belongs to
 * the previous operating day, so it needs +24 h.
 */
export function tripStartSeconds(start: string, oday: string, tst: string): number {
  const [h, m] = start.split(':').map(Number)
  let t = h * 3600 + m * 60
  const localDate = helsinkiDate(new Date(tst))
  if (localDate > oday && h < 6) t += 86400
  return t
}

/** Seconds since the operating day's midnight right now. */
export function nowServiceSeconds(oday: string, now = new Date()): number {
  const s = helsinkiSecondsOfDay(now)
  return helsinkiDate(now) > oday ? s + 86400 : s
}

export function clock(sec: number): string {
  const s = ((Math.round(sec / 60) * 60) % 86400 + 86400) % 86400
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** HFP dl: negative = behind schedule (late), positive = ahead. */
export function delayText(dl: number | null): { text: string; cls: string } {
  if (dl == null) return { text: '', cls: '' }
  const min = Math.round(Math.abs(dl) / 60)
  if (min === 0) return { text: 'On time', cls: 'ok' }
  return dl < 0
    ? { text: `${min} min late`, cls: 'late' }
    : { text: `${min} min early`, cls: 'early' }
}
