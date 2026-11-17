import { describe, expect, it } from 'vitest'
import { areaFilters, clock, delayText, parseMessage, routeFilter, topicModes, tripStartSeconds, vehicleFilter } from './hfp'
import { decodePolyline } from './api'

const enc = new TextEncoder()

describe('areaFilters', () => {
  it('matches the documented bounding-box example', () => {
    // Docs: lat [60.18, 60.19), lng [24.95, 24.97) => 60;24/19/85 and 60;24/19/86
    const f = areaFilters({ south: 60.181, north: 60.189, west: 24.951, east: 24.969 }, 100)
    expect(f).toEqual([
      '/hfp/v2/journey/ongoing/vp/+/+/+/+/+/+/+/+/+/60;24/19/85/#',
      '/hfp/v2/journey/ongoing/vp/+/+/+/+/+/+/+/+/+/60;24/19/86/#',
    ])
  })
  it('coarsens cells when the area is large', () => {
    const f = areaFilters({ south: 60.1, north: 60.3, west: 24.8, east: 25.1 }, 40)
    expect(f.length).toBeLessThanOrEqual(40)
    expect(f[0]).toMatch(/\/\+\/60;24\/\d\d\/#$/) // 0.1° cells
  })
  it('expands geohash levels', () => {
    const f = areaFilters({ south: 60.181, north: 60.182, west: 24.951, east: 24.952 }, 100, [0, 3])
    expect(f).toEqual([
      '/hfp/v2/journey/ongoing/vp/+/+/+/+/+/+/+/+/0/60;24/19/85/#',
      '/hfp/v2/journey/ongoing/vp/+/+/+/+/+/+/+/+/3/60;24/19/85/#',
    ])
  })
  it('handles cells crossing an integer degree', () => {
    const f = areaFilters({ south: 60.195, north: 60.205, west: 24.995, east: 25.005 }, 100)
    expect(f).toContain('/hfp/v2/journey/ongoing/vp/+/+/+/+/+/+/+/+/+/60;24/19/99/#')
    expect(f).toContain('/hfp/v2/journey/ongoing/vp/+/+/+/+/+/+/+/+/+/60;25/20/00/#')
  })
})

describe('topic filters line up with real topics', () => {
  const topic = '/hfp/v2/journey/ongoing/vp/bus/0022/01216/2551/1/Aviapolis/16:28/1291404/4/60;24/19/85/34'
  const match = (filter: string, t: string) => {
    const f = filter.split('/')
    const p = t.split('/')
    for (let i = 0; i < f.length; i++) {
      if (f[i] === '#') return true
      if (f[i] !== '+' && f[i] !== p[i]) return false
    }
    return f.length === p.length
  }
  it('area/route/vehicle filters match', () => {
    expect(match('/hfp/v2/journey/ongoing/vp/+/+/+/+/+/+/+/+/+/60;24/19/85/#', topic)).toBe(true)
    expect(match('/hfp/v2/journey/ongoing/vp/+/+/+/+/+/+/+/+/4/60;24/19/85/#', topic)).toBe(true)
    expect(match('/hfp/v2/journey/ongoing/vp/+/+/+/+/+/+/+/+/3/60;24/19/85/#', topic)).toBe(false)
    expect(match(routeFilter('2551'), topic)).toBe(true)
    expect(match(routeFilter('2550'), topic)).toBe(false)
    expect(match(vehicleFilter('0022', '01216'), topic)).toBe(true)
  })
  it('parses a message', () => {
    const payload = enc.encode(
      JSON.stringify({ VP: { desi: '551', dir: '1', oper: 22, veh: 1216, tst: '2026-11-17T14:40:00.000Z', spd: 8.2, hdg: 90, lat: 60.18531, long: 24.95348, dl: -125, drst: 0, oday: '2026-11-17', start: '16:28', route: '2551' } }),
    )
    const m = parseMessage(topic, payload)!
    expect(m).toMatchObject({ id: '0022/01216', mode: 'bus', route: '2551', dir: '1', nextStop: '1291404', desi: '551', headsign: 'Aviapolis', lat: 60.18531 })
    expect(parseMessage(topic, enc.encode('{"VP":{"lat":null,"long":null}}'))).toBeNull()
    expect(parseMessage(topic.replace('/bus/', '/ubus/'), payload)!.mode).toBe('bus')
  })
  it('rejects or cleans malformed messages', () => {
    const vp = { tst: '2026-11-17T14:40:00.000Z', lat: 60.18, long: 24.95, oday: '2026-11-17' }
    const parse = (o: object) => parseMessage(topic, enc.encode(JSON.stringify({ VP: { ...vp, ...o } })))
    expect(parse({})).not.toBeNull()
    // Would make Intl date formatting throw / put NaN into Leaflet:
    expect(parse({ tst: undefined })).toBeNull()
    expect(parse({ tst: 'yesterday' })).toBeNull()
    expect(parse({ lat: '60.18' })).toBeNull()
    expect(parse({ long: 1e999 })).toBeNull() // JSON can't say Infinity; 1e999 parses to it
    const m = parse({ spd: 'fast', oday: '17.11.2026' })!
    expect(m.spd).toBeNull()
    expect(m.oday).toBe('')
    const t = parseMessage(topic.replace('/16:28/', '/4pm/'), enc.encode(JSON.stringify({ VP: vp })))!
    expect(t.start).toBe('')
  })
})

describe('time helpers', () => {
  it('trip start handles after-midnight trips', () => {
    expect(tripStartSeconds('16:28', '2026-11-17', '2026-11-17T14:40:00Z')).toBe(16 * 3600 + 28 * 60)
    // 00:40 Helsinki on the 18th, still operating day 17th
    expect(tripStartSeconds('00:35', '2026-11-17', '2026-11-17T22:40:00Z')).toBe(24 * 3600 + 35 * 60)
    // 23:50 trip that is now past midnight: no shift
    expect(tripStartSeconds('23:50', '2026-11-17', '2026-11-17T22:10:00Z')).toBe(23 * 3600 + 50 * 60)
  })
  it('clock and delay', () => {
    expect(clock(25 * 3600 + 5 * 60)).toBe('01:05')
    expect(delayText(-125).text).toBe('2 min late')
    expect(delayText(70).text).toBe('1 min early')
    expect(delayText(20).text).toBe('On time')
  })
  it('decodes polylines', () => {
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual([
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ])
  })
})

describe('topicModes', () => {
  it('subscribes to all modes while buses are shown', () => {
    expect(topicModes(new Set(['bus', 'tram']))).toBeNull()
  })
  it('lists topic modes when buses are hidden', () => {
    expect(topicModes(new Set(['tram', 'metro']))).toEqual(['tram', 'metro'])
    expect(topicModes(new Set())).toEqual([])
  })
  it('filters area topics by mode and keeps under the cap', () => {
    const box = { south: 60.181, north: 60.182, west: 24.951, east: 24.952 }
    expect(areaFilters(box, 100, null, ['tram', 'metro'])).toEqual([
      '/hfp/v2/journey/ongoing/vp/tram/+/+/+/+/+/+/+/+/60;24/19/85/#',
      '/hfp/v2/journey/ongoing/vp/metro/+/+/+/+/+/+/+/+/60;24/19/85/#',
    ])
    expect(areaFilters(box, 100, null, [])).toEqual([])
    const wide = { south: 60.1, north: 60.3, west: 24.8, east: 25.1 }
    expect(areaFilters(wide, 160, [0, 1, 2, 3], ['tram', 'metro', 'train', 'ferry']).length).toBeLessThanOrEqual(160)
  })
})
