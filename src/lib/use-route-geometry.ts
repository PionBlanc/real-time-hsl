import { useCallback, useState } from 'react'
import type { Vehicle } from './hsl-types'

// Digitransit GraphQL API endpoint (proxied through Vite to avoid CORS)
// The API key is injected server-side by the Vite proxy - never exposed to client
// Using the v2 GTFS API: https://api.digitransit.fi/routing/v2/hsl/gtfs/v1
const DIGITRANSIT_API_URL = '/api/digitransit/routing/v2/hsl/gtfs/v1'

export interface RouteGeometry {
  coordinates: Array<[number, number]> // [lat, lng] pairs
  routeName: string
  headsign: string
}

export interface UseRouteGeometryResult {
  geometry: RouteGeometry | null
  isLoading: boolean
  error: string | null
  fetchGeometry: (vehicle: Vehicle) => Promise<void>
  clearGeometry: () => void
}

// Convert HH:mm time to seconds since midnight
function timeToSeconds(time: string): number {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 3600 + minutes * 60
}

export function useRouteGeometry(): UseRouteGeometryResult {
  const [geometry, setGeometry] = useState<RouteGeometry | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const clearGeometry = useCallback(() => {
    setGeometry(null)
    setError(null)
  }, [])

  const fetchGeometry = useCallback(async (vehicle: Vehicle) => {
    const { route, dir, oday, start, tst, desi } = vehicle.position

    if (!route || !start || !oday) {
      setError('Missing route information')
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      // Build route ID - add HSL prefix if not present
      const routeId = route.startsWith('HSL:') ? route : `HSL:${route}`

      // Convert direction: HFP uses 1/2, Routing API uses 0/1
      const direction = dir === '2' ? 1 : 0

      // Calculate departure time in seconds
      let departureTime = timeToSeconds(start)

      // Handle overnight trips: if oday is different from tst date and start is early morning
      const tstDate = tst.split('T')[0]
      if (oday !== tstDate) {
        const tstHour = new Date(tst).getUTCHours()
        const startHour = parseInt(start.split(':')[0], 10)
        // If tst is after midnight but start is early morning, add 24 hours
        if (tstHour < 6 && startHour < 6) {
          departureTime += 86400
        }
      }

      const query = `
        query GetRouteGeometry($route: String!, $direction: Int!, $date: String!, $time: Int!) {
          fuzzyTrip(route: $route, direction: $direction, date: $date, time: $time) {
            tripHeadsign
            pattern {
              name
              patternGeometry {
                points
              }
            }
          }
        }
      `

      const response = await fetch(DIGITRANSIT_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query,
          variables: {
            route: routeId,
            direction,
            date: oday,
            time: departureTime,
          },
        }),
      })

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status}`)
      }

      const data = await response.json()

      if (data.errors) {
        throw new Error(data.errors[0]?.message || 'GraphQL error')
      }

      const trip = data.data?.fuzzyTrip

      if (!trip) {
        // Try alternative: query by route patterns directly
        const fallbackQuery = `
          query GetRoutePatterns($route: String!) {
            route(id: $route) {
              shortName
              patterns {
                name
                headsign
                directionId
                patternGeometry {
                  points
                }
              }
            }
          }
        `

        const fallbackResponse = await fetch(DIGITRANSIT_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            query: fallbackQuery,
            variables: { route: routeId },
          }),
        })

        const fallbackData = await fallbackResponse.json()
        const routeData = fallbackData.data?.route

        if (!routeData?.patterns?.length) {
          throw new Error('Route not found')
        }

        // Find matching pattern by direction
        const pattern =
          routeData.patterns.find(
            (p: { directionId: number }) => p.directionId === direction,
          ) || routeData.patterns[0]

        if (!pattern?.patternGeometry?.points) {
          throw new Error('Route geometry not available')
        }

        const coordinates = decodePolyline(pattern.patternGeometry.points)

        setGeometry({
          coordinates,
          routeName: desi || routeData.shortName || 'Unknown',
          headsign: pattern.headsign || pattern.name || '',
        })
        return
      }

      const patternGeometry = trip.pattern?.patternGeometry?.points

      if (!patternGeometry) {
        throw new Error('Route geometry not available')
      }

      // Decode the encoded polyline
      const coordinates = decodePolyline(patternGeometry)

      setGeometry({
        coordinates,
        routeName: desi || 'Unknown',
        headsign: trip.tripHeadsign || trip.pattern?.name || '',
      })
    } catch (err) {
      console.error('Failed to fetch route geometry:', err)
      setError(err instanceof Error ? err.message : 'Failed to fetch route')
    } finally {
      setIsLoading(false)
    }
  }, [])

  return {
    geometry,
    isLoading,
    error,
    fetchGeometry,
    clearGeometry,
  }
}

// Decode Google polyline encoding format
// https://developers.google.com/maps/documentation/utilities/polylinealgorithm
function decodePolyline(encoded: string): Array<[number, number]> {
  const coordinates: Array<[number, number]> = []
  let index = 0
  let lat = 0
  let lng = 0

  while (index < encoded.length) {
    let shift = 0
    let result = 0
    let byte: number

    // Decode latitude
    do {
      byte = encoded.charCodeAt(index++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)

    const deltaLat = result & 1 ? ~(result >> 1) : result >> 1
    lat += deltaLat

    shift = 0
    result = 0

    // Decode longitude
    do {
      byte = encoded.charCodeAt(index++) - 63
      result |= (byte & 0x1f) << shift
      shift += 5
    } while (byte >= 0x20)

    const deltaLng = result & 1 ? ~(result >> 1) : result >> 1
    lng += deltaLng

    coordinates.push([lat / 1e5, lng / 1e5])
  }

  return coordinates
}
