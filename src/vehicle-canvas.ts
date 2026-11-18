import L from 'leaflet'
import { COLORS } from './hfp'
import type { Mode } from './hfp'

/** Glide between position updates, which arrive about once a second. */
const MOVE_MS = 1000
const FADE_MS = 300
/** Vehicles move a few pixels per second, so only close up is 60 fps worth the battery. */
const SMOOTH_FROM_ZOOM = 16
const FRAME_MS = 1000 / 30
const SMOOTH_FRAME_MS = 1000 / 60
/** Allows for rAF jitter, so a 30 fps cap doesn't fall to 20 fps on a 60 Hz screen. */
const FRAME_SLACK_MS = 4
/** Off-screen margin in CSS px, big enough for the selected marker and its arrow. */
const CULL_PX = 50
/** Taps this close to a marker count as hitting it (CSS px). */
const TAP_PX = 8
/** A press that moves further than this is a drag, not a tap (CSS px). */
const DRAG_PX = 10
const MAX_PILLS = 512

const PILL_H = 24
const PILL_BORDER = 2
const PILL_PADDING = 5
const PILL_MIN_W = 24
const SEL_SCALE = 1.3
const SEL_RING = 3
const PILL_MARGIN = 14
const ARROW_W = 10
const ARROW_H = 8
const ARROW_DIST = 17
const SEL_ARROW_DIST = 24

/** A vehicle on the canvas. Coordinates are world pixels at zoom 0. */
export interface Sprite {
  mode: Mode
  label: string
  selected: boolean
  x0: number
  y0: number
  x1: number
  y1: number
  rot0: number | null
  rot1: number | null
  moved: number
  alpha0: number
  alpha1: number
  faded: number
}

/** A pre-rendered line label. */
interface Pill {
  img: HTMLCanvasElement
  w: number
  h: number
  halfW: number
  halfH: number
}

interface ArrowImage {
  img: HTMLCanvasElement
  w: number
  h: number
}

function pillPath(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  const r = h / 2
  c.beginPath()
  c.arc(x + r, y + r, r, Math.PI / 2, Math.PI * 1.5)
  c.arc(x + w - r, y + r, r, -Math.PI / 2, Math.PI / 2)
  c.closePath()
}

/**
 * Full vehicle markers (line label + heading arrow), all drawn on one canvas.
 *
 * With a DOM element per vehicle, every position update costs the browser style, paint
 * and compositing work per marker, which a phone can't keep up with when hundreds move
 * at once. Here labels are pre-rendered once and copied to a single canvas, off-screen
 * vehicles cost nothing, and nothing is drawn while nothing on screen moves.
 */
export class VehicleCanvas {
  private canvas = document.createElement('canvas')
  private ctx = this.canvas.getContext('2d')!
  private sprites = new Set<Sprite>()
  /** Draw order, bottom to top: further south on top, the selected vehicle above all. */
  private order: Array<Sprite> = []
  private orderStale = false
  private orderedAt = 0
  private pills = new Map<string, Pill>()
  private arrows = new Map<Mode, ArrowImage>()
  private dpr = 1
  private width = 0
  private height = 0
  private raf = 0
  private dirty = false
  private drawnAt = 0
  private animUntil = 0
  private zooming = false
  private posX = NaN
  private posY = NaN
  // The visible area in world pixels at zoom 0, as of the last draw.
  private viewX0 = 0
  private viewY0 = 0
  private viewX1 = 0
  private viewY1 = 0
  private reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
  private pressX = 0
  private pressY = 0

  constructor(
    private map: L.Map,
    private onTap: (s: Sprite) => void,
  ) {
    this.canvas.className = 'veh-canvas leaflet-zoom-animated'
    map.getPane('markerPane')!.appendChild(this.canvas)
    this.resize()
    map.on('resize', this.resize, this)
    map.on('move', this.onMove, this)
    map.on('zoomanim', this.onZoomAnim, this)
    map.on('zoomend', this.onZoomEnd, this)
    const el = map.getContainer()
    // Capture: a vehicle on top must win over the stops and lines on the canvas beneath it.
    el.addEventListener('click', this.onClick, true)
    el.addEventListener('pointerdown', this.onPointerDown, true)
    el.addEventListener('pointermove', this.onPointerMove, { passive: true })
  }

  add(mode: Mode, label: string, lat: number, lng: number, rot: number | null, alpha: number): Sprite {
    const p = this.map.project([lat, lng], 0)
    const s: Sprite = {
      mode,
      label,
      selected: false,
      x0: p.x,
      y0: p.y,
      x1: p.x,
      y1: p.y,
      rot0: rot,
      rot1: rot,
      moved: 0,
      alpha0: alpha,
      alpha1: alpha,
      faded: 0,
    }
    this.sprites.add(s)
    this.orderStale = true
    this.invalidate()
    return s
  }

