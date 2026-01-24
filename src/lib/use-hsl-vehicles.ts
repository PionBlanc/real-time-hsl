import { useCallback, useEffect, useRef, useState } from 'react'
import mqtt from 'mqtt'
import type { HFPMessage, TransportMode, Vehicle } from './hsl-types'

const MQTT_BROKER_URL = 'wss://mqtt.hsl.fi:443/'

// Vehicle position stale timeout in milliseconds (remove vehicles not updated in 60 seconds)
const STALE_TIMEOUT = 60000

export interface UseHSLVehiclesOptions {
  modes: Array<TransportMode>
  enabled?: boolean
}

export interface UseHSLVehiclesResult {
  vehicles: Map<string, Vehicle>
  isConnected: boolean
  isConnecting: boolean
  error: string | null
  vehicleCount: number
  reconnect: () => void
}

export function useHSLVehicles({
  modes,
  enabled = true,
}: UseHSLVehiclesOptions): UseHSLVehiclesResult {
  const [vehicles, setVehicles] = useState<Map<string, Vehicle>>(new Map())
  const [isConnected, setIsConnected] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const clientRef = useRef<mqtt.MqttClient | null>(null)
  const modesRef = useRef<Array<TransportMode>>(modes)

  // Update modes ref when modes change
  useEffect(() => {
    modesRef.current = modes
  }, [modes])

  // Cleanup stale vehicles periodically
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now()
      setVehicles((prev) => {
        const updated = new Map(prev)
        let hasChanges = false
        for (const [id, vehicle] of updated) {
          if (now - vehicle.lastUpdate > STALE_TIMEOUT) {
            updated.delete(id)
            hasChanges = true
          }
        }
        return hasChanges ? updated : prev
      })
    }, 10000)

    return () => clearInterval(interval)
  }, [])

  const connect = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.end(true)
    }

    setIsConnecting(true)
    setError(null)

    const client = mqtt.connect(MQTT_BROKER_URL, {
      keepalive: 30,
      reconnectPeriod: 5000,
      connectTimeout: 10000,
    })

    clientRef.current = client

    client.on('connect', () => {
      setIsConnected(true)
      setIsConnecting(false)
      setError(null)

      // Subscribe to vehicle position updates for selected modes
      const topics = modesRef.current.map(
        (mode) => `/hfp/v2/journey/ongoing/vp/${mode}/#`,
      )

      if (topics.length > 0) {
        client.subscribe(topics, (err) => {
          if (err) {
            console.error('Failed to subscribe:', err)
            setError('Failed to subscribe to vehicle updates')
          }
        })
      }
    })

    client.on('message', (topic, message) => {
      try {
        const payload: HFPMessage = JSON.parse(message.toString())
        const vp = payload.VP

        if (!vp || vp.lat === null || vp.long === null) {
          return
        }

        // Parse mode from topic
        // Topic format: /hfp/v2/journey/ongoing/vp/{mode}/{operator}/{vehicle}/...
        const parts = topic.split('/')
        const mode = parts[6] as TransportMode

        // Create unique vehicle ID
        const id = `${vp.oper}/${vp.veh}`

        const vehicle: Vehicle = {
          id,
          position: vp,
          mode,
          lastUpdate: Date.now(),
        }

        setVehicles((prev) => {
          const updated = new Map(prev)
          updated.set(id, vehicle)
          return updated
        })
      } catch (e) {
        // Ignore parse errors
      }
    })

    client.on('error', (err) => {
      console.error('MQTT error:', err)
      setError('Connection error')
      setIsConnecting(false)
    })

    client.on('close', () => {
      setIsConnected(false)
    })

    client.on('offline', () => {
      setIsConnected(false)
    })

    client.on('reconnect', () => {
      setIsConnecting(true)
    })
  }, [])

  // Connect when enabled changes or modes change
  useEffect(() => {
    if (!enabled) {
      if (clientRef.current) {
        clientRef.current.end(true)
        clientRef.current = null
      }
      setIsConnected(false)
      setIsConnecting(false)
      setVehicles(new Map())
      return
    }

    connect()

    return () => {
      if (clientRef.current) {
        clientRef.current.end(true)
        clientRef.current = null
      }
    }
  }, [enabled, connect])

  // Resubscribe when modes change
  useEffect(() => {
    if (!clientRef.current || !isConnected) return

    const client = clientRef.current

    // Unsubscribe from all topics first
    client.unsubscribe('/hfp/v2/journey/ongoing/vp/#', () => {
      // Subscribe to new topics
      const topics = modes.map((mode) => `/hfp/v2/journey/ongoing/vp/${mode}/#`)

      if (topics.length > 0) {
        client.subscribe(topics, (err) => {
          if (err) {
            console.error('Failed to subscribe:', err)
          }
        })
      }

      // Clear vehicles that don't match the new mode filters
      setVehicles((prev) => {
        const updated = new Map(prev)
        for (const [id, vehicle] of updated) {
          if (!modes.includes(vehicle.mode)) {
            updated.delete(id)
          }
        }
        return updated
      })
    })
  }, [modes, isConnected])

  return {
    vehicles,
    isConnected,
    isConnecting,
    error,
    vehicleCount: vehicles.size,
    reconnect: connect,
  }
}
