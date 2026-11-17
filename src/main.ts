import 'leaflet/dist/leaflet.css'
import './styles.css'
import L from 'leaflet'
import { MqttClient } from './mqtt'
import type { MqttStatus } from './mqtt'
import {
  BROKER,
  COLORS,
  MODES,
  areaFilters,
  clock,
  delayText,
  nowServiceSeconds,
  parseMessage,
  routeFilter,
  vehicleFilter,
} from './hfp'
import type { Mode, Msg } from './hfp'
import { Vehicles } from './vehicles'
import { TripLine, escapeHtml } from './trip-line'
import { MissingKeyError, fetchRoutes, fetchTrip, tripKey } from './api'
import type { Trip } from './api'

declare const __HAS_KEY__: boolean

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

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
}

// ---------------------------------------------------------------- map

const mapEl = $('map')
const lastGps = store.get<{ lat: number; lng: number }>('gps')
const lastView = store.get<{ lat: number; lng: number; z: number }>('view')
const start: [number, number, number] = lastGps
  ? [lastGps.lat, lastGps.lng, 15]
  : lastView
    ? [lastView.lat, lastView.lng, lastView.z]
    : [60.1699, 24.9384, 13]

const map = L.map(mapEl, { zoomControl: false, minZoom: 8, maxZoom: 18 }).setView(
  [start[0], start[1]],
  start[2],
)
map.attributionControl.setPrefix(false)

const conn = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } })
  .connection
const lowData = !!conn?.saveData || /2g/.test(conn?.effectiveType ?? '')
const retina = devicePixelRatio >= 1.5 && !lowData ? '@2x' : ''

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
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{q}.png', {
    q: retina,
    subdomains: 'abcd',
    maxZoom: 18,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OSM</a> © <a href="https://carto.com/">CARTO</a>',
  } as L.TileLayerOptions).addTo(map)
}

// No marker glide while Leaflet re-positions everything on zoom.
map.on('zoomstart', () => mapEl.classList.add('zooming'))
map.on('zoomend', () =>
  requestAnimationFrame(() => requestAnimationFrame(() => mapEl.classList.remove('zooming'))),
)

// ---------------------------------------------------------------- state

let modes = new Set<Mode>((store.get<Array<Mode>>('modes') ?? MODES).filter((m) => MODES.includes(m)))
let lines: Array<string> = parseLines(new URL(location.href).searchParams.get('line') ?? '')
let lineRoutes: Array<string> | null = null // resolved HFP route ids for `lines`
let selected: string | null = null
let followVehicle = false
let followMe = false
let userMoved = false
let gps: L.LatLng | null = null
let trip: Trip | null = null
let tripK = ''
let tripNote = ''

const tripLine = new TripLine(map)
const vehicles = new Vehicles(map, (id) => select(id), onSelectedUpdate)
vehicles.filter = (m) => modes.has(m.mode) && (lines.length === 0 || lines.includes(m.desi.toUpperCase()))

// ---------------------------------------------------------------- live data

const statusEl = $('status')
const STATUS_TEXT: Record<MqttStatus, string> = {
  online: 'Live',
  connecting: 'Connecting…',
  offline: 'Offline',
}
const mqtt = new MqttClient(
  BROKER,
  (topic, payload) => {
    const m = parseMessage(topic, payload)
    if (m) vehicles.push(m)
  },
  (s) => {
    statusEl.className = `dot ${s}`
    statusEl.title = STATUS_TEXT[s]
  },
)

/** Subscribe to exactly what's needed: the visible area, or the filtered lines anywhere. */
function updateTopics(): void {
  const topics: Array<string> = []
  const z = map.getZoom()
  let hint = ''
  const lineMode = lines.length > 0 && lineRoutes !== null
  if (lineMode) {
    topics.push(...lineRoutes!.map(routeFilter))
  } else {
    const b = map.getBounds().pad(0.15)
    const box = { south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() }
    // Close up: every update (~1/s per vehicle). Further out: only when a vehicle
    // moved ~100 m (geohash levels 0–3, ~12 % of the traffic).
    if (z >= 13) topics.push(...areaFilters(box, 160))
    else if (z >= 11) topics.push(...areaFilters(box, 160, [0, 1, 2, 3]))
    else hint = 'Zoom in to see vehicles'
  }
  const sel = selected ? vehicles.get(selected) : undefined
  if (sel) topics.push(vehicleFilter(sel.oper, sel.veh))
  mqtt.setTopics(topics)
  vehicles.area = lineMode ? null : map.getBounds().pad(0.5)
  if (!lineMode) vehicles.prune(map.getBounds().pad(0.6))
  setHint(hint)
}

let moveTimer: ReturnType<typeof setTimeout> | undefined
map.on('moveend', () => {
  clearTimeout(moveTimer)
  moveTimer = setTimeout(updateTopics, 250)
  const c = map.getCenter()
  store.set('view', { lat: +c.lat.toFixed(5), lng: +c.lng.toFixed(5), z: map.getZoom() })
})

map.on('dragstart', () => {
  userMoved = true
  followMe = false
  followVehicle = false
  $('locate').classList.remove('on')
  document.querySelector('#card .fol')?.classList.remove('on')
})
map.on('click', () => select(null))
document.addEventListener('keydown', (e) => e.key === 'Escape' && select(null))

// ---------------------------------------------------------------- selection