  remove(s: Sprite): void {
    this.sprites.delete(s)
    this.orderStale = true
    this.invalidate()
  }

  /** Glide to a new position and heading. */
  move(s: Sprite, lat: number, lng: number, rot: number | null): void {
    const p = this.map.project([lat, lng], 0)
    if (p.x === s.x1 && p.y === s.y1 && (rot === s.rot1 || rot == null)) return
    const now = performance.now()
    const k = this.progress(s, now)
    const x = s.x0 + (s.x1 - s.x0) * k
    const y = s.y0 + (s.y1 - s.y0) * k
    const instant = this.reducedMotion.matches
    s.x0 = instant ? p.x : x
    s.y0 = instant ? p.y : y
    s.x1 = p.x
    s.y1 = p.y
    const turn = s.rot0 != null && s.rot1 != null ? s.rot0 + (s.rot1 - s.rot0) * k : s.rot1
    const next = rot ?? s.rot1
    s.rot0 = instant ? next : (turn ?? next)
    s.rot1 = next
    s.moved = now
    if (this.inView(x, y) || this.inView(p.x, p.y)) this.animate(now + MOVE_MS)
  }

  setLabel(s: Sprite, label: string): void {
    s.label = label
    this.invalidate()
  }

  /** Fade to an opacity and mark as selected or not. */
  setStyle(s: Sprite, alpha: number, selected: boolean): void {
    if (selected !== s.selected) {
      s.selected = selected
      this.orderStale = true
      this.invalidate()
    }
    if (alpha === s.alpha1) return
    const now = performance.now()
    s.alpha0 = this.reducedMotion.matches ? alpha : this.alphaAt(s, now)
    s.alpha1 = alpha
    s.faded = now
    this.animate(now + FADE_MS)
  }

  private progress(s: Sprite, now: number): number {
    return Math.min(1, (now - s.moved) / MOVE_MS)
  }

  private alphaAt(s: Sprite, now: number): number {
    return s.alpha0 + (s.alpha1 - s.alpha0) * Math.min(1, (now - s.faded) / FADE_MS)
  }

  private inView(x: number, y: number): boolean {
    return x >= this.viewX0 && x <= this.viewX1 && y >= this.viewY0 && y <= this.viewY1
  }

  /** Something changed that needs one redraw. */
  private invalidate(): void {
    this.dirty = true
    this.wake()
  }

  /** Keep drawing until the given time. */
  private animate(until: number): void {
    if (until > this.animUntil) this.animUntil = until
    this.wake()
  }

  private wake(): void {
    if (!this.raf && !this.zooming) this.raf = requestAnimationFrame(this.frame)
  }

  private frame = (now: number): void => {
    this.raf = 0
    if (this.zooming) return
    const interval = this.map.getZoom() >= SMOOTH_FROM_ZOOM ? SMOOTH_FRAME_MS : FRAME_MS
    // Always draw the last frame, so a glide can't stop just short of its end.
    const last = now >= this.animUntil
    if (this.dirty || last || now - this.drawnAt >= interval - FRAME_SLACK_MS) this.draw(now)
    if (!last) this.wake()
  }

  private resize(): void {
    const size = this.map.getSize()
    this.width = size.x
    this.height = size.y
    const dpr = Math.min(devicePixelRatio || 1, 3)
    if (dpr !== this.dpr) {
      this.dpr = dpr
      this.pills.clear()
      this.arrows.clear()
    }
    this.canvas.width = Math.round(size.x * dpr)
    this.canvas.height = Math.round(size.y * dpr)
    this.canvas.style.width = `${size.x}px`
    this.canvas.style.height = `${size.y}px`
    this.invalidate()
  }

  /** Drawn right here, not on the next frame, so markers stay glued to the map while panning. */
  private onMove(): void {
    if (this.zooming) return
    const now = performance.now()
    this.draw(now)
    // Vehicles that just came into view may still be mid-glide.
    this.animate(now + MOVE_MS)
  }

  /** Scale the last drawn frame along with the map; see L.Renderer for the same technique. */
  private onZoomAnim(e: L.ZoomAnimEvent): void {
    const map = this.map
    this.zooming = true
    const panePos = map.containerPointToLayerPoint([0, 0]).multiplyBy(-1)
    const origin = map.project(e.center, e.zoom).subtract(map.getSize().divideBy(2)).add(panePos).round()
    const offset = map.project(map.containerPointToLatLng([0, 0]), e.zoom).subtract(origin)
    L.DomUtil.setTransform(this.canvas, offset, map.getZoomScale(e.zoom, map.getZoom()))
  }

