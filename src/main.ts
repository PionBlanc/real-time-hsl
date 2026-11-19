import 'leaflet/dist/leaflet.css'
import './styles.css'
import L from 'leaflet'
import { CITIES, DEFAULT_CITY, cityAt, cityById, inArea, intersect } from '../api/_cities'
import type { City } from '../api/_cities'
import type { MqttStatus } from './mqtt'
import { COLORS, MODES } from './feed'
import type { Feed, Mode, Msg } from './feed'
import { Live, feedOf } from './live'
import { clock, delayText, helsinkiDate, nowServiceSeconds, tripStartSeconds } from './time'
import { Vehicles } from './vehicles'
import { TripLine, escapeHtml } from './trip-line'
import {
  MissingKeyError,
  STOP_PAGE,
  canFetchTrip,
  departureKey,
  fetchRoutes,
  fetchStopBoard,
  fetchTrip,
  tripKey,
} from './api'
import type { Departure, StopBoard, StopRef, Trip } from './api'
import { StopsLayer, stopKey } from './stops'
import { CityMarkers } from './city-markers'

declare const __HAS_KEY__: boolean

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

/** Background colour class for a mode (see .m-* in styles.css). Classes, not style="", for the CSP. */
const modeClass = (m: Mode | null): string => `m-${m ?? 'none'}`

const store = {
  get<T>(k: string): T | null {
    try {
      return JSON.parse(localStorage.getItem(k) ?? 'null')
    } catch {
      return null
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v))
    } catch {
      /* private mode etc. */
    }
  },
  remove(k: string) {
    try {
      localStorage.removeItem(k)
    } catch {
      /* private mode etc. */
    }
  },
}

// ---------------------------------------------------------------- map

const mapEl = $('map')
/**
 * Locations are only stored to 3 decimals (~100 m): plenty to open the map in the right
 * place, without keeping someone's exact home position on the device. (The saved view
 * counts too: while following you, the map centre is your GPS position.)
 */
const coarse = (n: number): number => Math.round(n * 1000) / 1000
const lastGps = store.get<{ lat: number; lng: number }>('gps')
const lastView = store.get<{ lat: number; lng: number; z: number }>('view')
// Re-save values stored precisely by older versions.
if (lastGps) store.set('gps', { lat: coarse(lastGps.lat), lng: coarse(lastGps.lng) })
if (lastView) store.set('view', { lat: coarse(lastView.lat), lng: coarse(lastView.lng), z: lastView.z })
/** A ?city=tampere link opens that city, unless you're already in it. */
const linkCity = cityById(new URL(location.href).searchParams.get('city'))
let start: [number, number, number] = lastGps
  ? [lastGps.lat, lastGps.lng, 15]
  : lastView
    ? [lastView.lat, lastView.lng, lastView.z]
    : [...DEFAULT_CITY.center, 13]
const openedLinkCity = !!linkCity && !inArea(linkCity.area, start[0], start[1])
if (openedLinkCity) start = [...linkCity.center, 13]

/** Below this zoom the map is an overview of the cities (tiles cover all of Finland; see api/tile.ts). */
const MAP_MIN_ZOOM = 5

/**
 * A first visit with nothing to go on (no saved position, no link to a city, stop or line)
 * opens on all the cities, so it's clear at once that the app covers several. After that
 * the saved position or view opens in the right city.
 */
const linkParams = new URL(location.href).searchParams
const firstVisit = !lastGps && !lastView && !linkCity && !linkParams.has('stop') && !linkParams.has('line')

const map = L.map(mapEl, { zoomControl: false, minZoom: MAP_MIN_ZOOM, maxZoom: 18 })
if (firstVisit) {
  // Keep the city markers clear of the search bar and type chips (top) and the locate button.
  map.fitBounds(L.latLngBounds(CITIES.map((c) => c.center)), {
    paddingTopLeft: [50, 150],
    paddingBottomRight: [50, 100],
    maxZoom: 8,
  })
} else {
  map.setView([start[0], start[1]], start[2])
}
map.attributionControl.setPrefix(false)
// Required by the Digitransit terms (CC BY 4.0): credit Digitransit plus the year. See docs/API-TERMS.md.
map.attributionControl.addAttribution(
  `Data © <a href="https://digitransit.fi/en/developers/apis/7-terms-of-use/">Digitransit</a> ${new Date().getFullYear()}`,
)

const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } })
  .connection
const lowData = !!conn?.saveData || /2g/.test(conn?.effectiveType ?? '')
// Plain "2x", not "@2x": Vercel percent-encodes "@", which the API guard rejects.
const retina = devicePixelRatio >= 1.5 && !lowData ? '2x' : ''

if (__HAS_KEY__) {
  // HSL's own map (512 px tiles), proxied so the API key stays secret.
  L.tileLayer('/api/tile?z={z}&x={x}&y={y}&r={q}', {
    q: retina,
    tileSize: 512,
    zoomOffset: -1,
    maxZoom: 18,
    attribution: '© <a href="https://www.hsl.fi/">HSL</a> © <a href="https://www.openstreetmap.org/copyright">OSM</a>',
  } as L.TileLayerOptions).addTo(map)
} else {
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map)
}