function select(id: string | null): void {
  if (selected === id) return
  selected = id
  vehicles.setSelected(id)
  mapEl.classList.toggle('has-sel', !!id)
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
  if (!m.route || !m.start || !m.oday) return
  const k = tripK
  fetchTrip(m)
    .then((t) => {
      if (k !== tripK) return
      trip = t
      if (!t) tripNote = 'Route details not found'
      else tripLine.show(t, COLORS[m.mode])
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
  const meta = [d.text && `<span class="${d.cls}">${d.text}</span>`, speed].filter(Boolean).join(' · ')

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

  $('card').innerHTML = `
    <div class="ch">
      <span class="badge" style="background:${COLORS[m.mode]}">${escapeHtml(m.desi || '?')}</span>
      <div class="dest"><b>${escapeHtml(dest ? `→ ${dest}` : m.desi)}</b><small>${meta}</small></div>
      <button type="button" class="fol${followVehicle ? ' on' : ''}" data-act="follow" aria-pressed="${followVehicle}">Follow</button>
      <button type="button" class="ib" data-act="close" aria-label="Close">
        <svg viewBox="0 0 24 24" width="18" height="18"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
    ${stops ? `<ol class="stops">${stops}</ol>` : ''}
    ${tripNote ? `<p class="note">${escapeHtml(tripNote)}</p>` : ''}`
}

$('card').addEventListener('click', (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act
  if (act === 'close') select(null)
  if (act === 'follow' && selected) {
    followVehicle = !followVehicle
    const m = vehicles.get(selected)
    if (m) {
      if (followVehicle) map.panTo([m.lat, m.lng])
      renderCard(m)
    }
  }
})

// ---------------------------------------------------------------- GPS

const locateBtn = $('locate')
let watchId: number | null = null
let meDot: L.CircleMarker | null = null
let meAcc: L.Circle | null = null

function startGps(): void {
  if (!('geolocation' in navigator) || watchId !== null) return
  watchId = navigator.geolocation.watchPosition(onPos, onPosError, {
    enableHighAccuracy: true,
    maximumAge: 5000,
    timeout: 30000,
  })
}
function stopGps(): void {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId)
  watchId = null
}

function onPos(p: GeolocationPosition): void {
  const ll = L.latLng(p.coords.latitude, p.coords.longitude)
  const first = !gps
  gps = ll
  locateBtn.classList.remove('denied')
  store.set('gps', { lat: +ll.lat.toFixed(5), lng: +ll.lng.toFixed(5) })
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
    stopGps()
  }
}

locateBtn.addEventListener('click', () => {
  if (gps) {
    followMe = true
    followVehicle = false
    locateBtn.classList.add('on')
    document.querySelector('#card .fol')?.classList.remove('on')
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

function parseLines(s: string): Array<string> {
  return [...new Set(s.toUpperCase().split(/[\s,]+/).filter((t) => /^[0-9A-Z]{1,8}$/.test(t)))]
}

function applyQuery(): void {
  const next = parseLines(q.value)
  clearBtn.hidden = q.value === ''
  if (next.join() === lines.join() && (lineRoutes || !next.length)) return
  lines = next
  lineRoutes = null
  const u = new URL(location.href)
  if (next.length) u.searchParams.set('line', next.join(','))
  else u.searchParams.delete('line')
  history.replaceState(null, '', u)
  vehicles.refilter()
  updateTopics()
  if (next.length) resolveLines(next)
}

function resolveLines(want: Array<string>): void {
  if (!__HAS_KEY__) return // filter only within the visible area
  Promise.all(want.map(fetchRoutes))
    .then((rs) => {
      if (lines.join() !== want.join()) return
      const ids = [...new Set(rs.flat().map((r) => r.id))]
      if (!ids.length) {
        toast(`No line ${want.join(', ')}`)
        return
      }
      lineRoutes = ids
      updateTopics()
      setTimeout(() => fitIfNoneVisible(want), 2500)
    })
    .catch(() => {}) // fall back to filtering the visible area
}

/** If none of the filtered vehicles are on screen, zoom out to show them. */
function fitIfNoneVisible(want: Array<string>): void {
  if (lines.join() !== want.join() || selected) return
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

const modesBtn = $('modesBtn')
const modesEl = $('modes')
modesBtn.addEventListener('click', () => {
  modesEl.hidden = !modesEl.hidden
  modesBtn.setAttribute('aria-expanded', String(!modesEl.hidden))
})
function renderModes(): void {
  modesEl.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) =>
    b.setAttribute('aria-pressed', String(modes.has(b.dataset.mode as Mode))),
  )
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
})

// ---------------------------------------------------------------- hint / toast

const hintEl = $('hint')
let hintText = ''
let toastTimer: ReturnType<typeof setTimeout> | undefined
function setHint(t: string): void {
  hintText = t
  if (!toastTimer) showHint(t)
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
    mqtt.stop() // no data or battery use in the background
    stopGps()
  } else {
    if (Date.now() - hiddenAt > 20000) vehicles.markAllStale()
    mqtt.start()
    if (!locateBtn.classList.contains('denied')) startGps()
  }
})

q.value = lines.join(' ')
clearBtn.hidden = !lines.length
renderModes()
updateTopics()
mqtt.start()
startGps()
if (lines.length) resolveLines(lines)

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}))
}
