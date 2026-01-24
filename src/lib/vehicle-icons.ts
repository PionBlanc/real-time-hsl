import L from 'leaflet'
import type { TransportMode } from './hsl-types'
import { TRANSPORT_COLORS } from './hsl-types'

// Create SVG icons for each transport mode
function createVehicleSvg(mode: TransportMode, heading: number): string {
  const color = TRANSPORT_COLORS[mode]

  // Create an arrow/vehicle marker pointing in the direction of travel
  const svg = `
    <svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <g transform="rotate(${heading}, 12, 12)">
        <circle cx="12" cy="12" r="10" fill="${color}" stroke="white" stroke-width="2"/>
        <polygon points="12,4 8,14 12,12 16,14" fill="white"/>
      </g>
    </svg>
  `

  return `data:image/svg+xml;base64,${btoa(svg.trim())}`
}

// Cache for vehicle icons
const iconCache = new Map<string, L.Icon>()

export function getVehicleIcon(mode: TransportMode, heading: number): L.Icon {
  // Round heading to nearest 15 degrees to reduce number of cached icons
  const roundedHeading = Math.round(heading / 15) * 15

  const cacheKey = `${mode}-${roundedHeading}`

  let icon = iconCache.get(cacheKey)
  if (!icon) {
    icon = L.icon({
      iconUrl: createVehicleSvg(mode, roundedHeading),
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      popupAnchor: [0, -12],
    })
    iconCache.set(cacheKey, icon)
  }

  return icon
}

// Create a simple circle icon for clustered view
export function getSimpleVehicleIcon(mode: TransportMode): L.Icon {
  const color = TRANSPORT_COLORS[mode]
  const cacheKey = `simple-${mode}`

  let icon = iconCache.get(cacheKey)
  if (!icon) {
    const svg = `
      <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
        <circle cx="8" cy="8" r="6" fill="${color}" stroke="white" stroke-width="2"/>
      </svg>
    `

    icon = L.icon({
      iconUrl: `data:image/svg+xml;base64,${btoa(svg.trim())}`,
      iconSize: [16, 16],
      iconAnchor: [8, 8],
      popupAnchor: [0, -8],
    })
    iconCache.set(cacheKey, icon)
  }

  return icon
}
