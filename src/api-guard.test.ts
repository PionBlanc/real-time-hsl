// Tests for the /api input checks. (Kept in src/: every file in /api would become a Vercel route.)
import { describe, expect, it } from 'vitest'
import { canonicalInt, guard } from '../api/_digitransit'
import { tileInArea } from '../api/tile'

const req = (qs: string, headers: Record<string, string> = {}) =>
  new Request(`https://example.test/api/x?${qs}`, { headers })

describe('guard', () => {
  it('accepts known params', () => {
    expect(guard(req('id=1&start=60'), ['id', 'start'])).toBeNull()
    expect(guard(req('id=1', { 'sec-fetch-site': 'same-origin' }), ['id'])).toBeNull()
  })
  it('rejects unknown or repeated params (cache busting)', () => {
    expect(guard(req('id=1&cb=123'), ['id'])?.status).toBe(400)
    expect(guard(req('id=1&id=2'), ['id'])?.status).toBe(400)
  })
  it('only accepts the canonical spelling (one cache key per value)', () => {
    expect(guard(req('z=1&x=2&y=3&r=@2x'), ['z', 'x', 'y', 'r'])).toBeNull()
    expect(guard(req('z=1&x=2&y=3&r='), ['z', 'x', 'y', 'r'])).toBeNull()
    expect(guard(req('id=1'), ['id', 'start'])).toBeNull() // optional params may be left out
    expect(guard(req(''), ['id'])).toBeNull()
    for (const qs of ['x=2&z=1&y=3&r=', 'z=%31&x=2&y=3&r=', 'z=1&x=2&y=3&r=%402x', 'z=1&&x=2', 'z&x=2', 'q=a+b'])
      expect(guard(req(qs), ['z', 'x', 'y', 'r', 'q'])?.status, qs).toBe(400)
  })
  it('rejects requests from other websites', () => {
    expect(guard(req('id=1', { 'sec-fetch-site': 'cross-site' }), ['id'])?.status).toBe(403)
  })
})

describe('canonicalInt', () => {
  it('only accepts one spelling per number', () => {
    expect(canonicalInt('13')).toBe(13)
    expect(canonicalInt('0')).toBe(0)
    for (const s of ['013', '13.0', '1e1', ' 13', '-1', '', null]) expect(canonicalInt(s)).toBeNull()
  })
})

describe('tileInArea', () => {
  it('serves central Helsinki at the zoom levels the app uses', () => {
    // 60.17, 24.94 at z=13 is tile x=4663, y=2371
    expect(tileInArea(13, 4663, 2371)).toBe(true)
    expect(tileInArea(7, 72, 36)).toBe(true)
  })
  it('rejects tiles outside the region, beyond 2^z, or at unused zooms', () => {
    expect(tileInArea(13, 0, 0)).toBe(false)
    expect(tileInArea(13, 9000, 2371)).toBe(false)
    expect(tileInArea(18, 9326, 4742)).toBe(false)
    expect(tileInArea(6, 36, 18)).toBe(false)
  })
})