// ---------------------------------------------------------------- state

let modes = new Set<Mode>((store.get<Array<Mode>>('modes') ?? MODES).filter((m) => MODES.includes(m)))
// Search terms: line numbers ("551") and vehicle side numbers ("#1234").
let terms: Array<string> = parseTerms(new URL(location.href).searchParams.get('line') ?? '')
let lines = terms.filter((t) => !t.startsWith('#'))
let vehNums = terms.filter((t) => t.startsWith('#')).map((t) => +t.slice(1))
let lineRoutes: Array<string> | null = null // resolved HFP route ids for `lines`
let selected: string | null = null
let followVehicle = false
let followMe = false
// A ?city= link that moved the map counts as a choice: don't jump back to GPS.
let userMoved = openedLinkCity
/**
 * The city that line and vehicle-number searches look in: the one on screen, or the last one
 * seen. Line numbers repeat between cities ("5" runs in Helsinki and in Tampere).
 */
let searchCity: City = cityAt(start[0], start[1]) ?? DEFAULT_CITY
let gps: L.LatLng | null = null
let trip: Trip | null = null
let tripK = ''
let tripNote = ''

// One canvas for route lines, stop dots and zoomed-out vehicle dots, so taps reach all of them.
const canvas = L.canvas({ tolerance: 10 })
const tripLine = new TripLine(map, canvas, (s) => selectStop(s))
const stopsLayer = new StopsLayer(map, canvas, (s) => selectStop(s))
stopsLayer.modes = modes
const vehicles = new Vehicles(map, canvas, (id) => select(id), onSelectedUpdate)
const isSearchedVehicle = (m: Msg) => m.city === searchCity.id && m.veh !== '' && vehNums.includes(+m.veh)
vehicles.filter = (m) =>
  modes.has(m.mode) &&
  (terms.length === 0 ||
    (m.city === searchCity.id && lines.includes(m.desi.toUpperCase())) ||
    isSearchedVehicle(m))
vehicles.anywhere = isSearchedVehicle

// ---------------------------------------------------------------- live data

const statusEl = $('status')
const STATUS_TEXT: Record<MqttStatus, string> = {
  online: 'Live',
  connecting: 'Connecting…',
  offline: 'No connection',
}
/** Don't flash a connection hint for blips that resolve this fast (e.g. resuming the tab). */
const CONN_HINT_DELAY_MS = 3000
let wasOnline = false
let lastStatus: MqttStatus = 'offline'
let connHintTimer: ReturnType<typeof setTimeout> | undefined
const liveFeeds = new Live(
  (m) => vehicles.push(m),
  (s) => {
    statusEl.className = `dot ${s}`
    statusEl.title = STATUS_TEXT[s]
    const prev = lastStatus
    lastStatus = s
    clearTimeout(connHintTimer)
    if (s === 'online') {
      wasOnline = true
      setConnHint('')
      return
    }
    if (document.hidden) return setConnHint('') // stopped on purpose; nothing to tell
    // Lost the live feed: show at once that positions are no longer current.
    if (prev === 'online') vehicles.markAllStale()
    const text =
      s === 'offline'
        ? 'No connection – vehicle positions may be out of date'
        : wasOnline
          ? 'Reconnecting… vehicle positions may be out of date'
          : 'Connecting…'
    // Going offline is certain, so say it now; connecting usually succeeds quickly.
    if (s === 'offline') setConnHint(text)
    else connHintTimer = setTimeout(() => setConnHint(text), CONN_HINT_DELAY_MS)
  },
)

/** Below this zoom, vehicles in an area are drawn as plain dots (there can be 1000+). */
const COMPACT_BELOW_ZOOM = 14
/** Below this zoom, no area vehicles at all (only searched or selected ones). */
const AREA_MIN_ZOOM = 11
/** Accepts no new vehicles (a zero-size box in the sea off Africa). */
const NOWHERE = L.latLngBounds([0, 0], [0, 0])

/** Topic filters per feed, built up city by city. */
class Topics {
  readonly byFeed = new Map<Feed, Array<string>>()
  add(city: City, ...topics: Array<string>): void {
    const feed = feedOf(city)
    const list = this.byFeed.get(feed) ?? []
    list.push(...topics)
    this.byFeed.set(feed, list)
  }
}

