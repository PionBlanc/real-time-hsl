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

describe('MqttClient keepalive', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWS.all = []
    vi.stubGlobal('WebSocket', FakeWS)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function connect() {
    const statuses: Array<string> = []
    const c = new MqttClient('wss://x', () => {}, (s) => statuses.push(s))
    c.start()
    const ws = FakeWS.all[0]
    ws.onopen?.()
    ws.receive(CONNACK)
    return { c, ws, statuses }
  }

  it('stays online while the broker answers pings', () => {
    const { c, ws } = connect()
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(15_000)
      ws.receive(PINGRESP)
    }
    expect(ws.sent.filter(isPing).length).toBe(6)
    expect(c.status).toBe('online')
    expect(FakeWS.all.length).toBe(1)
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

  it('reconnects when the broker goes silent (half-open socket)', () => {
    const { c, ws, statuses } = connect()
    vi.advanceTimersByTime(45_000) // pings go unanswered
    expect(ws.closed).toBe(true)
    expect(c.status).toBe('connecting')
    expect(statuses.at(-1)).toBe('connecting')
    vi.advanceTimersByTime(2_000) // first retry: ~1 s with jitter
    expect(FakeWS.all.length).toBe(2)
  })
})
