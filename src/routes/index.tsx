import { useCallback, useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import type { TransportMode } from '@/lib/hsl-types'
import { TransportMap } from '@/components/transport-map'
import { ControlPanel } from '@/components/control-panel'
import { useHSLVehicles } from '@/lib/use-hsl-vehicles'

export const Route = createFileRoute('/')({
  component: App,
})

function App() {
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
    <div className="flex h-screen w-screen flex-col bg-background">
      {/* Main content */}
      <div className="relative flex flex-1 overflow-hidden">
        {/* Map */}
        <div className="flex-1">
          <TransportMap vehicles={vehicles} />
        </div>

        {/* Control panel - Sidebar */}
        <div className="absolute left-4 top-4 z-[1000] w-72">
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
    </div>
  )
}
