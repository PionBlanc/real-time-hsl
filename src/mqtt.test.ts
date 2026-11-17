import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MqttClient } from './mqtt'

/** Minimal WebSocket stand-in that records instances and sent packets. */
class FakeWS {
  static OPEN = 1
  static all: Array<FakeWS> = []
  readyState = 1
  binaryType = ''
  sent: Array<Uint8Array> = []
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  constructor() {
    FakeWS.all.push(this)
  }
  send(p: Uint8Array) {
    this.sent.push(p)
  }
  close() {
    this.closed = true
  }
  receive(bytes: Array<number>) {
    this.onmessage?.({ data: new Uint8Array(bytes).buffer })
  }
}

const CONNACK = [0x20, 2, 0, 0]
const PINGRESP = [0xd0, 0]
const isPing = (p: Uint8Array) => p[0] === 0xc0

/** Stand-in for window's online/offline events and navigator.onLine. */
let net = new EventTarget()
const nav = { onLine: true }
function goOffline() {
  nav.onLine = false
  net.dispatchEvent(new Event('offline'))
}
function goOnline() {
  nav.onLine = true
  net.dispatchEvent(new Event('online'))
}

describe('MqttClient', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWS.all = []
    nav.onLine = true
    net = new EventTarget()
    vi.stubGlobal('WebSocket', FakeWS)
    vi.stubGlobal('navigator', nav)
    vi.stubGlobal('addEventListener', net.addEventListener.bind(net))
    vi.stubGlobal('removeEventListener', net.removeEventListener.bind(net))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function connect() {
    const statuses: Array<string> = []
    const c = new MqttClient('wss://x', () => {}, (s) => statuses.push(s))
    c.start()
    const ws = FakeWS.all.at(-1)!
    ws.onopen?.()
    ws.receive(CONNACK)
    return { c, ws, statuses }
  }

  it('stays online on a quiet subscription while the broker answers pings', () => {
    const { c, ws } = connect()
    let answered = 0
    for (let t = 0; t < 60_000; t += 1_000) {
      vi.advanceTimersByTime(1_000)
      const pings = ws.sent.filter(isPing).length
      while (answered < pings) {
        ws.receive(PINGRESP)
        answered++
      }
    }
    expect(answered).toBeGreaterThan(0)
    expect(c.status).toBe('online')
    expect(FakeWS.all.length).toBe(1)
  })

  it('still pings for the broker keepalive while data is flowing', () => {
    const { c, ws } = connect()
    for (let t = 0; t < 60_000; t += 1_000) {
      vi.advanceTimersByTime(1_000)
      ws.receive(PINGRESP) // stands in for any incoming traffic
    }
    // The broker closes us after 1.5 × 30 s keepalive without a packet; we ping every ~16 s.
    expect(ws.sent.filter(isPing).length).toBeGreaterThanOrEqual(3)
    expect(c.status).toBe('online')
  })

  it('drops the connection on a corrupt or oversized packet length', () => {
    for (const bad of [
      [0x30, 0xff, 0xff, 0xff, 0xff, 0x01], // remaining length longer than 4 bytes
      [0x30, 0xff, 0xff, 0xff, 0x7f], // 256 MB packet
    ]) {
      FakeWS.all = []
      const { c, ws } = connect()
      ws.receive(bad)
      expect(ws.closed).toBe(true)
      expect(c.status).toBe('connecting')
      c.stop()
    }
  })

  it('notices a silent (half-open) connection within ~12 s and reconnects', () => {
    const { c, ws, statuses } = connect()
    vi.advanceTimersByTime(9_000)
    expect(c.status).toBe('online') // pinged, still waiting for an answer
    expect(ws.sent.filter(isPing).length).toBe(1)
    vi.advanceTimersByTime(3_000) // ping unanswered
    expect(ws.closed).toBe(true)
    expect(c.status).toBe('connecting')
    expect(statuses.at(-1)).toBe('connecting')
    vi.advanceTimersByTime(1_500) // first retry: ~1 s with jitter
    expect(FakeWS.all.length).toBe(2)
  })

  it('caps the reconnect backoff at ~5 s', () => {
    connect()
    // Fail repeatedly so the backoff would pass 5 s uncapped (1, 2, 4, 8 s, …).
    for (let i = 0; i < 6; i++) {
      FakeWS.all.at(-1)!.onclose?.()
      vi.advanceTimersByTime(60_000)
    }
    const before = FakeWS.all.length
    FakeWS.all.at(-1)!.onclose?.()
    vi.advanceTimersByTime(6_250) // 5 s + 25 % jitter
    expect(FakeWS.all.length).toBe(before + 1)
  })

  it('goes offline at once when the browser does, and does not retry', () => {
    const { c, ws, statuses } = connect()
    goOffline()
    expect(ws.closed).toBe(true)
    expect(c.status).toBe('offline')
    expect(statuses.at(-1)).toBe('offline')
    vi.advanceTimersByTime(60_000)
    expect(FakeWS.all.length).toBe(1)
  })

  it('reconnects immediately when the network comes back', () => {
    const { c } = connect()
    goOffline()
    goOnline()
    expect(FakeWS.all.length).toBe(2)
    expect(c.status).toBe('connecting')
  })

  it('starts offline without opening a socket when there is no network', () => {
    nav.onLine = false
    const c = new MqttClient('wss://x', () => {})
    c.start()
    expect(c.status).toBe('offline')
    expect(FakeWS.all.length).toBe(0)
    goOnline()
    expect(FakeWS.all.length).toBe(1)
  })

  it('verifies a live connection with a ping when the network changes', () => {
    const { ws } = connect()
    goOnline()
    expect(ws.sent.filter(isPing).length).toBe(1)
  })

  it('ignores network events after stop()', () => {
    const { c } = connect()
    c.stop()
    goOffline()
    goOnline()
    expect(FakeWS.all.length).toBe(1)
    expect(c.status).toBe('offline')
  })
})
