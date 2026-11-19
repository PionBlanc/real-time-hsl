// Shared helpers for the Vercel edge functions. Files starting with "_" are not routes.
// ".js": tile.ts runs on Node, whose ESM loader needs it (see api/tile.ts).
import { cityById } from './_cities.js'
import type { City } from './_cities.js'

const graphqlUrl = (city: City) => `https://api.digitransit.fi/routing/v2/${city.router}/gtfs/v1`

/** Give up on Digitransit after this long instead of hanging until the platform kills us. */
export const UPSTREAM_TIMEOUT_MS = 8000

export function apiKey(): string | undefined {
  return process.env.DIGITRANSIT_API_KEY || undefined
}

/*
 * Positional arrays in responses (e.g. stop departures) are APPEND-ONLY: never reorder or
 * remove a field. The service worker serves the previous app version for one visit after
 * each deploy, and that old code reads fields by index.
 */
export function json(body: unknown, status: number, cache: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': cache },
  })
}

export const noKey = (): Response =>
  json({ error: 'missing_key' }, 503, 'no-store')

export const badRequest = (): Response => json({ error: 'bad_request' }, 400, 'no-store')

/**
 * Abuse guard, run before anything touches the API key. The edge cache keys on the full
 * URL, so every distinct URL that reaches a handler costs an upstream call on our key.
 * - Other websites' pages may not use these endpoints (browsers send Sec-Fetch-Site).
 * - Only the canonical spelling of a query: the listed params, each at most once, in the
 *   listed order, with no percent-encoding or "+". Junk params (`&x=<random>`), reordered
 *   params or `%31` for `1` would otherwise each be a new cache key and a new upstream call.
 *   Clients must build their URLs in this order.
 * This does not stop scripts (they can omit Sec-Fetch-Site); per-IP rate limiting for
 * /api/* is set up in the Vercel Firewall.
 * Returns an error response, or null when the request may proceed.
 */
export function guard(req: Request, allowed: ReadonlyArray<string>): Response | null {
  if (req.headers.get('sec-fetch-site') === 'cross-site') {
    return json({ error: 'forbidden' }, 403, 'no-store')
  }
  const raw = new URL(req.url).search.slice(1)
  if (raw === '') return null
  let next = 0
  for (const part of raw.split('&')) {
    const eq = part.indexOf('=')
    const i = eq < 0 ? -1 : allowed.indexOf(part.slice(0, eq), next)
    if (i < 0 || /[%+]/.test(part)) return badRequest()
    next = i + 1
  }
  return null
}

/**
 * A non-negative integer written canonically ("13", not "013", "13.0" or "1e1"), so the
 * same value always has the same cache key. Returns null otherwise.
 */
export function canonicalInt(s: string | null): number | null {
  return s != null && /^(0|[1-9]\d{0,9})$/.test(s) ? Number(s) : null
}

/**
 * Response for a failed upstream call. The error is logged server-side only (upstream
 * messages can reveal internals), and the failure is cached at the edge for a few seconds,
 * so when Digitransit struggles or rate-limits us every client retry doesn't hit it again.
 */
export function upstreamError(where: string, e: unknown): Response {
  console.error(`${where}: upstream error:`, e)
  return json({ error: 'upstream' }, 502, 'public, max-age=0, s-maxage=10')
}

/**
 * The city a request is for (the required `city` param); null if missing or unknown.
 * Every endpoint lists "city" first in its guard() params.
 */
export function cityParam(q: URLSearchParams): City | null {
  return cityById(q.get('city'))
}

export async function graphql<T>(
  key: string,
  city: City,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const r = await fetch(graphqlUrl(city), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'digitransit-subscription-key': key,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
  if (!r.ok) throw new Error(`digitransit ${r.status}`)
  const data = (await r.json()) as { data?: T; errors?: Array<{ message: string }> }
  if (data.errors?.length) throw new Error(data.errors[0].message)
  return data.data as T
}
