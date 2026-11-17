/**
 * Tiny MQTT 3.1.1 subscriber over WebSocket (~2 KB instead of mqtt.js's ~90 KB).
 * Supports only what this app needs: CONNECT, SUBSCRIBE/UNSUBSCRIBE (QoS 0),
 * incoming PUBLISH, keepalive pings and automatic reconnect.
 */

export type MqttStatus = 'connecting' | 'online' | 'offline'

const enc = new TextEncoder()
const dec = new TextDecoder()

function varLen(n: number): Array<number> {
  const out: Array<number> = []
  do {
    let b = n % 128
    n = Math.floor(n / 128)
    if (n > 0) b |= 128
    out.push(b)
  } while (n > 0)
  return out
}

function utf8(s: string): Array<number> {
  const b = enc.encode(s)
  return [b.length >> 8, b.length & 255, ...b]
}

function packet(header: number, body: Array<number>): Uint8Array {
  return new Uint8Array([header, ...varLen(body.length), ...body])
}

export function connectPacket(clientId: string, keepalive: number): Uint8Array {
  return packet(0x10, [
    ...utf8('MQTT'),
    4, // protocol level 3.1.1
    0x02, // clean session
    keepalive >> 8,
    keepalive & 255,
    ...utf8(clientId),
  ])
}

export function subscribePacket(id: number, topics: Array<string>): Uint8Array {
  const body = [id >> 8, id & 255]
  for (const t of topics) body.push(...utf8(t), 0)
  return packet(0x82, body)
}

export function unsubscribePacket(id: number, topics: Array<string>): Uint8Array {
  const body = [id >> 8, id & 255]
  for (const t of topics) body.push(...utf8(t))
  return packet(0xa2, body)
}

const PINGREQ = new Uint8Array([0xc0, 0])

const KEEPALIVE_S = 30
const PING_MS = 15_000
/**
 * Declare the connection dead after this long without any bytes from the broker. A healthy
 * broker answers every PINGREQ, so this is about two missed pings. Needed because mobile
 * network changes often leave a WebSocket half-open: no close event for minutes.
 */
const DEAD_MS = 40_000

export class MqttClient {
  status: MqttStatus = 'offline'
  private ws: WebSocket | null = null
  private buf: Uint8Array = new Uint8Array(0)
  private wanted = new Set<string>()
  private active = new Set<string>()
  private pid = 0
  private retries = 0
  private lastRx = 0
  private running = false
  private pingTimer: ReturnType<typeof setInterval> | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private connectTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private url: string,
    private onMessage: (topic: string, payload: Uint8Array) => void,
    private onStatus: (s: MqttStatus) => void = () => {},
  ) {}

  start(): void {
    if (this.running) return
    this.running = true
    this.open()
  }

  stop(): void {
    this.running = false
    clearTimeout(this.retryTimer)
    this.teardown()
    this.setStatus('offline')
  }

  /** Declare the full set of topic filters wanted; the diff is sent to the broker. */
  setTopics(topics: Iterable<string>): void {
    this.wanted = new Set(topics)
    this.sync()
  }

  private sync(): void {
    if (this.status !== 'online' || !this.ws) return
    const remove = [...this.active].filter((t) => !this.wanted.has(t))
    const add = [...this.wanted].filter((t) => !this.active.has(t))
    // Chunk to keep packets small.
    for (let i = 0; i < remove.length; i += 50)
      this.send(unsubscribePacket(this.nextId(), remove.slice(i, i + 50)))
    for (let i = 0; i < add.length; i += 50)
      this.send(subscribePacket(this.nextId(), add.slice(i, i + 50)))
    this.active = new Set(this.wanted)
  }

  private nextId(): number {
    this.pid = (this.pid % 65535) + 1
    return this.pid
  }

  private send(p: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(p)
  }

  private setStatus(s: MqttStatus): void {
    if (s === this.status) return
    this.status = s
    this.onStatus(s)
  }

  private open(): void {
    this.setStatus('connecting')
    this.buf = new Uint8Array(0)
    this.active.clear()
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url, 'mqtt')
    } catch {
      this.scheduleRetry()
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    const id = 'rthsl-' + Math.random().toString(36).slice(2, 10)
    ws.onopen = () => ws.send(connectPacket(id, KEEPALIVE_S))
    ws.onmessage = (e) => {
      this.lastRx = Date.now()
      this.feed(new Uint8Array(e.data as ArrayBuffer))
    }
    ws.onerror = () => ws.close()
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.teardown()
      if (this.running) this.scheduleRetry()
    }
    this.connectTimer = setTimeout(() => {
      if (this.status !== 'online') ws.close()
    }, 10000)
  }

  private teardown(): void {
    clearInterval(this.pingTimer)
    clearTimeout(this.connectTimer)
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    }
    if (this.running) this.setStatus('connecting')
  }

  private scheduleRetry(): void {
    this.setStatus('connecting')
    // Jitter, so clients don't all reconnect in lockstep after a broker restart.
    const delay = Math.min(1000 * 2 ** this.retries, 15000) * (0.75 + Math.random() * 0.5)
    this.retries++
    clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => this.running && this.open(), delay)
  }

  /** Ping the broker, or drop and reconnect if it has gone silent. */
  private keepalive(): void {
    if (Date.now() - this.lastRx > DEAD_MS) {
      // Don't wait for the dead socket's close event: tear down and reconnect now.
      this.teardown()
      if (this.running) this.scheduleRetry()
      return
    }
    this.send(PINGREQ)
  }

  private feed(chunk: Uint8Array): void {
    if (this.buf.length === 0) {
      this.buf = chunk
    } else {
      const merged = new Uint8Array(this.buf.length + chunk.length)
      merged.set(this.buf)
      merged.set(chunk, this.buf.length)
      this.buf = merged
    }
    for (;;) {
      const buf = this.buf
      if (buf.length < 2) return
      let len = 0
      let mul = 1
      let i = 1
      let b: number
      do {
        if (i >= buf.length) return
        b = buf[i++]
        len += (b & 127) * mul
        mul *= 128
      } while (b & 128)
      if (buf.length < i + len) return
      this.handle(buf[0], buf.subarray(i, i + len))
      this.buf = buf.subarray(i + len)
    }
  }

  private handle(header: number, body: Uint8Array): void {
    switch (header >> 4) {
      case 2: // CONNACK
        clearTimeout(this.connectTimer)
        if (body[1] !== 0) {
          this.ws?.close()
          return
        }
        this.retries = 0
        this.setStatus('online')
        this.lastRx = Date.now()
        this.pingTimer = setInterval(() => this.keepalive(), PING_MS)
        this.sync()
        return
      case 3: {
        // PUBLISH
        const qos = (header >> 1) & 3
        const tl = (body[0] << 8) | body[1]
        const topic = dec.decode(body.subarray(2, 2 + tl))
        let off = 2 + tl
        if (qos > 0) {
          this.send(new Uint8Array([0x40, 2, body[off], body[off + 1]])) // PUBACK
          off += 2
        }
        this.onMessage(topic, body.subarray(off))
        return
      }
      default:
      // SUBACK, UNSUBACK, PINGRESP: nothing to do
    }
  }
}
