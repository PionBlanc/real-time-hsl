// Shared helpers for the Vercel edge functions. Files starting with "_" are not routes.

const GRAPHQL = 'https://api.digitransit.fi/routing/v2/hsl/gtfs/v1'

/** Give up on Digitransit after this long instead of hanging until the platform kills us. */
export const UPSTREAM_TIMEOUT_MS = 8000

export function apiKey(): string | undefined {
  return process.env.DIGITRANSIT_API_KEY || undefined
}

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
 * - Only the listed params, each at most once: junk params (`&x=<random>`) would
 *   otherwise bypass the cache on every request.
 * Returns an error response, or null when the request may proceed.
 */
export function guard(req: Request, allowed: ReadonlyArray<string>): Response | null {
  if (req.headers.get('sec-fetch-site') === 'cross-site') {
    return json({ error: 'forbidden' }, 403, 'no-store')
  }
  const seen = new Set<string>()
  for (const k of new URL(req.url).searchParams.keys()) {
    if (!allowed.includes(k) || seen.has(k)) return badRequest()
    seen.add(k)
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

export async function graphql<T>(
  key: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const r = await fetch(GRAPHQL, {
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