/** Subscribe to exactly what's needed: the visible area, or the searched lines/vehicles anywhere. */
function updateTopics(): void {
  const topics = new Topics()
  const sc = searchCity
  for (const n of vehNums) topics.add(sc, feedOf(sc).vehicleNumber(sc, n))
  const z = map.getZoom()
  let hint = ''
  // Without resolved route ids, line search falls back to filtering the visible area.
  const lineMode = terms.length > 0 && (lines.length === 0 || lineRoutes !== null)
  if (lineMode) {
    if (lineRoutes) topics.add(sc, ...lineRoutes.map((r) => feedOf(sc).route(sc, r)))
  } else if (z >= AREA_MIN_ZOOM) {
    const b = map.getBounds().pad(0.15)
    const view = { south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() }
    // Close up: every update (~1/s per vehicle). Further out: only when a vehicle moved
    // ~100 m, on feeds that support it (HSL: ~12 % of the traffic).
    const onlyMoved = z < COMPACT_BELOW_ZOOM
    for (const city of CITIES) {
      const box = intersect(view, city.area) // nothing between cities
      if (box) topics.add(city, ...feedOf(city).area(city, box, 160, onlyMoved, modes))
    }
  } else {
    hint = 'Tap a city, or zoom in to see vehicles'
  }
  const sel = selected ? vehicles.get(selected) : undefined
  const selCity = sel && cityById(sel.city)
  if (sel && selCity) topics.add(selCity, feedOf(selCity).vehicle(selCity, sel))
  liveFeeds.setTopics(topics.byFeed)
  if (lineMode) {
    vehicles.area = null
  } else if (z < AREA_MIN_ZOOM) {
    // Area vehicles get no more updates: drop them now rather than letting them go stale.
    vehicles.area = NOWHERE
    vehicles.prune(null)
  } else {
    vehicles.area = map.getBounds().pad(0.5)
    vehicles.prune(map.getBounds().pad(0.6))
  }
  // After pruning, so markers aren't rebuilt for vehicles that are about to go.
  // Line searches are few vehicles: keep their labels at any zoom.
  vehicles.setCompact(!lineMode && z < COMPACT_BELOW_ZOOM)
  setZoomHint(hint)
}

/** Set or remove (null) a query param of the page URL, without a new history entry. */
function setParam(k: string, v: string | null): void {
  const u = new URL(location.href)
  if (v == null) u.searchParams.delete(k)
  else u.searchParams.set(k, v)
  if (u.href !== location.href) history.replaceState(null, '', u)
}

/**
 * Keep track of the city on screen: it goes in the URL (?city=tampere, none for HSL), so links
 * open in the right city, and searches move to it ("5" now means Tampere's line 5).
 */
function followCity(): void {
  // Zoomed out over several cities, the one at the centre isn't "the city on screen".
  if (map.getZoom() < AREA_MIN_ZOOM) return
  const c = map.getCenter()
  const city = cityAt(c.lat, c.lng)
  if (!city) return // between cities: keep the last one
  setParam('city', city === DEFAULT_CITY ? null : city.id)
  if (city === searchCity) return
  searchCity = city
  if (!terms.length) return
  lineRoutes = null
  vehicles.refilter()
  startSearch()
}

/** Zoomed out: one marker per city instead of vehicles. Tap one to go there. */
const cityMarkers = new CityMarkers(map, AREA_MIN_ZOOM, (c) => {
  userMoved = true
  followMe = false
  locateBtn.classList.remove('on')
  map.setView(c.center, 13)
})

let moveTimer: ReturnType<typeof setTimeout> | undefined
let savedView = ''
map.on('moveend', () => {
  clearTimeout(moveTimer)
  moveTimer = setTimeout(() => {
    followCity()
    updateTopics()
    cityMarkers.update()
    if (__HAS_KEY__) stopsLayer.update()
  }, 250)
  // While following a vehicle this fires every second; localStorage writes are synchronous,
  // so only write when the stored (coarse) value actually changes.
  const c = map.getCenter()
  const v = { lat: coarse(c.lat), lng: coarse(c.lng), z: map.getZoom() }
  const s = JSON.stringify(v)
  if (s !== savedView) {
    savedView = s
    store.set('view', v)
  }
})

map.on('dragstart', () => {
  userMoved = true
  followMe = false
  followVehicle = false
  $('locate').classList.remove('on')
})
function closeAll(): void {
  setInfo(false)
  selectStop(null)
  select(null)
}
map.on('click', closeAll)
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeAll())

// ---------------------------------------------------------------- card rendering

const cardEl = $('card')
const srEl = $('sr')
let cardHtml = ''

/**
 * Replace the card's content. Skips identical HTML (the vehicle card re-renders every
 * second), and puts keyboard focus back on the same control after a rebuild.
 */
function setCard(html: string): void {
  if (html === cardHtml) return
  cardHtml = html
  const f = document.activeElement as HTMLElement | null
  const act = f && cardEl.contains(f) ? f.dataset.act : undefined
  const id = f?.dataset.id
  cardEl.innerHTML = html
  if (act) {
    const sel = `[data-act="${act}"]${id ? `[data-id="${CSS.escape(id)}"]` : ''}`
    cardEl.querySelector<HTMLElement>(sel)?.focus({ preventScroll: true })
  }
}

/** Tell screen-reader users what just opened (once, not on every refresh). */
let srTimer: ReturnType<typeof setTimeout> | undefined
function announce(t: string): void {
  clearTimeout(srTimer)
  srEl.textContent = ''
  // Setting the text after a tick makes a repeated identical message be read again.
  srTimer = setTimeout(() => (srEl.textContent = t), 50)
}

// ---------------------------------------------------------------- selection

/**
 * Select a vehicle (null = none). The map follows the selected vehicle until the user
 * drags it; selecting the same vehicle again re-centres on it and resumes following.
 */