  private onZoomEnd(): void {
    this.zooming = false
    this.posX = NaN // the zoom transform replaced the canvas position
    const now = performance.now()
    this.draw(now)
    this.animate(now + MOVE_MS)
  }

  /** Current on-screen centre of a sprite, in CSS px from the map's top-left corner. */
  private screenX(s: Sprite, k: number, scale: number, originX: number): number {
    return (s.x0 + (s.x1 - s.x0) * k) * scale - originX
  }

  private screenY(s: Sprite, k: number, scale: number, originY: number): number {
    return (s.y0 + (s.y1 - s.y0) * k) * scale - originY
  }

  /** Top-left corner of the map in pixels at the current zoom. */
  private origin(): L.Point {
    return this.map.getPixelOrigin().add(this.map.containerPointToLayerPoint([0, 0]))
  }

  private sort(now: number): void {
    // Vehicles change places slowly: once a second is enough unless the set changed.
    if (!this.orderStale && now - this.orderedAt < 1000) return
    this.order = [...this.sprites].sort(
      (a, b) => Number(a.selected) - Number(b.selected) || a.y1 - b.y1,
    )
    this.orderStale = false
    this.orderedAt = now
  }

  private draw(now: number): void {
    const { ctx, dpr, width, height } = this
    this.dirty = false
    this.drawnAt = now
    this.sort(now)

    // The canvas lives in the map pane: pin it to the viewport.
    const topLeft = this.map.containerPointToLayerPoint([0, 0])
    if (topLeft.x !== this.posX || topLeft.y !== this.posY) {
      this.posX = topLeft.x
      this.posY = topLeft.y
      L.DomUtil.setPosition(this.canvas, topLeft)
    }

    const scale = this.map.getZoomScale(this.map.getZoom(), 0)
    const origin = this.origin()
    this.viewX0 = (origin.x - CULL_PX) / scale
    this.viewY0 = (origin.y - CULL_PX) / scale
    this.viewX1 = (origin.x + width + CULL_PX) / scale
    this.viewY1 = (origin.y + height + CULL_PX) / scale

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    for (const s of this.order) {
      const k = this.progress(s, now)
      const x = this.screenX(s, k, scale, origin.x)
      const y = this.screenY(s, k, scale, origin.y)
      if (x < -CULL_PX || x > width + CULL_PX || y < -CULL_PX || y > height + CULL_PX) continue
      ctx.globalAlpha = this.alphaAt(s, now)
      if (s.rot1 != null) {
        const arrow = this.arrow(s.mode)
        const deg = s.rot0 == null ? s.rot1 : s.rot0 + (s.rot1 - s.rot0) * k
        const rad = (deg * Math.PI) / 180
        const cos = Math.cos(rad) * dpr
        const sin = Math.sin(rad) * dpr
        ctx.setTransform(cos, sin, -sin, cos, x * dpr, y * dpr)
        const dist = s.selected ? SEL_ARROW_DIST : ARROW_DIST
        ctx.drawImage(arrow.img, -arrow.w / 2, -dist - arrow.h / 2, arrow.w, arrow.h)
      }
      const pill = this.pill(s)
      // Whole device pixels keep the text sharp while it glides.
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.drawImage(pill.img, Math.round((x - pill.w / 2) * dpr), Math.round((y - pill.h / 2) * dpr))
    }
    ctx.globalAlpha = 1
  }

  private pill(s: Sprite): Pill {
    const key = `${s.mode}|${s.selected ? 1 : 0}|${s.label}`
    let p = this.pills.get(key)
    if (!p) {
      if (this.pills.size >= MAX_PILLS) this.pills.clear()
      p = this.renderPill(s.mode, s.label, s.selected)
      this.pills.set(key, p)
    }
    return p
  }

