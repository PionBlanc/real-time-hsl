import L from 'leaflet'
import { COLORS } from './hfp'
import type { Msg } from './hfp'

/** Full marker: DOM element with line label, heading arrow and smooth movement. */
interface Dom {
  marker: L.Marker
  el: HTMLElement
  label: HTMLElement
  arrow: HTMLElement
}

interface V {
  msg: Msg
  dom: Dom | null
  /** Compact marker: a plain dot on the shared canvas, used when zoomed out. */
  dot: L.CircleMarker | null
  dotOpacity: number
  last: number
  stale: boolean
  rot: number | null // unwrapped heading, so 350°→10° turns 20°, not 340°
  sameLine: boolean
}

const STALE_MS = 30_000
const REMOVE_MS = 120_000

/**
 * Vehicle markers. Updates are batched per animation frame; movement between
 * 1 Hz updates is smoothed with a CSS transform transition (see styles.css).
 *
 * In compact mode (zoomed out, often 1000+ vehicles) they are drawn as dots on a
 * canvas instead: one element instead of a DOM node per vehicle, no labels, no
 * animation. The selected vehicle always keeps its full marker.
 */
export class Vehicles {
  private all = new Map<string, V>()
  private pending = new Map<string, Msg>()
  private raf = 0
  private selected: string | null = null
  private compact = false
  /** New vehicles outside this area are ignored (null = accept everything). */
  area: L.LatLngBounds | null = null
  filter: (m: Msg) => boolean = () => true
  /** Vehicles kept regardless of `area` (e.g. searched by vehicle number). */
  anywhere: (m: Msg) => boolean = () => false

  constructor(
    private map: L.Map,
    private renderer: L.Renderer,
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

  /** Switch between full markers and canvas dots. */
  setCompact(on: boolean): void {
    if (on === this.compact) return
    this.compact = on
    for (const v of this.all.values()) this.render(v)
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
      if (!isSel && this.area && !this.anywhere(m) && !this.area.contains([m.lat, m.lng])) return
      v = { msg: m, dom: null, dot: null, dotOpacity: 1, last: 0, stale: false, rot: null, sameLine: false }
      v.sameLine = this.isSameLine(m.id, m)
      this.all.set(m.id, v)
    }
    const prevDesi = v.msg.desi
    const wasStale = v.stale
    v.msg = m
    v.last = Date.now()
    v.stale = false
    // Heading is noise while standing still; keep the last good one.
    const turned = m.hdg != null && (m.spd ?? 0) > 0.5
    if (turned) v.rot = v.rot == null ? m.hdg! : v.rot + ((((m.hdg! - v.rot) % 360) + 540) % 360) - 180

    if (v.dom) {
      v.dom.marker.setLatLng([m.lat, m.lng])
      if (prevDesi !== m.desi) v.dom.label.textContent = m.desi || '?'
      if (turned) this.setArrow(v.dom, v.rot)
      if (wasStale) v.dom.el.classList.remove('stale')
    } else if (v.dot) {
      v.dot.setLatLng([m.lat, m.lng])
      if (wasStale) this.styleDot(v)
    } else {
      this.render(v) // new vehicle
    }
    if (isSel) this.onSelectedUpdate(m)
  }

  private isSameLine(id: string, m: Msg): boolean {
    const sel = this.selected ? this.all.get(this.selected) : undefined
    return !!sel && id !== this.selected && m.desi.toUpperCase() === sel.msg.desi.toUpperCase()
  }

  /** Give v the right kind of marker for the current mode, styled for its current state. */
  private render(v: V): void {
    if (!this.compact || v.msg.id === this.selected) {
      if (v.dot) {
        v.dot.remove()
        v.dot = null
      }
      v.dom ??= this.createDom(v)
      this.styleDom(v)
    } else {
      if (v.dom) {
        v.dom.marker.remove()
        v.dom = null
      }
      v.dot ??= this.createDot(v)
      this.styleDot(v)
    }
  }

  private createDom(v: V): Dom {
    const m = v.msg
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
    const dom = { marker, el: marker.getElement()!, label, arrow }
    this.setArrow(dom, v.rot)
    return dom
  }

  private setArrow(dom: Dom, rot: number | null): void {
    if (rot == null) return
    dom.arrow.style.setProperty('--h', `${rot}deg`)
    dom.arrow.style.display = ''
  }

  private styleDom(v: V): void {
    const d = v.dom!
    const sel = v.msg.id === this.selected
    d.el.classList.toggle('sel', sel)
    d.el.classList.toggle('same-line', v.sameLine)
    d.el.classList.toggle('stale', v.stale)
    d.marker.setZIndexOffset(sel ? 10000 : 0)
  }

  private createDot(v: V): L.CircleMarker {
    const id = v.msg.id
    v.dotOpacity = 1
    return L.circleMarker([v.msg.lat, v.msg.lng], {
      renderer: this.renderer,
      radius: 4,
      weight: 1.5,
      color: '#fff',
      fillColor: COLORS[v.msg.mode],
      fillOpacity: 1,
      bubblingMouseEvents: false, // don't also trigger the map's "close" click
    })
      .on('click', () => this.onClick(id))
      .addTo(this.map)
  }

  /** Same dimming rules as the CSS for full markers (stale, other lines while one is selected). */
  private styleDot(v: V): void {
    const o = v.stale ? 0.4 : this.selected && !v.sameLine ? 0.3 : 1
    if (o === v.dotOpacity) return
    v.dotOpacity = o
    v.dot!.setStyle({ opacity: o, fillOpacity: o })
  }

  private remove(id: string): void {
    const v = this.all.get(id)
    if (!v) return
    v.dom?.marker.remove()
    v.dot?.remove()
    this.all.delete(id)
  }

  setSelected(id: string | null): void {
    this.selected = id
    for (const [vid, v] of this.all) {
      v.sameLine = this.isSameLine(vid, v.msg)
      this.render(v) // the (de)selected vehicle may switch between dot and full marker
    }
  }

  /** Re-apply the filter to existing markers. */
  refilter(): void {
    for (const [id, v] of this.all)
      if (id !== this.selected && !this.filter(v.msg)) this.remove(id)
  }

  /** Drop vehicles outside the given bounds (they no longer get updates); null drops all. */
  prune(bounds: L.LatLngBounds | null): void {
    for (const [id, v] of this.all)
      if (id !== this.selected && !this.anywhere(v.msg) && !bounds?.contains([v.msg.lat, v.msg.lng]))
        this.remove(id)
  }

  markAllStale(): void {
    for (const v of this.all.values()) this.setStale(v)
  }

  private setStale(v: V): void {
    v.stale = true
    if (v.dom) v.dom.el.classList.add('stale')
    else if (v.dot) this.styleDot(v)
  }

  private sweep(): void {
    const now = Date.now()
    for (const [id, v] of this.all) {
      const age = now - v.last
      if (age > REMOVE_MS && id !== this.selected) this.remove(id)
      else if (age > STALE_MS && !v.stale) this.setStale(v)
    }
  }
}
