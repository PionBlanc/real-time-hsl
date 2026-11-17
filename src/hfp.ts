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

export interface VP {
  desi?: string
  dir?: string
  oper: number
  veh: number
  tst: string
  spd: number | null
  hdg: number | null
  lat: number | null
  long: number | null
  dl: number | null
  drst: number | null
  oday: string | null
  start: string | null
  route: string | null
}

export interface Msg {
  id: string // "<topicOper>/<topicVeh>", stable vehicle identity
  mode: Mode
  oper: string // zero-padded, as in topic
  veh: string
  route: string
  dir: string
  headsign: string
  start: string
  nextStop: string // stop id without "HSL:" prefix, or "EOL"/""
  desi: string
  lat: number
  lng: number
  hdg: number | null
  spd: number | null
  dl: number | null
  doorsOpen: boolean
  oday: string
  tst: string
}

const dec = new TextDecoder()

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
  if (!vp || vp.lat == null || vp.long == null) return null
  return {
    id: `${p[7]}/${p[8]}`,
    mode,
    oper: p[7],
    veh: p[8],
    route: p[9] || vp.route || '',
    dir: p[10] || vp.dir || '1',
    headsign: p[11] || '',
    start: p[12] || vp.start || '',
    nextStop: p[13] || '',
    desi: vp.desi || '',
    lat: vp.lat,
    lng: vp.long,
    hdg: vp.hdg,
    spd: vp.spd,
    dl: vp.dl,
    doorsOpen: vp.drst === 1,
    oday: vp.oday || '',
    tst: vp.tst,
  }
}

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
 */
export function areaFilters(
  box: Box,
  maxFilters: number,
  levels: Array<number> | null = null,
): Array<string> {
  const lv = levels ? levels.map(String) : ['+']
  for (const p of [2, 1, 0]) {
    const f = 10 ** p
    const la0 = Math.floor(box.south * f)
    const la1 = Math.floor(box.north * f)
    const lo0 = Math.floor(box.west * f)
    const lo1 = Math.floor(box.east * f)
    const cells = (la1 - la0 + 1) * (lo1 - lo0 + 1)
    if (cells * lv.length > maxFilters && p > 0) continue
    const out: Array<string> = []
    for (let la = la0; la <= la1; la++)
      for (let lo = lo0; lo <= lo1; lo++)
        for (const l of lv)
          out.push(`${BASE}/+/+/+/+/+/+/+/+/${l}/${geohash(la, lo, p)}/#`)
    return out
  }
  return []
}

/** All vehicles on a route, anywhere (route id as in HFP/GTFS without "HSL:", e.g. "2551"). */
export const routeFilter = (routeId: string): string => `${BASE}/+/+/+/${routeId}/#`

/** One specific vehicle (oper/veh zero-padded as in the topic). */
export const vehicleFilter = (oper: string, veh: string): string =>
  `${BASE}/+/${oper}/${veh}/#`

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