  private renderPill(mode: Mode, label: string, selected: boolean): Pill {
    const font = '700 11px system-ui, sans-serif'
    const img = document.createElement('canvas')
    const c = img.getContext('2d')!
    c.font = font
    const textW = Math.ceil(c.measureText(label).width)
    const pillW = Math.max(PILL_MIN_W, textW + 2 * (PILL_PADDING + PILL_BORDER))
    const zoom = selected ? SEL_SCALE : 1
    const w = pillW * zoom + 2 * PILL_MARGIN
    const h = PILL_H * zoom + 2 * PILL_MARGIN
    const dpr = this.dpr
    img.width = Math.ceil(w * dpr)
    img.height = Math.ceil(h * dpr)
    const cssW = img.width / dpr
    const cssH = img.height / dpr
    c.scale(dpr, dpr)
    c.translate(cssW / 2, cssH / 2)
    c.scale(zoom, zoom)
    const x = -pillW / 2
    const y = -PILL_H / 2
    const color = COLORS[mode]
    if (selected) {
      c.shadowColor = 'rgba(0,0,0,.4)'
      c.shadowBlur = 8 * dpr
      c.shadowOffsetY = 2 * dpr
      c.fillStyle = color
      pillPath(c, x - SEL_RING, y - SEL_RING, pillW + 2 * SEL_RING, PILL_H + 2 * SEL_RING)
      c.fill()
    } else {
      c.shadowColor = 'rgba(0,0,0,.35)'
      c.shadowBlur = 3 * dpr
      c.shadowOffsetY = dpr
    }
    c.fillStyle = '#fff'
    pillPath(c, x, y, pillW, PILL_H)
    c.fill()
    c.shadowColor = 'transparent'
    c.fillStyle = color
    pillPath(c, x + PILL_BORDER, y + PILL_BORDER, pillW - 2 * PILL_BORDER, PILL_H - 2 * PILL_BORDER)
    c.fill()
    c.font = font
    c.fillStyle = '#fff'
    c.textAlign = 'center'
    c.textBaseline = 'middle'
    c.fillText(label, 0, 0.5)
    const ring = selected ? SEL_RING : 0
    return {
      img,
      w: cssW,
      h: cssH,
      halfW: ((pillW + 2 * ring) * zoom) / 2,
      halfH: ((PILL_H + 2 * ring) * zoom) / 2,
    }
  }

  private arrow(mode: Mode): ArrowImage {
    let a = this.arrows.get(mode)
    if (!a) {
      // A transparent edge keeps the rotated triangle's sides smooth.
      const edge = 1
      const w = ARROW_W + 2 * edge
      const h = ARROW_H + 2 * edge
      const img = document.createElement('canvas')
      img.width = Math.ceil(w * this.dpr)
      img.height = Math.ceil(h * this.dpr)
      const c = img.getContext('2d')!
      c.scale(img.width / w, img.height / h)
      c.fillStyle = COLORS[mode]
      c.beginPath()
      c.moveTo(edge + ARROW_W / 2, edge)
      c.lineTo(edge + ARROW_W, edge + ARROW_H)
      c.lineTo(edge, edge + ARROW_H)
      c.closePath()
      c.fill()
      a = { img, w, h }
      this.arrows.set(mode, a)
    }
    return a
  }

  /** The marker at a map position: the closest one, the topmost if they overlap. */
  private hit(px: number, py: number): Sprite | null {
    const now = performance.now()
    this.sort(now)
    const scale = this.map.getZoomScale(this.map.getZoom(), 0)
    const origin = this.origin()
    let best: Sprite | null = null
    let bestDist = Infinity
    for (let i = this.order.length - 1; i >= 0; i--) {
      const s = this.order[i]
      const k = this.progress(s, now)
      const pill = this.pill(s)
      const dx = Math.abs(this.screenX(s, k, scale, origin.x) - px) - pill.halfW
      const dy = Math.abs(this.screenY(s, k, scale, origin.y) - py) - pill.halfH
      if (dx > TAP_PX || dy > TAP_PX) continue
      const dist = Math.max(dx, dy, 0)
      if (dist < bestDist) {
        best = s
        bestDist = dist
      }
    }
    return best
  }

  private eventPoint(e: MouseEvent): L.Point {
    return this.map.mouseEventToContainerPoint(e)
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.pressX = e.clientX
    this.pressY = e.clientY
  }

  private onClick = (e: MouseEvent): void => {
    if ((e.target as Element).closest('.leaflet-control')) return
    if (Math.hypot(e.clientX - this.pressX, e.clientY - this.pressY) > DRAG_PX) return
    const p = this.eventPoint(e)
    const s = this.hit(p.x, p.y)
    if (!s) return
    e.stopPropagation()
    this.onTap(s)
  }

  /** Mice only: show that a marker can be clicked. */
  private onPointerMove = (e: PointerEvent): void => {
    if (e.pointerType !== 'mouse') return
    const p = this.eventPoint(e)
    const over = !e.buttons && !this.zooming && this.hit(p.x, p.y) !== null
    this.map.getContainer().classList.toggle('veh-hover', over)
  }
}
