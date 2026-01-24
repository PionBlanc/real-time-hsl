import { useEffect, useMemo, useRef } from 'react'
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  useMap,
  ZoomControl,
} from 'react-leaflet'
import type { Map as LeafletMap } from 'leaflet'
import 'leaflet/dist/leaflet.css'
import type { Vehicle } from '@/lib/hsl-types'
import { TRANSPORT_NAMES, TRANSPORT_COLORS } from '@/lib/hsl-types'
import { getVehicleIcon } from '@/lib/vehicle-icons'
import { Badge } from '@/components/ui/badge'

// Helsinki coordinates
const HELSINKI_CENTER: [number, number] = [60.1699, 24.9384]
const DEFAULT_ZOOM = 13

interface TransportMapProps {
  vehicles: Map<string, Vehicle>
  className?: string
}

// Component to handle map instance
function MapController() {
  const map = useMap()

  useEffect(() => {
    // Invalidate size when component mounts to fix any sizing issues
    map.invalidateSize()
  }, [map])

  return null
}

// Individual vehicle marker component
function VehicleMarker({ vehicle }: { vehicle: Vehicle }) {
  const markerRef = useRef<L.Marker>(null)
  const { position, mode, id } = vehicle
  const { lat, long, hdg, desi, spd, dl } = position

  const icon = useMemo(() => getVehicleIcon(mode, hdg || 0), [mode, hdg])

  if (lat === null || long === null) return null

  // Calculate delay display
  const delayMinutes = Math.round(dl / 60)
  const delayText =
    delayMinutes === 0
      ? 'On time'
      : delayMinutes < 0
        ? `${Math.abs(delayMinutes)} min late`
        : `${delayMinutes} min early`

  const delayColor =
    delayMinutes === 0
      ? 'text-green-600'
      : delayMinutes < 0
        ? 'text-red-600'
        : 'text-blue-600'

  // Speed in km/h
  const speedKmh = Math.round((spd || 0) * 3.6)

  return (
    <Marker ref={markerRef} position={[lat, long]} icon={icon}>
      <Popup>
        <div className="min-w-[180px] p-1">
          <div className="mb-2 flex items-center gap-2">
            <Badge
              style={{ backgroundColor: TRANSPORT_COLORS[mode] }}
              className="text-white"
            >
              {desi || 'N/A'}
            </Badge>
            <span className="text-sm font-medium text-muted-foreground">
              {TRANSPORT_NAMES[mode]}
            </span>
          </div>

          <div className="space-y-1 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Speed:</span>
              <span className="font-medium">{speedKmh} km/h</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Status:</span>
              <span className={`font-medium ${delayColor}`}>{delayText}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Vehicle:</span>
              <span className="font-mono text-xs">{id}</span>
            </div>
          </div>
        </div>
      </Popup>
    </Marker>
  )
}

export function TransportMap({ vehicles, className = '' }: TransportMapProps) {
  const mapRef = useRef<LeafletMap>(null)

  // Convert vehicles map to array for rendering
  const vehicleArray = useMemo(() => Array.from(vehicles.values()), [vehicles])

  return (
    <MapContainer
      ref={mapRef}
      center={HELSINKI_CENTER}
      zoom={DEFAULT_ZOOM}
      zoomControl={false}
      className={`h-full w-full ${className}`}
      style={{ minHeight: '400px' }}
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <ZoomControl position="bottomright" />
      <MapController />

      {vehicleArray.map((vehicle) => (
        <VehicleMarker key={vehicle.id} vehicle={vehicle} />
      ))}
    </MapContainer>
  )
}
