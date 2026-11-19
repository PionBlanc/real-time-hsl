// Tests for the city config and the city-aware /api endpoints.
// (Kept in src/: every file in /api would become a Vercel route.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CITIES, cityAt, localId } from '../api/_cities'
import type { City } from '../api/_cities'
import { cityParam } from '../api/_digitransit'
import trip from '../api/trip'
import stop from '../api/stop'
import stops from '../api/stops'
import routes from '../api/routes'

const qs = (s: string) => new URLSearchParams(s)

describe('cities', () => {
  it('have unique ids and feeds', () => {
    expect(new Set(CITIES.map((c) => c.id)).size).toBe(CITIES.length)
    expect(new Set(CITIES.map((c) => c.feedId)).size).toBe(CITIES.length)
  })
  it('each contain their own centre', () => {
    for (const c of CITIES) expect(cityAt(...c.center)).toBe(c)
  })
  it('finds the city at a point', () => {
    expect(cityAt(60.17, 24.94)?.id).toBe('hsl')
    expect(cityAt(61.5, 23.76)?.id).toBe('tampere')
    expect(cityAt(60.45, 22.27)?.id).toBe('turku')
    expect(cityAt(62.24, 25.75)?.id).toBe('jyvaskyla')
    expect(cityAt(65.01, 25.47)).toBeNull() // Oulu: not in the app yet
  })
  it('picks the smallest area where areas overlap', () => {
    const town = { ...CITIES[0], id: 'town', area: { south: 60.6, west: 24.8, north: 60.7, east: 24.9 } } as unknown as City
    ;(CITIES as Array<City>).push(town)
    try {
      expect(cityAt(60.65, 24.85)).toBe(town) // inside both: the town
      expect(cityAt(60.17, 24.94)?.id).toBe('hsl') // only in HSL's box
    } finally {
      ;(CITIES as Array<City>).pop()
    }
  })
  it('strips only its own feed prefix', () => {
    const [hsl, tampere] = CITIES
    expect(localId(hsl, 'HSL:1130446')).toBe('1130446')
    expect(localId(tampere, 'tampere:3598')).toBe('3598')
    expect(localId(tampere, 'LINKKI:3598')).toBeNull()
  })
})

describe('cityParam', () => {
  it('requires a known city', () => {
    expect(cityParam(qs('city=hsl&id=1'))?.id).toBe('hsl')
    expect(cityParam(qs('city=tampere&id=1'))?.id).toBe('tampere')
    expect(cityParam(qs('id=1'))).toBeNull()
    expect(cityParam(qs('city=oulu'))).toBeNull()
  })
})

/** Replace Digitransit; returns the mock to inspect the GraphQL calls. */
function upstream(data: unknown) {
  const f = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ data }))
  vi.stubGlobal('fetch', f)
  return f
}
const body = (f: ReturnType<typeof upstream>) => JSON.parse(String(f.mock.calls[0][1]?.body))
const get = (h: (r: Request) => Promise<Response>, q: string) => h(new Request(`https://example.test/api/x?${q}`))

