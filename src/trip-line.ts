import L from 'leaflet'
import type { Trip } from './api'

type LL = [number, number]

/** Squared distance in a local equirectangular projection (fine at city scale). */
function d2(a: LL, b: LL, k: number): number {
  const dy = a[0] - b[0]
  const dx = (a[1] - b[1]) * k
  return dx * dx + dy * dy
}

/** Closest point to p on segment ab, plus its squared distance. */
function project(p: LL, a: LL, b: LL, k: number): { pt: LL; d: number } {
  const ax = a[1] * k
  const bx = b[1] * k
  const px = p[1] * k
  const vx = bx - ax
  const vy = b[0] - a[0]
  const len = vx * vx + vy * vy
  let t = len ? ((px - ax) * vx + (p[0] - a[0]) * vy) / len : 0
  t = Math.max(0, Math.min(1, t))
  const pt: LL = [a[0] + vy * t, a[1] + (b[1] - a[1]) * t]
  return { pt, d: d2(p, pt, k) }
}

/**
 * Draws a trip's path split at the vehicle: driven part greyed out, the part
 * ahead bold in the line colour, with stop dots (tap a dot for its name).
 */
export class TripLine {
  private renderer = L.canvas({ tolerance: 10 })
  private group = L.layerGroup()
  private behind: L.Polyline
  private casing: L.Polyline
  private ahead: L.Polyline
  private stopDots: Array<L.CircleMarker> = []
  private trip: Trip | null = null
  private stopIdx: Array<number> = [] // nearest shape index for each stop
  private k = 0.5
  private color = '#007AC9'
  private nextK = -2

  constructor(private map: L.Map) {
    const r = this.renderer
    this.behind = L.polyline([], { renderer: r, color: '#8a94a0', weight: 4, opacity: 0.55, interactive: false })
    this.casing = L.polyline([], { renderer: r, color: '#fff', weight: 9, opacity: 0.9, interactive: false })
    this.ahead = L.polyline([], { renderer: r, weight: 5, opacity: 0.95, interactive: false })
    this.group.addLayer(this.behind).addLayer(this.casing).addLayer(this.ahead)
  }

  show(trip: Trip, color: string): void {
    this.clear()
    this.trip = trip
    this.color = color
    this.nextK = -2
    const shape = trip.shape
    this.k = Math.cos(((shape[0]?.[0] ?? 60) * Math.PI) / 180)
    // Map each stop to its nearest shape vertex, walking forward so loops resolve correctly.
    let from = 0
    this.stopIdx = trip.stops.map((s) => {
      let best = from
      let bd = Infinity
      for (let i = from; i < shape.length; i++) {
        const d = d2([s.lat, s.lng], shape[i], this.k)
        if (d < bd) {
          bd = d
          best = i
        }
      }
      from = best
      return best
    })
    this.ahead.setStyle({ color })
    this.behind.setLatLngs([])
    this.casing.setLatLngs(shape)
    this.ahead.setLatLngs(shape)
    this.stopDots = trip.stops.map((s) =>
      L.circleMarker([s.lat, s.lng], {
        renderer: this.renderer,
        radius: 4,
        weight: 2,
        color,
        fillColor: '#fff',
        fillOpacity: 1,
        bubblingMouseEvents: false,
      })
        .bindTooltip(`${escapeHtml(s.name)}${s.code ? ` <small>${escapeHtml(s.code)}</small>` : ''}`, {
          direction: 'top',
          offset: [0, -6],
        })
        .on('click', (e) => (e.target as L.CircleMarker).openTooltip()),
    )
    for (const d of this.stopDots) this.group.addLayer(d)
    this.group.addTo(this.map)
  }

  /** Re-split the line at the vehicle's position. nextStop: HFP next stop id. */
  update(lat: number, lng: number, nextStop: string): void {
    const trip = this.trip
    if (!trip || trip.shape.length < 2) return
    const shape = trip.shape
    const n = shape.length
    let k = trip.stops.findIndex((s) => s.id === nextStop)
    if (nextStop === 'EOL') k = trip.stops.length
    // Only look between the previous and next stop, so loops can't confuse it.
    let a = 0
    let b = n - 1
    if (k >= 0) {
      a = k > 0 ? this.stopIdx[Math.min(k, this.stopIdx.length) - 1] : 0
      b = k < this.stopIdx.length ? this.stopIdx[k] : n - 1
      a = Math.max(0, a - 3)
      b = Math.min(n - 1, Math.max(b + 3, a + 1))
    }
    const p: LL = [lat, lng]
    let best = { i: a, pt: shape[a] as LL, d: Infinity }
    for (let i = a; i < b; i++) {
      const r = project(p, shape[i], shape[i + 1], this.k)
      if (r.d < best.d) best = { i, pt: r.pt, d: r.d }
    }
    const behind = shape.slice(0, best.i + 1).concat([best.pt])
    const ahead = [best.pt as LL].concat(shape.slice(best.i + 1))
    this.behind.setLatLngs(behind)
    this.casing.setLatLngs(ahead)
    this.ahead.setLatLngs(ahead)
    if (k !== this.nextK) {
      this.nextK = k
      this.stopDots.forEach((d, i) => {
        const passed = k >= 0 && i < k
        d.setStyle({ color: passed ? '#8a94a0' : this.color, fillColor: i === k ? this.color : '#fff' })
        d.setRadius(i === k ? 6 : passed ? 3 : 4)
      })
    }
  }

  clear(): void {
    this.group.remove()
    for (const d of this.stopDots) this.group.removeLayer(d)
    this.stopDots = []
    this.trip = null
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}
