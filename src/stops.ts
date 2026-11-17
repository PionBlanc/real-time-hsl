import L from 'leaflet'
import { CELL_LAT, CELL_LON, fetchStopCell } from './api'
import type { StopRef } from './api'
import { COLORS } from './hfp'
import type { Mode } from './hfp'
import { escapeHtml } from './trip-line'

/** Stops are only drawn when zoomed in this far (there are ~7000 of them). */
export const STOPS_MIN_ZOOM = 15

/**
 * Stop dots for the visible area, loaded per grid cell. Tap one to open its
 * departures board. Drawn on the shared canvas, below the selected trip's line.
 */
export class StopsLayer {
  private group = L.layerGroup()
  private markers = new Map<string, L.CircleMarker>()
  private stops = new Map<string, StopRef>()
  private highlight: L.CircleMarker | null = null
  /** Which stop modes to show (stops without a known mode are always shown). */
  modes: Set<Mode> = new Set()

  constructor(
    private map: L.Map,
    private renderer: L.Renderer,
    private onClick: (s: StopRef) => void,
  ) {}

  /** Call after the map moved. */
  update(): void {
    if (this.map.getZoom() < STOPS_MIN_ZOOM) {
      this.group.remove()
      return
    }
    this.group.addTo(this.map)
    const b = this.map.getBounds().pad(0.2)
    const la0 = Math.floor(b.getSouth() / CELL_LAT)
    const la1 = Math.floor(b.getNorth() / CELL_LAT)
    const lo0 = Math.floor(b.getWest() / CELL_LON)
    const lo1 = Math.floor(b.getEast() / CELL_LON)
    if ((la1 - la0 + 1) * (lo1 - lo0 + 1) > 12) return // guard against huge screens
    for (let la = la0; la <= la1; la++)
      for (let lo = lo0; lo <= lo1; lo++)
        fetchStopCell(la, lo)
          .then((list) => list.forEach((s) => this.add(s)))
          .catch(() => {}) // no key / offline: just no stop dots
  }

  private add(s: StopRef): void {
    if (this.markers.has(s.id)) return
    this.stops.set(s.id, s)
    const c = s.mode ? COLORS[s.mode] : '#5d6874'
    const m = L.circleMarker([s.lat, s.lng], {
      renderer: this.renderer,
      radius: 4.5,
      weight: 2,
      color: c,
      fillColor: '#fff',
      fillOpacity: 1,
      bubblingMouseEvents: false,
    })
      .bindTooltip(stopLabel(s), { direction: 'top', offset: [0, -6] })
      .on('click', () => this.onClick(s))
    this.markers.set(s.id, m)
    if (this.visible(s)) {
      this.group.addLayer(m)
      m.bringToBack() // keep under a selected vehicle's route line
    }
  }

  private visible(s: StopRef): boolean {
    return !s.mode || this.modes.has(s.mode)
  }

  /** Re-apply `modes`. */
  refilter(): void {
    for (const [id, m] of this.markers) {
      const show = this.visible(this.stops.get(id)!)
      if (show && !this.group.hasLayer(m)) {
        this.group.addLayer(m)
        m.bringToBack()
      } else if (!show) this.group.removeLayer(m)
    }
  }

  /** Mark the stop whose board is open (null to clear). */
  setSelected(s: StopRef | null): void {
    this.highlight?.remove()
    this.highlight = null
    if (!s) return
    const c = s.mode ? COLORS[s.mode] : '#5d6874'
    this.highlight = L.circleMarker([s.lat, s.lng], {
      renderer: this.renderer,
      radius: 9,
      weight: 3,
      color: '#fff',
      fillColor: c,
      fillOpacity: 1,
      interactive: false,
    }).addTo(this.map)
  }
}

export function stopLabel(s: { name: string; code: string }): string {
  return `${escapeHtml(s.name)}${s.code ? ` <small>${escapeHtml(s.code)}</small>` : ''}`
}
