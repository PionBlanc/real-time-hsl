// The cities (transit regions) the app covers. Shared by the app (src/) and the /api functions,
// so it must stay plain data: no DOM, no Node APIs. Files starting with "_" are not routes.
//
// Adding a city: add an entry here (its feed must be on mqtt.digitransit.fi, see
// https://digitransit.fi/en/developers/apis/5-realtime-api/vehicle-positions/digitransit-mqtt/),
// check its id shapes against real data, and add it to the tests in src/cities.test.ts.

export type CityId = 'hsl' | 'tampere' | 'turku' | 'jyvaskyla'

/** A lat/lng box (WGS84 degrees). */
export interface Area {
  south: number
  west: number
  north: number
  east: number
}

export interface City {
  id: CityId
  /** Shown to users, e.g. on the zoomed-out city markers. */
  name: string
  /**
   * GTFS feed id in Digitransit: the prefix of its ids ("HSL:1130446", "tampere:3598") and,
   * for GTFS-RT cities, the feed id in mqtt.digitransit.fi topics.
   */
  feedId: string
  /** Digitransit routing instance serving this feed (https://api.digitransit.fi/routing/v2/<router>/gtfs/v1). */
  router: 'hsl' | 'waltti'
  /**
   * Live vehicle positions: 'hfp' = HSL's own feed (mqtt.hsl.fi), 'gtfsrt' = Digitransit's
   * GTFS-RT feed (mqtt.digitransit.fi). Decides how vehicles are matched to trips, too.
   */
  live: 'hfp' | 'gtfsrt'
  /** Service area, with a margin. Live data, stops and map tiles are limited to it. */
  area: Area
  /** Where the zoomed-out city marker sits and where tapping it goes. */
  center: [number, number]
  /**
   * Shapes of this feed's ids (without the feed prefix) and line names (as shown to
   * passengers, upper case). The API rejects anything else, which also keeps the
   * uncacheable keyspace small.
   */
  ids: { stop: RegExp; route: RegExp; trip: RegExp; line: RegExp }
}

export const CITIES: ReadonlyArray<City> = [
  {
    id: 'hsl',
    name: 'Helsinki',
    feedId: 'HSL',
    router: 'hsl',
    live: 'hfp',
    area: { south: 59.5, west: 23.0, north: 61.0, east: 27.0 },
    center: [60.1699, 24.9384],
    ids: {
      // All HSL stop ids are 7 digits (checked 2026-11, 8339 stops).
      stop: /^\d{7}$/,
      // 2–4 digits plus up to 3 more (2551, 1001H, 31M1, 3002U, 4611BK…; checked 2026-11).
      route: /^\d{2,4}[0-9A-Z]{0,3}$/,
      trip: /^[0-9A-Za-z_]{1,64}$/,
      // 551, 550B, 15, 9N, M1, I, U1A, 200AB… (checked 2026-11), with a little slack.
      line: /^(?:[A-Z]\d{0,2}[A-Z]?|\d{1,4}[A-Z]{0,2})$/,
    },
  },
  {
    id: 'tampere',
    name: 'Tampere',
    feedId: 'tampere',
    router: 'waltti',
    live: 'gtfsrt',
    // Nysse region (Tampere, Nokia, Ylöjärvi, Kangasala, Lempäälä, Pirkkala, Orivesi, Vesilahti).
    area: { south: 61.2, west: 23.2, north: 61.95, east: 24.5 },
    center: [61.4978, 23.761],
    ids: {
      // Live data 2026-11: stops "3598", routes "5", trips "137_22357_17849130", lines 1, 29B, 70X.
      stop: /^[0-9A-Za-z_]{1,16}$/,
      route: /^[0-9A-Za-z_]{1,16}$/,
      trip: /^[0-9A-Za-z_.-]{1,64}$/,
      line: /^\d{1,3}[A-Z]{0,2}$/,
    },
  },
  {
    id: 'turku',
    name: 'Turku',
    feedId: 'FOLI',
    router: 'waltti',
    live: 'gtfsrt',
    // Föli region (Turku, Kaarina, Raisio, Naantali, Lieto, Rusko).
    area: { south: 60.25, west: 21.6, north: 60.7, east: 22.7 },
    center: [60.4518, 22.2666],
    ids: {
      // Live data 2026-11: stops "178", routes "220", trips "00015642__1220040100".
      // Lines 1, 3A, N11. Föli's topics have no headsign; the trip lookup supplies it.
      stop: /^[0-9A-Za-z_]{1,16}$/,
      route: /^[0-9A-Za-z_]{1,16}$/,
      trip: /^[0-9A-Za-z_.-]{1,64}$/,
      line: /^[A-Z]?\d{1,3}[A-Z]?$/,
    },
  },
  {
    id: 'jyvaskyla',
    name: 'Jyväskylä',
    feedId: 'LINKKI',
    router: 'waltti',
    live: 'gtfsrt',
    // Linkki region (Jyväskylä, Muurame, Laukaa, Korpilahti, Tikkakoski).
    area: { south: 61.95, west: 25.2, north: 62.6, east: 26.2 },
    center: [62.2415, 25.7482],
    ids: {
      // Live data 2026-11: stops "309822", routes "9121" (shown as "12"),
      // trips "M-P_koulp_talvi_2024-2025_9121_1_094000_101900_0", lines 3, S5, 38K, 140.
      stop: /^[0-9A-Za-z_]{1,16}$/,
      route: /^[0-9A-Za-z_]{1,16}$/,
      trip: /^[0-9A-Za-z_.-]{1,80}$/,
      line: /^[A-Z]?\d{1,3}[A-Z]?$/,
    },
  },
]

export const DEFAULT_CITY: City = CITIES[0]

export function cityById(id: string | null | undefined): City | null {
  return CITIES.find((c) => c.id === id) ?? null
}

export const inArea = (a: Area, lat: number, lng: number): boolean =>
  lat >= a.south && lat <= a.north && lng >= a.west && lng <= a.east

export const overlaps = (a: Area, b: Area): boolean =>
  a.south <= b.north && a.north >= b.south && a.west <= b.east && a.east >= b.west

/** The overlap of two boxes, or null if they don't overlap. */
export function intersect(a: Area, b: Area): Area | null {
  if (!overlaps(a, b)) return null
  return {
    south: Math.max(a.south, b.south),
    west: Math.max(a.west, b.west),
    north: Math.min(a.north, b.north),
    east: Math.min(a.east, b.east),
  }
}

/** The city whose service area contains this point, if any. */
export function cityAt(lat: number, lng: number): City | null {
  return CITIES.find((c) => inArea(c.area, lat, lng)) ?? null
}

/** Strip a city's feed prefix from a GTFS id ("tampere:3598" → "3598"); null if it's another feed's id. */
export function localId(city: City, gtfsId: string): string | null {
  const p = `${city.feedId}:`
  return gtfsId.startsWith(p) ? gtfsId.slice(p.length) : null
}
