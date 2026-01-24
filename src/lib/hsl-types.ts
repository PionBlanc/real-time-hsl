// HSL HFP (High-Frequency Positioning) types

export type TransportMode = 'bus' | 'tram' | 'train' | 'ferry' | 'metro' | 'ubus' | 'robot'

export interface VehiclePosition {
  desi: string // Route number visible to passengers
  dir: string // Route direction ("1" or "2")
  oper: number // Operator ID
  veh: number // Vehicle number
  tst: string // UTC timestamp
  tsi: number // Unix timestamp in seconds
  spd: number // Speed in m/s
  hdg: number // Heading in degrees (0-360)
  lat: number | null // Latitude
  long: number | null // Longitude
  acc: number // Acceleration in m/s^2
  dl: number // Delay from schedule in seconds (negative = late)
  odo: number // Odometer reading in meters
  drst: number // Door status (0 = closed, 1 = open)
  oday: string // Operating day
  jrn: number // Internal journey descriptor
  line: number // Internal line descriptor
  start: string // Scheduled start time (HH:mm)
  loc: 'GPS' | 'ODO' | 'MAN' | 'DR' | 'N/A' // Location source
  stop: string | null // Current/next stop ID
  route: string // Route ID
  occu: number // Occupancy level (0-100)
}

export interface HFPMessage {
  VP?: VehiclePosition
  DUE?: VehiclePosition
  ARR?: VehiclePosition
  DEP?: VehiclePosition
  ARS?: VehiclePosition
  PDE?: VehiclePosition
  PAS?: VehiclePosition
  WAIT?: VehiclePosition
  DOO?: VehiclePosition
  DOC?: VehiclePosition
}

export interface Vehicle {
  id: string // Unique ID: operator/vehicle
  position: VehiclePosition
  mode: TransportMode
  lastUpdate: number
}

// Colors for different transport modes
export const TRANSPORT_COLORS: Record<TransportMode, string> = {
  bus: '#007AC9', // Blue
  tram: '#00985F', // Green
  train: '#8C4799', // Purple
  metro: '#FF6319', // Orange
  ferry: '#00B9E4', // Light blue
  ubus: '#007AC9', // Blue (same as bus)
  robot: '#888888', // Gray
}

// Display names for transport modes
export const TRANSPORT_NAMES: Record<TransportMode, string> = {
  bus: 'Bus',
  tram: 'Tram',
  train: 'Train',
  metro: 'Metro',
  ferry: 'Ferry',
  ubus: 'U-Line Bus',
  robot: 'Robot Bus',
}
