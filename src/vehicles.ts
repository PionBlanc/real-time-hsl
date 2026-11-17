import L from 'leaflet'
import { COLORS } from './hfp'
import type { Msg } from './hfp'

interface V {
  msg: Msg
  marker: L.Marker
  el: HTMLElement
  label: HTMLElement
  arrow: HTMLElement
  last: number
  stale: boolean
  rot: number | null // unwrapped heading, so 350°→10° turns 20°, not 340°
}

const STALE_MS = 30_000
const REMOVE_MS = 120_000

/**
 * Vehicle markers. Updates are batched per animation frame; movement between
 * 1 Hz updates is smoothed with a CSS transform transition (see styles.css).
 */
export class Vehicles {
  private all = new Map<string, V>()
  private pending = new Map<string, Msg>()
  private raf = 0
  private selected: string | null = null
  /** New vehicles outside this area are ignored (null = accept everything). */
  area: L.LatLngBounds | null = null
  filter: (m: Msg) => boolean = () => true

  constructor(
    private map: L.Map,
    private onClick: (id: string) => void,
    private onSelectedUpdate: (m: Msg) => void,
  ) {
    setInterval(() => this.sweep(), 5000)
  }

  get(id: string): Msg | undefined {
    return this.all.get(id)?.msg
  }

  visible(): Array<Msg> {
    return [...this.all.values()].map((v) => v.msg)
  }

  push(m: Msg): void {
    this.pending.set(m.id, m)
    if (!this.raf) this.raf = requestAnimationFrame(() => this.flush())
  }

  private flush(): void {
    this.raf = 0
    const batch = this.pending
    this.pending = new Map()
    for (const m of batch.values()) this.apply(m)
  }

  private apply(m: Msg): void {
    const isSel = m.id === this.selected
    let v = this.all.get(m.id)
    if (!isSel && !this.filter(m)) {
      if (v) this.remove(m.id)
      return
    }
    if (!v) {
      if (!isSel && this.area && !this.area.contains([m.lat, m.lng])) return
      v = this.create(m)
    } else {
      v.marker.setLatLng([m.lat, m.lng])
      if (v.msg.desi !== m.desi) v.label.textContent = m.desi || '?'
    }
    // Heading is noise while standing still; keep the last good one.
    if (m.hdg != null && (m.spd ?? 0) > 0.5) {
      v.rot = v.rot == null ? m.hdg : v.rot + ((((m.hdg - v.rot) % 360) + 540) % 360) - 180
      v.arrow.style.setProperty('--h', `${v.rot}deg`)
      v.arrow.style.display = ''
    }
    v.msg = m
    v.last = Date.now()
    if (v.stale) {
      v.stale = false
      v.el.classList.remove('stale')
    }
    if (isSel) this.onSelectedUpdate(m)
  }

  private create(m: Msg): V {
    const wrap = document.createElement('span')
    wrap.className = 'w'
    wrap.style.setProperty('--c', COLORS[m.mode])
    const arrow = document.createElement('i')
    arrow.style.display = 'none'
    const label = document.createElement('b')
    label.textContent = m.desi || '?'
    wrap.append(arrow, label)
    const marker = L.marker([m.lat, m.lng], {
      icon: L.divIcon({
        className: `veh ${m.mode}`,
        html: wrap,
        iconSize: null as unknown as L.PointExpression,
      }),
      keyboard: false,
    })
    marker.on('click', () => this.onClick(m.id))
    marker.addTo(this.map)
    const el = marker.getElement()!
    const v: V = { msg: m, marker, el, label, arrow, last: Date.now(), stale: false, rot: null }
    this.all.set(m.id, v)
    if (m.id === this.selected) {
      el.classList.add('sel')
      marker.setZIndexOffset(10000)
    }
    return v
  }

  private remove(id: string): void {
    const v = this.all.get(id)
    if (!v) return
    v.marker.remove()
    this.all.delete(id)
  }

  setSelected(id: string | null): void {
    const prev = this.selected && this.all.get(this.selected)
    if (prev) {
      prev.el.classList.remove('sel')
      prev.marker.setZIndexOffset(0)
    }
    this.selected = id
    const cur = id && this.all.get(id)
    if (cur) {
      cur.el.classList.add('sel')
      cur.marker.setZIndexOffset(10000)
    }
  }

  /** Re-apply the filter to existing markers. */
  refilter(): void {
    for (const [id, v] of this.all)
      if (id !== this.selected && !this.filter(v.msg)) this.remove(id)
  }

  /** Drop vehicles outside the given bounds (they no longer get updates). */
  prune(bounds: L.LatLngBounds): void {
    for (const [id, v] of this.all)
      if (id !== this.selected && !bounds.contains([v.msg.lat, v.msg.lng])) this.remove(id)
  }

  markAllStale(): void {
    for (const v of this.all.values()) {
      v.stale = true
      v.el.classList.add('stale')
    }
  }

  private sweep(): void {
    const now = Date.now()
    for (const [id, v] of this.all) {
      const age = now - v.last
      if (age > REMOVE_MS && id !== this.selected) this.remove(id)
      else if (age > STALE_MS && !v.stale) {
        v.stale = true
        v.el.classList.add('stale')
      }
    }
  }
}
