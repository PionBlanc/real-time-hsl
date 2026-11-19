import { describe, expect, it } from 'vitest'
import { CITIES } from '../api/_cities'
import type { City } from '../api/_cities'
import { MODES } from './feed'
import type { Mode } from './feed'
import { decodeVehiclePosition, gtfsrt, guessOday, parseMessage } from './gtfsrt'

const hex = (s: string) => Uint8Array.from(s.match(/../g)!.map((b) => parseInt(b, 16)))
const tampere = CITIES.find((c) => c.id === 'tampere') as City

// Real messages from mqtt.digitransit.fi, captured 2026-11-19.
const TAMPERE = {
  topic: '/gtfsrt/vp/tampere///BUS/5/0/Keskustori/137_22357_17849130/3598/10:23/6852_810/61;23/48/43/84/5/1a4a8f/',
  payload: hex(
    '0a0d0a03312e30100118f6e2fad706128a010a08363835325f383130227e0a330a123133375f32323335375f3137383439313330120831303a32333a30301a08323032363131313920002a053536383532300012140dcdca754215ccadbe411d00009c432dabaaaa3d1801200028f4e2fad70630003a0433353938421f0a08363835325f383130120a4b65736b7573746f72691a07594b562d343836',
  ),
}
const FOLI_TOPIC = '/gtfsrt/vp/FOLI///BUS/220/0//00015642__1220040100/2055/09:30/221323/60;22/51/05/20/220/eaab00/'
const FOLI = hex(
  '0a0d0a03312e3010011884e3fad706125a0a013122550a310a1430303031353634325f5f31323230303430313030120830393a33303a30301a0832303236313131392a033232303000120a0d52027242159934b1412880e3fad7063a043230353542080a06323231333233',
)

const LINKKI = {
  topic:
    '/gtfsrt/vp/LINKKI///BUS/9121/1/KANGASLAMPI/M-P_koulp_talvi_2024-2025_9121_1_094000_101900_0/309822/09:40/6714_457/62;25/28/72/35/12/00662B/',
  payload: hex(
    '0a0d0a03312e3010011887e3fad70612ab010a08363731345f343537229e010a500a304d2d505f6b6f756c705f74616c76695f323032342d323032355f393132315f315f3039343030305f3130313930305f30120830393a34303a30301a08323032363131313920002a0439313231300112140d9118794215a299ce411d008099432d721c1341182220022887e3fad70630003a0633303938323242200a08363731345f343537120b4b414e4741534c414d50491a074952562d383537',
  ),
}

describe('decodeVehiclePosition', () => {
  it('reads a Tampere message', () => {
    const vp = decodeVehiclePosition(TAMPERE.payload)!
    expect(vp.lat).toBeCloseTo(61.448, 3)
    expect(vp.lng).toBeCloseTo(23.835, 3)
    expect(vp.bearing).toBe(312)
    expect(vp.speed).toBeCloseTo(0.083, 3)
    expect(vp.startDate).toBe('20261119')
    expect(vp.vehicleId).toBe('6852_810')
    expect(new Date(vp.timestamp! * 1000).toISOString()).toMatch(/^2026-11-19T/)
  })
  it('reads a message without bearing or speed', () => {
    const vp = decodeVehiclePosition(FOLI)!
    expect(vp.lat).toBeCloseTo(60.5, 1)
    expect(vp.lng).toBeCloseTo(22.2, 1)
    expect(vp.bearing).toBeNull()
    expect(vp.speed).toBeNull()
    expect(vp.vehicleId).toBe('221323')
  })
  it('rejects truncated or garbage payloads', () => {
    expect(decodeVehiclePosition(TAMPERE.payload.subarray(0, 60))).toBeNull()
    expect(decodeVehiclePosition(new TextEncoder().encode('{"VP":{}}'))).toBeNull()
    expect(decodeVehiclePosition(new Uint8Array(0))).toBeNull()
  })
})