function select(id: string | null): void {
  if (selected === id) {
    const m = id && vehicles.get(id)
    if (m) {
      followVehicle = true
      followMe = false
      $('locate').classList.remove('on')
      map.panTo([m.lat, m.lng])
    }
    return
  }
  selected = id
  if (id) setInfo(false)
  if (id && stopSel) selectStop(null)
  vehicles.setSelected(id)
  tripLine.clear()
  trip = null
  tripK = ''
  tripNote = ''
  const card = $('card')
  if (!id) {
    card.hidden = true
    followVehicle = false
  } else {
    followVehicle = true
    followMe = false
    $('locate').classList.remove('on')
    const m = vehicles.get(id)
    if (m) {
      map.panTo([m.lat, m.lng])
      onSelectedUpdate(m)
      announce(`Line ${m.desi || 'unknown'}${m.headsign ? ` to ${m.headsign}` : ''}${m.veh ? `, vehicle ${+m.veh}` : ''}`)
    }
    card.hidden = false
  }
  updateTopics()
}

function loadTrip(m: Msg): void {
  tripK = tripKey(m)
  trip = null
  tripLine.clear()
  tripNote = ''
  if (!canFetchTrip(m)) return
  const k = tripK
  fetchTrip(m)
    .then((t) => {
      if (k !== tripK) return
      trip = t
      if (!t) tripNote = 'Route details not found'
      else tripLine.show(t, COLORS[m.mode], m.mode)
    })
    .catch((e) => {
      if (k !== tripK) return
      tripNote =
        e instanceof MissingKeyError
          ? 'Route details need a Digitransit API key.'
          : 'Could not load route details.'
    })
    .finally(() => {
      const cur = selected && vehicles.get(selected)
      if (k === tripK && cur) onSelectedUpdate(cur)
    })
}

function onSelectedUpdate(m: Msg): void {
  if (tripKey(m) !== tripK) loadTrip(m)
  tripLine.update(m.lat, m.lng, m.nextStop)
  if (followVehicle) map.panTo([m.lat, m.lng], { animate: true, duration: 1, easeLinearity: 1, noMoveStart: true })
  renderCard(m)
}

function renderCard(m: Msg): void {
  const d = delayText(m.dl)
  const dest = trip?.headsign || m.headsign
  const speed =
    m.spd == null
      ? ''
      : m.spd < 0.5
        ? m.doorsOpen
          ? 'Stopped · doors open'
          : 'Stopped'
        : `${Math.round(m.spd * 3.6)} km/h`
  const meta = [d.text && `<span class="${d.cls}">${d.text}</span>`, speed, m.veh && `#${+m.veh}`]
    .filter(Boolean)
    .join(' · ')

  let stops = ''
  if (trip) {
    if (m.nextStop === 'EOL') {
      stops = '<li><span>Reached the end of the line</span></li>'
    } else {
      const k = trip.stops.findIndex((s) => s.id === m.nextStop)
      if (k >= 0) {
        const now = nowServiceSeconds(m.oday)
        stops = trip.stops
          .slice(k, k + 3)
          .map((s) => {
            const eta = s.t - (m.dl ?? 0)
            const mins = Math.round((eta - now) / 60)
            const rel = mins <= 0 ? ' · now' : mins < 60 ? ` · ${mins} min` : ''
            return `<li><span>${escapeHtml(s.name)}</span><time>${clock(eta)}${rel}</time></li>`
          })
          .join('')
      }
    }
  }

  setCard(`
    <div class="ch">
      <span class="badge ${modeClass(m.mode)}">${escapeHtml(m.desi || '?')}</span>
      <div class="dest"><b>${escapeHtml(dest ? `→ ${dest}` : m.desi)}</b><small>${meta}</small></div>
      <button type="button" class="ib" data-act="close" aria-label="Close">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    ${stops ? `<ol class="stops">${stops}</ol>` : ''}
    ${tripNote ? `<p class="note">${escapeHtml(tripNote)}</p>` : ''}`)
}

$('card').addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')
  const act = el?.dataset.act
  if (act === 'close') closeAll()
  if (act === 'veh' && el?.dataset.id) select(el.dataset.id)
  if (act === 'more') loadMore()
  if (act === 'forget') forgetLocation()
})

$('card').addEventListener('keydown', (e) => {
  const el = e.target as HTMLElement
  if ((e.key === 'Enter' || e.key === ' ') && el.dataset.act === 'veh') {
    e.preventDefault()
    el.click()
  }
})

// ---------------------------------------------------------------- privacy panel (bottom-left button)

const infoBtn = $('info')
let infoOpen = false
/** Set after "Forget my location", to confirm it in the panel. */
let forgotten = false

/** Open or close the privacy panel. It uses the card, so it replaces a vehicle or stop. */
function setInfo(open: boolean): void {
  if (open === infoOpen) return
  infoOpen = open
  infoBtn.setAttribute('aria-expanded', String(open))
  if (open) {
    selectStop(null)
    select(null)
    renderInfo()
    cardEl.hidden = false
    announce('Privacy')
  } else if (!selected && !stopSel) {
    cardEl.hidden = true
  }
}
infoBtn.addEventListener('click', () => setInfo(!infoOpen))

