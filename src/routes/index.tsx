import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import type { TransportMode } from '@/lib/hsl-types'
import { TransportMap } from '@/components/transport-map'
import { ControlPanel } from '@/components/control-panel'
import { useHSLVehicles } from '@/lib/use-hsl-vehicles'
import { Button } from '@/components/ui/button'

export const Route = createFileRoute('/')({
  component: App,
})

function App() {
  // Track sidebar visibility
  const [sidebarOpen, setSidebarOpen] = useState(true)

  // Track which transport modes are enabled
  const [enabledModes, setEnabledModes] = useState<
    Record<TransportMode, boolean>
  >({
    bus: true,
    tram: true,
    train: true,
    metro: true,
    ferry: true,
    ubus: false,
    robot: false,
  })

  // Track selected desi values per mode
  const [selectedDesiByMode, setSelectedDesiByMode] = useState<
    Record<TransportMode, Set<string>>
  >({
    bus: new Set(),
    tram: new Set(),
    train: new Set(),
    metro: new Set(),
    ferry: new Set(),
    ubus: new Set(),
    robot: new Set(),
  })

  // Track all desi values we've ever seen (use ref to avoid triggering re-renders)
  const seenDesiByModeRef = useRef<Record<TransportMode, Set<string>>>({
    bus: new Set(),
    tram: new Set(),
    train: new Set(),
    metro: new Set(),
    ferry: new Set(),
    ubus: new Set(),
    robot: new Set(),
  })

  // Get array of enabled modes for the hook
  const activeModes = useMemo(
    () =>
      (Object.entries(enabledModes) as Array<[TransportMode, boolean]>)
        .filter(([, enabled]) => enabled)
        .map(([mode]) => mode),
    [enabledModes],
  )

  // Connect to HSL real-time vehicle positions
  const {
    vehicles,
    isConnected,
    isConnecting,
    error,
    reconnect,
  } = useHSLVehicles({
    modes: activeModes,
    enabled: activeModes.length > 0,
  })

  // Auto-select new desi values as they appear (only truly new ones we've never seen)
  useEffect(() => {
    const seenDesiByMode = seenDesiByModeRef.current

    // Find truly new desi values (ones we've never seen before)
    const trulyNewByMode: Record<TransportMode, Array<string>> = {
      bus: [],
      tram: [],
      train: [],
      metro: [],
      ferry: [],
      ubus: [],
      robot: [],
    }

    for (const vehicle of vehicles.values()) {
      const desi = vehicle.position.desi || ''
      if (!seenDesiByMode[vehicle.mode].has(desi)) {
        trulyNewByMode[vehicle.mode].push(desi)
        // Mark as seen immediately in the ref
        seenDesiByMode[vehicle.mode].add(desi)
      }
    }

    // Check if any mode has new desi values
    const hasNewDesi = Object.values(trulyNewByMode).some((arr) => arr.length > 0)

    if (hasNewDesi) {
      // Auto-select the truly new desi values
      setSelectedDesiByMode((prev) => {
        const updated = { ...prev }
        for (const mode of Object.keys(trulyNewByMode) as Array<TransportMode>) {
          if (trulyNewByMode[mode].length > 0) {
            updated[mode] = new Set([...prev[mode], ...trulyNewByMode[mode]])
          }
        }
        return updated
      })
    }
  }, [vehicles])

  // Filter vehicles based on selected desi values
  const filteredVehicles = useMemo(() => {
    const filtered = new Map(vehicles)
    for (const [id, vehicle] of vehicles) {
      const selectedDesi = selectedDesiByMode[vehicle.mode]
      const desi = vehicle.position.desi || ''
      // Only show vehicles whose desi is in the selected set
      if (!selectedDesi.has(desi)) {
        filtered.delete(id)
      }
    }
    return filtered
  }, [vehicles, selectedDesiByMode])

  // Count vehicles by mode (from filtered vehicles)
  const countsByMode = useMemo(() => {
    const counts: Record<TransportMode, number> = {
      bus: 0,
      tram: 0,
      train: 0,
      metro: 0,
      ferry: 0,
      ubus: 0,
      robot: 0,
    }
    filteredVehicles.forEach((vehicle) => {
      counts[vehicle.mode]++
    })
    return counts
  }, [filteredVehicles])

  const handleToggleMode = useCallback(
    (mode: TransportMode, enabled: boolean) => {
      setEnabledModes((prev) => ({ ...prev, [mode]: enabled }))
      // Reset desi selection and seen set when mode is disabled
      if (!enabled) {
        setSelectedDesiByMode((prev) => ({
          ...prev,
          [mode]: new Set(),
        }))
        seenDesiByModeRef.current[mode] = new Set()
      }
    },
    [],
  )

  const handleDesiToggle = useCallback(
    (mode: TransportMode, desi: string, checked: boolean) => {
      setSelectedDesiByMode((prev) => {
        const updated = new Set(prev[mode])
        if (checked) {
          updated.add(desi)
        } else {
          updated.delete(desi)
        }
        return { ...prev, [mode]: updated }
      })
    },
    [],
  )

  const handleSelectAllDesi = useCallback(
    (mode: TransportMode) => {
      const allDesi = new Set<string>()
      vehicles.forEach((vehicle) => {
        if (vehicle.mode === mode) {
          allDesi.add(vehicle.position.desi || '')
        }
      })
      setSelectedDesiByMode((prev) => ({ ...prev, [mode]: allDesi }))
    },
    [vehicles],
  )

  const handleDeselectAllDesi = useCallback((mode: TransportMode) => {
    setSelectedDesiByMode((prev) => ({ ...prev, [mode]: new Set() }))
  }, [])

  return (
    <div className="flex h-screen w-screen bg-background">
      {/* Sidebar */}
      <aside
        className={`absolute left-0 top-0 z-[1000] h-full w-80 transform bg-background/95 backdrop-blur-sm transition-transform duration-300 ease-in-out ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-full flex-col p-4">
          {/* Sidebar header with close button */}
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Controls</h2>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close sidebar"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="m15 18-6-6 6-6" />
              </svg>
            </Button>
          </div>

          {/* Control panel content */}
          <div className="flex-1 overflow-auto">
            <ControlPanel
              modes={enabledModes}
              counts={countsByMode}
              onToggleMode={handleToggleMode}
              isConnected={isConnected}
              isConnecting={isConnecting}
              error={error}
              totalCount={filteredVehicles.size}
              onReconnect={reconnect}
              vehicles={vehicles}
              selectedDesiByMode={selectedDesiByMode}
              onDesiToggle={handleDesiToggle}
              onSelectAllDesi={handleSelectAllDesi}
              onDeselectAllDesi={handleDeselectAllDesi}
            />
          </div>
        </div>
      </aside>

      {/* Burger button - visible when sidebar is closed */}
      <Button
        variant="secondary"
        size="icon"
        onClick={() => setSidebarOpen(true)}
        className={`absolute left-4 top-4 z-[999] shadow-md transition-opacity duration-300 ${
          sidebarOpen ? 'pointer-events-none opacity-0' : 'opacity-100'
        }`}
        aria-label="Open sidebar"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="4" x2="20" y1="12" y2="12" />
          <line x1="4" x2="20" y1="6" y2="6" />
          <line x1="4" x2="20" y1="18" y2="18" />
        </svg>
      </Button>

      {/* Map - full width */}
      <div className="h-full w-full">
        <TransportMap vehicles={filteredVehicles} />
      </div>
    </div>
  )
}
