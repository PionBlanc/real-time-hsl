// Shared helpers for the Vercel edge functions. Files starting with "_" are not routes.

const GRAPHQL = 'https://api.digitransit.fi/routing/v2/hsl/gtfs/v1'

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
  })
  if (!r.ok) throw new Error(`digitransit ${r.status}`)
  const data = (await r.json()) as { data?: T; errors?: Array<{ message: string }> }
  if (data.errors?.length) throw new Error(data.errors[0].message)
  return data.data as T
}