/** Keep in sync with what the app actually stores and sends (store.set, the feeds, /api). */
function renderInfo(): void {
  const saved = store.get('gps') != null || store.get('view') != null
  const forget = saved
    ? '<button type="button" class="forget" data-act="forget">Forget my location</button>'
    : `<p class="note">${forgotten ? 'Done, your location is forgotten.' : 'No location saved.'}</p>`
  setCard(`
    <div class="ch">
      <div class="dest"><b>Privacy</b></div>
      <button type="button" class="ib" data-act="close" aria-label="Close">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    <div class="info">
      <p>No cookies, ads or tracking.</p>
      <p>Your browser remembers where you last looked on the map, which vehicle types you've hidden,
        and, if you've used the location button, roughly where you were (to about 100 m). It stays on
        your device.</p>
      <p>To show the vehicles around you, the map area you're viewing is sent to HSL and Digitransit.
        Map tiles, stops and departures come through this site's server.</p>
      ${forget}
    </div>`)
}

/** Delete the saved location and view, and stop using GPS until the location button is tapped again. */
function forgetLocation(): void {
  pauseGps()
  gpsOn = false
  gps = null
  meDot?.remove()
  meAcc?.remove()
  meDot = meAcc = null
  followMe = false
  locateBtn.classList.remove('on')
  store.remove('gps')
  store.remove('view')
  savedView = ''
  forgotten = true
  renderInfo()
  announce('Location forgotten')
}

// ---------------------------------------------------------------- stop departures board

let stopSel: StopRef | null = null
let board: StopBoard | null = null
let boardNote = ''
let boardSeq = 0
let boardTimer: ReturnType<typeof setInterval> | undefined
// Scrolling the board pages further into the future.
const PAGE = STOP_PAGE
const MAX_DEPARTURES = 200
let stopGen = 0
let boardMore = true // more departures may exist after the loaded ones
let loadingMore = false
let moreFailed = false

/** A stop as written in the URL: "1130446" for HSL (as always), "tampere:3598" elsewhere. */
const stopParamOf = (s: StopRef): string => (s.city === DEFAULT_CITY.id ? s.id : stopKey(s))

/** The ?stop= param back to a stop, or null if it isn't a valid stop id (same checks as api/stop.ts). */
function parseStopParam(p: string): Pick<StopRef, 'city' | 'id'> | null {
  const i = p.indexOf(':')
  const city = i < 0 ? DEFAULT_CITY : cityById(p.slice(0, i))
  const id = p.slice(i + 1)
  if (!city || (i >= 0 && city === DEFAULT_CITY) || !city.ids.stop.test(id)) return null
  return { city: city.id, id }
}

function selectStop(s: StopRef | null): void {
  if (s && stopSel && stopKey(stopSel) === stopKey(s)) return
  if (s) select(null)
  if (s) setInfo(false)
  stopSel = s
  board = null
  boardNote = ''
  boardSeq++
  stopGen++
  boardMore = true
  loadingMore = false
  moreFailed = false
  clearInterval(boardTimer)
  stopsLayer.setSelected(s && Number.isFinite(s.lat) ? s : null)
  setParam('stop', s ? stopParamOf(s) : null)
  const card = $('card')
  if (!s) {
    if (!selected) card.hidden = true
    return
  }
  card.hidden = false
  renderBoard()
  loadBoard()
  // Count down every 10 s, refresh realtime estimates every 20 s.
  let n = 0
  boardTimer = setInterval(() => (++n % 2 === 0 ? loadBoard() : renderBoard()), 10_000)
}

function loadBoard(): void {
  const s = stopSel
  if (!s || document.hidden) return
  const seq = ++boardSeq
  fetchStopBoard(s)
    .then((b) => {
      if (seq !== boardSeq) return
      if (!b) {
        boardNote = 'Stop not found.'
        return
      }
      // Fresh realtime estimates for the first page; keep later pages the user scrolled to.
      const last = b.departures[b.departures.length - 1]
      const keys = new Set(b.departures.map(departureKey))
      const later =
        board && last ? board.departures.filter((d) => d.sched > last.sched && !keys.has(departureKey(d))) : []
      if (!board) {
        boardMore = b.departures.length >= PAGE
        announce(`${b.stop.name || 'Stop'} departures, ${b.departures.length ? `next: line ${b.departures[0].line}` : 'none soon'}`)
      }
      board = { ...b, departures: [...b.departures, ...later].sort((x, y) => x.at - y.at) }
      boardNote = ''
      if (!Number.isFinite(s.lat)) {
        // Opened from a ?stop= link: now we know where it is.
        stopSel = b.stop
        stopsLayer.setSelected(b.stop)
        followMe = false
        locateBtn.classList.remove('on')
        map.setView([b.stop.lat, b.stop.lng], Math.max(map.getZoom(), 16))
      }
    })
    .catch((e) => {
      if (seq !== boardSeq) return
      boardNote =
        e instanceof MissingKeyError
          ? 'Departures need a Digitransit API key.'
          : board
            ? 'Could not refresh, showing the last known times.'
            : 'Could not load departures.'
    })
    .finally(() => {
      if (seq === boardSeq) renderBoard()
    })
}

