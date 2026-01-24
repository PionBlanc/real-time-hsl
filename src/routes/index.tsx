import { useCallback, useMemo, useState } from 'react'
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
    vehicleCount,
    reconnect,
  } = useHSLVehicles({
    modes: activeModes,
    enabled: activeModes.length > 0,
  })

  // Count vehicles by mode
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
    vehicles.forEach((vehicle) => {
      counts[vehicle.mode]++
    })
    return counts
  }, [vehicles])

  const handleToggleMode = useCallback(
    (mode: TransportMode, enabled: boolean) => {
      setEnabledModes((prev) => ({ ...prev, [mode]: enabled }))
    },
    [],
  )

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
              totalCount={vehicleCount}
              onReconnect={reconnect}
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
        <TransportMap vehicles={vehicles} />
      </div>
    </div>
  )
}
