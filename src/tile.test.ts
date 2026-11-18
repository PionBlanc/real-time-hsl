// Tests for the tile proxy. (Kept in src/: every file in /api would become a Vercel route.)
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import tile from '../api/tile'

const url = (r: string) => `https://example.test/api/tile?z=14&x=9326&y=4742&r=${r}`
const get = (r: string) => tile.fetch(new Request(url(r)))

const png = () =>
  sharp({ create: { width: 512, height: 512, channels: 4, background: '#e9ecef' } }).png().toBuffer()

/** Replace the upstream tile server; returns the mock to inspect what was requested. */
function upstream(res: () => Response | Promise<Response>) {
  const f = vi.fn(async (_url: string, _init?: RequestInit) => res())
  vi.stubGlobal('fetch', f)
  return f
}

beforeEach(() => {
  vi.stubEnv('DIGITRANSIT_API_KEY', 'test-key')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('/api/tile', () => {
  it('converts the tile to WebP and caches it long', async () => {
    const body = await png()
    upstream(() => new Response(new Uint8Array(body), { headers: { 'content-type': 'image/png' } }))
    const res = await get('')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/webp')
    expect(res.headers.get('cache-control')).toContain('s-maxage=2592000')
    const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata()
    expect(meta.format).toBe('webp')
    expect(meta.width).toBe(512)
  })

  it('asks upstream for the @2x file on high-DPI screens, with the key in a header', async () => {
    const body = await png()
    const f = upstream(() => new Response(new Uint8Array(body)))
    await get('2x')
    expect(f.mock.calls[0][0]).toMatch(/\/14\/9326\/4742@2x\.png$/)
    expect(f.mock.calls[0][0]).not.toContain('test-key')
    expect(new Headers(f.mock.calls[0][1]?.headers).get('digitransit-subscription-key')).toBe('test-key')
  })

  it('serves the original briefly when the conversion fails', async () => {
    upstream(() => new Response('not an image', { headers: { 'content-type': 'image/png' } }))
    const res = await get('')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toContain('s-maxage=60')
    expect(await res.text()).toBe('not an image')
  })

  it('passes on upstream errors and survives a failed connection', async () => {
    upstream(() => new Response(null, { status: 404 }))
    expect((await get('')).status).toBe(404)
    upstream(() => Promise.reject(new Error('down')))
    expect((await get('')).status).toBe(502)
  })

  it('rejects other tile sizes without calling upstream', async () => {
    const f = upstream(() => new Response(null))
    expect((await get('3x')).status).toBe(400)
    expect(f).not.toHaveBeenCalled()
  })
})