/** Fetch the next page of departures after the last loaded one. */
function loadMore(): void {
  const s = stopSel
  if (!s || !board || !boardMore || loadingMore || board.departures.length >= MAX_DEPARTURES) return
  const gen = stopGen
  const deps = board.departures
  // Page from the latest scheduled time we have; overlap in that minute is deduplicated.
  const start = Math.max(Math.max(...deps.map((d) => d.sched)), Date.now() / 1000)
  loadingMore = true
  moreFailed = false
  renderBoard()
  fetchStopBoard(s, start)
    .then((b) => {
      if (gen !== stopGen || !board) return
      const keys = new Set(board.departures.map(departureKey))
      const add = (b?.departures ?? []).filter((d) => !keys.has(departureKey(d)))
      if (!add.length || (b?.departures.length ?? 0) < PAGE) boardMore = false
      board = { ...board, departures: [...board.departures, ...add].sort((x, y) => x.at - y.at) }
    })
    .catch(() => {
      if (gen === stopGen) moreFailed = true
    })
    .finally(() => {
      if (gen !== stopGen) return
      loadingMore = false
      renderBoard()
    })
}

const dayFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Helsinki',
  weekday: 'long',
  day: 'numeric',
  month: 'numeric',
})

/**
 * Matches live vehicles to departures: by trip id where the feed has one (GTFS-RT), else
 * (HFP) by route, direction, service day and start time.
 */
function tripMatchKey(
  city: string,
  tripId: string,
  route: string,
  dir: string,
  date: string,
  start: () => number,
): string {
  return tripId ? `${city}|${tripId}` : `${city}|${route}|${dir}|${date}|${start()}`
}

/**
 * Live vehicles by the trip they're running, to find the vehicle for a departure.
 * Built once per render: one pass over the vehicles instead of one per departure
 * (tripStartSeconds formats a date, which adds up with 200 departures × 1000 vehicles).
 */
function liveByTrip(): Map<string, Msg> {
  const out = new Map<string, Msg>()
  for (const m of vehicles.visible()) {
    if (!m.tripId && (!m.start || !m.oday)) continue
    out.set(tripMatchKey(m.city, m.tripId, m.route, m.dir, m.oday, () => tripStartSeconds(m.start, m.oday, m.tst)), m)
  }
  return out
}

/** The live vehicle running this departure, if it's on the map. */
function vehicleFor(d: Departure, city: string, live: Map<string, Msg>): Msg | undefined {
  if (d.canceled) return undefined
  if (!d.tripId && d.start < 0) return undefined
  return live.get(tripMatchKey(city, d.tripId, d.route, d.dir, d.date, () => d.start))
}

const PIN =
  '<svg class="pin" viewBox="0 0 24 24" width="14" height="14"><path d="M12 21s-6-5.5-6-11a6 6 0 0 1 12 0c0 5.5-6 11-6 11z"/><circle cx="12" cy="10" r="2"/></svg>'

function departureRow(d: Departure, city: string, nowS: number, live: Map<string, Msg>): string {
  const mins = Math.floor((d.at - nowS) / 60)
  const when = d.canceled ? 'Cancelled' : mins <= 0 ? 'Now' : mins < 20 ? `${mins} min` : clock(d.clockSec)
  const late = Math.round((d.at - d.sched) / 60)
  const title = d.canceled
    ? 'Cancelled'
    : d.realtime
      ? `Realtime estimate${late > 0 ? `, ${late} min late` : late < 0 ? `, ${-late} min early` : ''} (scheduled ${clock(d.clockSec - (d.at - d.sched))})`
      : 'Scheduled time (no realtime data)'
  const veh = vehicleFor(d, city, live)
  const cls = [d.canceled && 'cx', veh && 'on-map'].filter(Boolean).join(' ')
  const attrs = veh
    ? ` data-act="veh" data-id="${escapeHtml(veh.id)}" role="button" tabindex="0" aria-label="Show ${escapeHtml(d.line)} to ${escapeHtml(d.headsign)} on the map"`
    : ''
  return `<li class="${cls}"${attrs}>
      <span class="ln ${modeClass(d.mode)}">${escapeHtml(d.line || '?')}</span>
      <span class="hs"><span>${escapeHtml(d.headsign)}</span>${veh ? PIN : ''}</span>
      <time class="${d.realtime && !d.canceled ? 'rt' : ''}" title="${escapeHtml(title)}">${when}</time>
    </li>`
}