describe('parseMessage', () => {
  it('combines topic and payload', () => {
    const m = parseMessage(TAMPERE.topic, TAMPERE.payload)!
    expect(m).toMatchObject({
      city: 'tampere',
      id: 'tampere/6852_810',
      mode: 'bus',
      veh: '810',
      route: '5',
      dir: '1',
      headsign: 'Keskustori',
      start: '10:23',
      tripId: '137_22357_17849130',
      nextStop: '3598',
      desi: '5',
      oday: '2026-11-19',
      dl: null,
    })
    expect(m.hdg).toBe(312)
    expect(m.tst).toMatch(/^2026-11-19T/)
  })
  it('reads Turku (Föli), which sends no headsign, bearing or speed', () => {
    const m = parseMessage(FOLI_TOPIC, FOLI)!
    expect(m).toMatchObject({
      city: 'turku',
      id: 'turku/221323',
      veh: null, // Föli's vehicle ids aren't side numbers
      route: '220',
      headsign: null,
      tripId: '00015642__1220040100',
      nextStop: '2055',
      desi: '220',
      hdg: null,
      spd: null,
      // Not in GTFS-RT: unknown, not "closed" or "on time".
      doorsOpen: null,
      dl: null,
      oper: null,
    })
  })
  it('reads Jyväskylä (Linkki), whose route ids differ from the line shown', () => {
    const m = parseMessage(LINKKI.topic, LINKKI.payload)!
    expect(m).toMatchObject({
      city: 'jyvaskyla',
      id: 'jyvaskyla/6714_457',
      veh: '457',
      route: '9121',
      desi: '12',
      dir: '2',
      headsign: 'KANGASLAMPI',
      tripId: 'M-P_koulp_talvi_2024-2025_9121_1_094000_101900_0',
    })
    expect(m.lat).toBeCloseTo(62.27, 2)
  })
  it('ignores feeds of cities the app does not cover', () => {
    expect(parseMessage(FOLI_TOPIC.replace('/FOLI/', '/OULU/'), FOLI)).toBeNull()
  })
  it('ignores unknown modes and other topics', () => {
    expect(parseMessage(TAMPERE.topic.replace('/BUS/', '/CABLE_CAR/'), TAMPERE.payload)).toBeNull()
    expect(parseMessage('/hfp/v2/journey/ongoing/vp/bus/0012/01234/', TAMPERE.payload)).toBeNull()
  })
})

describe('guessOday', () => {
  it('is today for a trip that started earlier today', () => {
    expect(guessOday('10:00', new Date('2026-11-19T10:00:00Z'))).toBe('2026-11-19')
  })
  it('is yesterday for a late-evening trip seen after midnight', () => {
    // 00:30 local on the 20th; the trip started 23:50 on the 19th.
    expect(guessOday('23:50', new Date('2026-11-19T22:30:00Z'))).toBe('2026-11-19')
  })
})

describe('topic filters', () => {
  const all = new Set<Mode>(MODES)
  it('covers an area with geohash cells', () => {
    const f = gtfsrt.area(tampere, { south: 61.481, north: 61.489, west: 23.751, east: 23.769 }, 100, false, all)
    expect(f).toEqual([
      '/gtfsrt/vp/tampere/+/+/+/+/+/+/+/+/+/+/61;23/47/85/#',
      '/gtfsrt/vp/tampere/+/+/+/+/+/+/+/+/+/+/61;23/47/86/#',
    ])
  })
  it('matches the vehicle-id level for a single vehicle', () => {
    const m = parseMessage(TAMPERE.topic, TAMPERE.payload)!
    const f = gtfsrt.vehicle(tampere, m)
    // Same number of levels as the topic, up to and including the vehicle id.
    const levels = f.split('/')
    expect(levels[13]).toBe('6852_810')
    expect(TAMPERE.topic.split('/')[13]).toBe('6852_810')
  })
  it('filters by mode only when buses are hidden', () => {
    const f = gtfsrt.area(tampere, { south: 61.481, north: 61.482, west: 23.751, east: 23.752 }, 100, false, new Set<Mode>(['tram']))
    expect(f).toEqual(['/gtfsrt/vp/tampere/+/+/TRAM/+/+/+/+/+/+/+/61;23/47/85/#'])
    expect(gtfsrt.area(tampere, { south: 61, north: 61, west: 23, east: 23 }, 100, false, new Set())).toEqual([])
  })
  it('matches a route', () => {
    expect(gtfsrt.route(tampere, '5')).toBe('/gtfsrt/vp/tampere/+/+/+/5/#')
  })
})