beforeEach(() => {
  vi.stubEnv('DIGITRANSIT_API_KEY', 'test-key')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const TRIP = {
  tripHeadsign: 'Keskustori',
  route: { shortName: '5', mode: 'BUS' },
  pattern: { patternGeometry: { points: '' } },
  stoptimes: [{ scheduledDeparture: 37380, stop: { gtfsId: 'tampere:3598', name: 'Hervanta', code: '3598', lat: 61.45, lon: 23.85 } }],
}

describe('/api/trip', () => {
  it('looks up GTFS-RT vehicles by trip id on their router', async () => {
    const f = upstream({ trip: TRIP })
    const res = await get(trip, 'city=tampere&trip=137_22357_17849130')
    expect(res.status).toBe(200)
    expect(f.mock.calls[0][0]).toBe('https://api.digitransit.fi/routing/v2/waltti/gtfs/v1')
    expect(body(f).variables).toEqual({ id: 'tampere:137_22357_17849130' })
    const d = await res.json()
    expect(d.s[0][0]).toBe('3598') // stop ids without the feed prefix
  })
  it('still matches HSL vehicles by route, direction, day and start', async () => {
    const f = upstream({ trip: null })
    const date = new Date().toISOString().slice(0, 10)
    const res = await get(trip, `city=hsl&route=2551&dir=1&date=${date}&time=61200`)
    expect(res.status).toBe(404)
    expect(f.mock.calls[0][0]).toBe('https://api.digitransit.fi/routing/v2/hsl/gtfs/v1')
    expect(body(f).variables).toMatchObject({ r: 'HSL:2551', d: 0, t: 61200 })
  })
  it('rejects mixed-up lookups without calling upstream', async () => {
    const f = upstream({})
    const date = new Date().toISOString().slice(0, 10)
    for (const q of [
      'city=tampere&trip=a/b',
      'city=tampere&trip=1&route=5', // both kinds at once
      'route=2551&dir=1&date=' + date + '&time=60', // no city
    ])
      expect((await get(trip, q)).status, q).toBe(400)
    expect(f).not.toHaveBeenCalled()
  })
})

describe('/api/stop', () => {
  it('serves a Tampere stop with trip ids for matching live vehicles', async () => {
    const f = upstream({
      stop: {
        name: 'Hervanta', code: '3598', platformCode: null, lat: 61.45, lon: 23.85, vehicleMode: 'BUS',
        stoptimesWithoutPatterns: [{
          serviceDay: 1795046400, scheduledDeparture: 37380, realtimeDeparture: 37440, realtime: true,
          realtimeState: 'UPDATED', headsign: 'Keskustori',
          trip: { gtfsId: 'tampere:137_22357_17849130', directionId: '0', route: { gtfsId: 'tampere:5', shortName: '5', mode: 'BUS' }, departureStoptime: { scheduledDeparture: 37380 } },
        }],
      },
    })
    const res = await get(stop, 'city=tampere&id=3598')
    expect(res.status).toBe(200)
    expect(body(f).variables.id).toBe('tampere:3598')
    const row = (await res.json()).d[0]
    expect(row[8]).toBe('5')
    expect(row[11]).toBe('137_22357_17849130')
  })
  it('checks ids per city', async () => {
    upstream({ stop: null })
    expect((await get(stop, 'city=hsl&id=1130446')).status).toBe(404)
    expect((await get(stop, 'city=hsl&id=3598')).status).toBe(400) // not an HSL stop id
    expect((await get(stop, 'id=1130446')).status).toBe(400) // no city
    expect((await get(stop, 'city=tampere&id=a:b')).status).toBe(400)
  })
})

describe('/api/stops', () => {
  it('only serves cells in the city, and only its stops', async () => {
    upstream({
      stopsByBbox: [
        { gtfsId: 'tampere:3598', name: 'Hervanta', code: '3598', lat: 61.45, lon: 23.85, vehicleMode: 'BUS' },
        { gtfsId: 'LINKKI:1', name: 'Elsewhere', code: null, lat: 61.45, lon: 23.85, vehicleMode: 'BUS' },
      ],
    })
    // 61.45 / 0.02 = 3072, 23.85 / 0.04 = 596
    const res = await get(stops, 'city=tampere&la=3072&lo=596')
    expect(await res.json()).toEqual([['3598', 'Hervanta', '3598', 61.45, 23.85, 'BUS']])
    expect((await get(stops, 'city=hsl&la=3072&lo=596')).status).toBe(400) // Tampere cell, asked as HSL
    expect((await get(stops, 'city=hsl&la=3008&lo=623')).status).toBe(200) // Helsinki
  })
})

describe('/api/routes', () => {
  it("rejects names that can't be the city's lines", async () => {
    const f = upstream({ routes: [] })
    expect((await get(routes, 'city=hsl&q=M1')).status).toBe(200)
    expect((await get(routes, 'city=tampere&q=M1')).status).toBe(400)
    expect((await get(routes, 'city=jyvaskyla&q=38K')).status).toBe(200)
    expect(f).toHaveBeenCalledTimes(2)
  })
  it("returns only the city's routes", async () => {
    const f = upstream({
      routes: [
        { gtfsId: 'tampere:5', shortName: '5', mode: 'BUS' },
        { gtfsId: 'LINKKI:5', shortName: '5', mode: 'BUS' },
      ],
    })
    const res = await get(routes, 'city=tampere&q=5')
    expect(await res.json()).toEqual([{ id: '5', n: '5', m: 'BUS' }])
    expect(body(f).variables).toEqual({ f: ['tampere'], n: '5' })
  })
})