function renderBoard(): void {
  if (!stopSel || selected) return
  const s = board?.stop ?? stopSel
  const nowS = Date.now() / 1000
  const live = liveByTrip()
  // Separate rows by calendar day, so 00:20 after a 23:50 isn't ambiguous.
  const today = helsinkiDate(new Date())
  const tomorrow = helsinkiDate(new Date(Date.now() + 86_400_000))
  let day = today
  let rows = ''
  for (const d of board?.departures ?? []) {
    if (d.at - nowS <= -30) continue
    const dDay = helsinkiDate(new Date(d.at * 1000))
    if (dDay !== day) {
      day = dDay
      rows += `<li class="day">${dDay === tomorrow ? 'Tomorrow' : escapeHtml(dayFmt.format(new Date(d.at * 1000)))}</li>`
    }
    rows += departureRow(d, s.city, nowS, live)
  }
  if (rows && board) {
    if (loadingMore) rows += '<li class="more">Loading later departures…</li>'
    else if (moreFailed)
      rows += '<li class="more"><button type="button" data-act="more">Couldn’t load more, try again</button></li>'
    else if (boardMore && board.departures.length < MAX_DEPARTURES)
      rows += '<li class="more"><button type="button" data-act="more">Show later departures</button></li>'
    else if (!boardMore) rows += '<li class="more">No later departures</li>'
  }

  const now = clock(nowServiceSeconds(helsinkiDate(new Date())))
  const meta = [s.code, board?.platform ? `Platform ${board.platform}` : '', now]
    .filter(Boolean)
    .map(escapeHtml)
    .join(' · ')
  let body = ''
  if (rows) body = `<ol class="board">${rows}</ol>`
  else if (board) body = '<p class="note">No departures in the next 24 hours.</p>'
  else if (!boardNote) body = '<p class="note">Loading departures…</p>'

  const scroll = cardEl.querySelector('.board')?.scrollTop ?? 0
  setCard(`
    <div class="ch">
      <span class="badge ${modeClass(s.mode)}" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20"><rect x="6" y="3" width="12" height="10" rx="2"/><path d="M12 13v8M9 21h6"/></svg>
      </span>
      <div class="dest"><b>${escapeHtml(s.name || 'Stop')}</b><small>${meta}</small></div>
      <button type="button" class="ib" data-act="close" aria-label="Close">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    ${body}
    ${boardNote ? `<p class="note">${escapeHtml(boardNote)}</p>` : ''}`)
  const list = cardEl.querySelector('.board')
  if (list) list.scrollTop = scroll
}

// Load later departures as the board is scrolled near its end (scroll doesn't bubble: capture).
$('card').addEventListener(
  'scroll',
  (e) => {
    const el = e.target as HTMLElement
    if (el.classList?.contains('board') && el.scrollTop + el.clientHeight > el.scrollHeight - 150) loadMore()
  },
  true,
)

// ---------------------------------------------------------------- GPS

const locateBtn = $('locate')
let watchId: number | null = null
/** GPS was turned on (auto or by the user); it pauses while the tab is hidden. */
let gpsOn = false
let meDot: L.CircleMarker | null = null
let meAcc: L.Circle | null = null

function startGps(): void {
  if (!('geolocation' in navigator) || watchId !== null) return
  gpsOn = true
  watchId = navigator.geolocation.watchPosition(onPos, onPosError, {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 30000,
  })
}
function pauseGps(): void {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId)
  watchId = null
}

/**
 * Turn GPS on at startup only when that won't pop up a permission prompt out of nowhere:
 * permission already granted, or the user shared their location on an earlier visit (some
 * browsers, e.g. Safari, ask again each session). Otherwise wait for a tap on the locate button.
 */
async function autoStartGps(): Promise<void> {
  let state: PermissionState | undefined
  try {
    state = (await navigator.permissions?.query({ name: 'geolocation' }))?.state
  } catch {
    /* unsupported: decide on lastGps alone */
  }
  if (state === 'denied') locateBtn.classList.add('denied')
  else if (state === 'granted' || lastGps) startGps()
}

function onPos(p: GeolocationPosition): void {
  const ll = L.latLng(p.coords.latitude, p.coords.longitude)
  const first = !gps
  gps = ll
  locateBtn.classList.remove('denied')
  store.set('gps', { lat: coarse(ll.lat), lng: coarse(ll.lng) })
  if (!meDot) {
    meAcc = L.circle(ll, { radius: p.coords.accuracy, stroke: false, fillColor: '#007AC9', fillOpacity: 0.1, interactive: false }).addTo(map)
    meDot = L.circleMarker(ll, { radius: 7, weight: 3, color: '#fff', fillColor: '#007AC9', fillOpacity: 1, interactive: false, className: 'me' }).addTo(map)
  } else {
    meDot.setLatLng(ll)
    meAcc!.setLatLng(ll).setRadius(p.coords.accuracy)
  }
  if (first && !userMoved && !selected) {
    followMe = true
    locateBtn.classList.add('on')
    map.setView(ll, Math.max(map.getZoom(), 15))
  } else if (followMe) {
    map.panTo(ll)
  }
}

function onPosError(e: GeolocationPositionError): void {
  if (e.code === e.PERMISSION_DENIED) {
    locateBtn.classList.add('denied')
    pauseGps()
    gpsOn = false
  }
}

locateBtn.addEventListener('click', () => {
  if (gps) {
    followMe = true
    followVehicle = false
    locateBtn.classList.add('on')
    map.setView(gps, Math.max(map.getZoom(), 15))
  } else if (locateBtn.classList.contains('denied')) {
    toast('Location is blocked – allow it in your browser settings')
  } else {
    userMoved = false
    toast('Finding your location…')
    startGps()
  }
})

// ---------------------------------------------------------------- line filter + modes

const q = $<HTMLInputElement>('q')
const clearBtn = $('clear')

function parseTerms(s: string): Array<string> {
  const out = s
    .toUpperCase()
    .split(/[\s,]+/)
    .filter((t) => /^[0-9A-Z]{1,8}$/.test(t) || /^#\d{1,5}$/.test(t))
    .map((t) => (t.startsWith('#') ? `#${+t.slice(1)}` : t))
  return [...new Set(out)]
}

function applyQuery(): void {
  const next = parseTerms(q.value)
  clearBtn.hidden = q.value === ''
  if (next.join() === terms.join() && (lineRoutes || !lines.length)) return
  terms = next
  lines = next.filter((t) => !t.startsWith('#'))
  vehNums = next.filter((t) => t.startsWith('#')).map((t) => +t.slice(1))
  lineRoutes = null
  const u = new URL(location.href)
  if (next.length) u.searchParams.set('line', next.join(','))
  else u.searchParams.delete('line')
  history.replaceState(null, '', u)
  vehicles.refilter()
  updateTopics()
  startSearch()
}

function startSearch(): void {
  if (lines.length) resolveLines(lines)
  else if (vehNums.length) {
    const want = terms
    setTimeout(() => fitIfNoneVisible(want), 2500)
  }
}

function resolveLines(want: Array<string>): void {
  if (!__HAS_KEY__) return // filter only within the visible area
  const wantTerms = terms
  const city = searchCity
  Promise.all(want.map((l) => fetchRoutes(city, l)))
    .then((rs) => {
      if (terms !== wantTerms || city !== searchCity) return
      const ids = [...new Set(rs.flat().map((r) => r.id))]
      if (!ids.length) {
        toast(`No line ${want.join(', ')}`)
        return
      }
      lineRoutes = ids
      updateTopics()
      setTimeout(() => fitIfNoneVisible(wantTerms), 2500)
    })
    .catch(() => {}) // fall back to filtering the visible area
}

/** If none of the searched vehicles are on screen, zoom out to show them. */
function fitIfNoneVisible(want: Array<string>): void {
  if (terms !== want || selected) return
  const vs = vehicles.visible()
  if (!vs.length) {
    toast(`No ${want.join(', ')} running right now`)
    return
  }
  const view = map.getBounds()
  if (vs.some((v) => view.contains([v.lat, v.lng]))) return
  const pts = vs.map((v) => L.latLng(v.lat, v.lng))
  if (gps) pts.push(gps)
  map.fitBounds(L.latLngBounds(pts), { padding: [70, 70], maxZoom: 15 })
}

let qTimer: ReturnType<typeof setTimeout> | undefined
q.addEventListener('input', () => {
  clearTimeout(qTimer)
  qTimer = setTimeout(applyQuery, 450)
})
$('search').addEventListener('submit', (e) => {
  e.preventDefault()
  clearTimeout(qTimer)
  applyQuery()
  q.blur()
})
clearBtn.addEventListener('click', () => {
  q.value = ''
  applyQuery()
})

const modesEl = $('modes')
function renderModes(): void {
  modesEl.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => {
    const on = modes.has(b.dataset.mode as Mode)
    b.setAttribute('aria-pressed', String(on))
    b.title = `${on ? 'Hide' : 'Show'} ${b.textContent!.trim().toLowerCase()}s`
  })
}
modesEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-mode]')
  if (!b) return
  const m = b.dataset.mode as Mode
  modes = new Set(modes)
  if (modes.has(m)) modes.delete(m)
  else modes.add(m)
  store.set('modes', [...modes])
  renderModes()
  vehicles.refilter()
  updateTopics() // hiding buses also stops downloading them
  stopsLayer.modes = modes
  stopsLayer.refilter()
})

// ---------------------------------------------------------------- hint / toast

const hintEl = $('hint')
let hintText = ''
let zoomHint = ''
let connHint = ''
let toastTimer: ReturnType<typeof setTimeout> | undefined
/** The persistent hint: connection problems outrank "zoom in". */
function setHint(): void {
  hintText = connHint || zoomHint
  if (!toastTimer) showHint(hintText)
}
function setZoomHint(t: string): void {
  zoomHint = t
  setHint()
}
function setConnHint(t: string): void {
  connHint = t
  setHint()
}
function showHint(t: string): void {
  hintEl.textContent = t
  hintEl.hidden = !t
}
function toast(t: string): void {
  clearTimeout(toastTimer)
  showHint(t)
  toastTimer = setTimeout(() => {
    toastTimer = undefined
    showHint(hintText)
  }, 3000)
}

// ---------------------------------------------------------------- lifecycle

let hiddenAt = 0
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = Date.now()
    liveFeeds.stop() // no data or battery use in the background
    pauseGps()
  } else {
    if (Date.now() - hiddenAt > 20000) vehicles.markAllStale()
    liveFeeds.start()
    if (gpsOn) startGps()
    loadBoard() // no-op unless a stop board is open
  }
})

q.value = terms.join(' ')
clearBtn.hidden = !terms.length
renderModes()
liveFeeds.start()
followCity() // the initial view fires no moveend
updateTopics()
if (__HAS_KEY__) stopsLayer.update()
void autoStartGps()
startSearch()

// ?stop=1130446 (HSL) or ?stop=tampere:3598 opens that stop's board (a shareable "my stop" link).
const linkStop = parseStopParam(new URL(location.href).searchParams.get('stop') ?? '')
if (__HAS_KEY__ && linkStop) {
  userMoved = true // don't jump to GPS
  selectStop({ ...linkStop, name: '', code: '', lat: NaN, lng: NaN, mode: null })
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}))
}
