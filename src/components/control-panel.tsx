import { useMemo, useState } from 'react'
import type { TransportMode, Vehicle } from '@/lib/hsl-types'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { TRANSPORT_COLORS, TRANSPORT_NAMES } from '@/lib/hsl-types'

interface TransportModeToggleProps {
  mode: TransportMode
  enabled: boolean
  count: number
  onToggle: (enabled: boolean) => void
  desiValues: Array<{ desi: string; count: number }>
  selectedDesi: Set<string>
  onDesiToggle: (desi: string, checked: boolean) => void
  onSelectAll: () => void
  onDeselectAll: () => void
}

function TransportModeToggle({
  mode,
  enabled,
  count,
  onToggle,
  desiValues,
  selectedDesi,
  onDesiToggle,
  onSelectAll,
  onDeselectAll,
}: TransportModeToggleProps) {
  const [expanded, setExpanded] = useState(false)

  const allSelected = desiValues.length > 0 && desiValues.every((d) => selectedDesi.has(d.desi))
  const noneSelected = desiValues.length > 0 && desiValues.every((d) => !selectedDesi.has(d.desi))

  return (
    <div className="border-b border-border/50 last:border-b-0">
      <div className="flex items-center justify-between py-2">
        <div className="flex items-center gap-3">
          <div
            className="h-4 w-4 rounded-full"
            style={{ backgroundColor: TRANSPORT_COLORS[mode] }}
          />
          <button
            onClick={() => enabled && setExpanded(!expanded)}
            className="flex items-center gap-1 font-medium hover:text-foreground/80"
            disabled={!enabled || desiValues.length === 0}
          >
            <span>{TRANSPORT_NAMES[mode]}</span>
            {enabled && desiValues.length > 0 && (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            )}
          </button>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="secondary" className="min-w-[50px] justify-center">
            {count}
          </Badge>
          <Switch checked={enabled} onCheckedChange={onToggle} />
        </div>
      </div>

      {/* Expandable desi filter section */}
      {enabled && expanded && desiValues.length > 0 && (
        <div className="pb-3 pl-7">
          <div className="mb-2 flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={onSelectAll}
              disabled={allSelected}
            >
              Select All
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={onDeselectAll}
              disabled={noneSelected}
            >
              Deselect All
            </Button>
          </div>
          <div className="max-h-48 space-y-1 overflow-y-auto">
            {desiValues.map(({ desi, count: desiCount }) => (
              <label
                key={desi}
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted/50"
              >
                <Checkbox
                  checked={selectedDesi.has(desi)}
                  onCheckedChange={(checked) => onDesiToggle(desi, !!checked)}
                />
                <span className="flex-1 truncate">{desi || '(no route)'}</span>
                <Badge variant="outline" className="h-5 min-w-[36px] justify-center text-xs">
                  {desiCount}
                </Badge>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

interface ControlPanelProps {
  modes: Record<TransportMode, boolean>
  counts: Record<TransportMode, number>
  onToggleMode: (mode: TransportMode, enabled: boolean) => void
  isConnected: boolean
  isConnecting: boolean
  error: string | null
  totalCount: number
  onReconnect: () => void
  vehicles: Map<string, Vehicle>
  selectedDesiByMode: Record<TransportMode, Set<string>>
  onDesiToggle: (mode: TransportMode, desi: string, checked: boolean) => void
  onSelectAllDesi: (mode: TransportMode) => void
  onDeselectAllDesi: (mode: TransportMode) => void
}

export function ControlPanel({
  modes,
  counts,
  onToggleMode,
  isConnected,
  isConnecting,
  error,
  totalCount,
  onReconnect,
  vehicles,
  selectedDesiByMode,
  onDesiToggle,
  onSelectAllDesi,
  onDeselectAllDesi,
}: ControlPanelProps) {
  const transportModes: Array<TransportMode> = [
    'bus',
    'tram',
    'train',
    'metro',
    'ferry',
  ]

  // Compute unique desi values with counts for each mode
  const desiByMode = useMemo(() => {
    const result: Record<TransportMode, Array<{ desi: string; count: number }>> = {
      bus: [],
      tram: [],
      train: [],
      metro: [],
      ferry: [],
      ubus: [],
      robot: [],
    }

    const desiCounts: Record<TransportMode, Map<string, number>> = {
      bus: new Map(),
      tram: new Map(),
      train: new Map(),
      metro: new Map(),
      ferry: new Map(),
      ubus: new Map(),
      robot: new Map(),
    }

    vehicles.forEach((vehicle) => {
      const desi = vehicle.position.desi || ''
      const modeMap = desiCounts[vehicle.mode]
      modeMap.set(desi, (modeMap.get(desi) || 0) + 1)
    })

    for (const mode of transportModes) {
      const entries = Array.from(desiCounts[mode].entries())
        .map(([desi, count]) => ({ desi, count }))
        .sort((a, b) => {
          // Sort numerically if both are numbers, otherwise alphabetically
          const aNum = parseInt(a.desi, 10)
          const bNum = parseInt(b.desi, 10)
          if (!isNaN(aNum) && !isNaN(bNum)) {
            return aNum - bNum
          }
          return a.desi.localeCompare(b.desi)
        })
      result[mode] = entries
    }

    return result
  }, [vehicles])

  return (
    <Card className="w-full">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Transport Filters</CardTitle>
          <div className="flex items-center gap-2">
            {isConnecting ? (
              <Badge
                variant="secondary"
                className="bg-yellow-100 text-yellow-800"
              >
                Connecting...
              </Badge>
            ) : isConnected ? (
              <Badge
                variant="secondary"
                className="bg-green-100 text-green-800"
              >
                Live
              </Badge>
            ) : (
              <Badge variant="secondary" className="bg-red-100 text-red-800">
                Disconnected
              </Badge>
            )}
          </div>
        </div>
        {error && (
          <div className="mt-2 flex items-center gap-2">
            <span className="text-sm text-red-600">{error}</span>
            <Button variant="outline" size="sm" onClick={onReconnect}>
              Retry
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-0">
        {transportModes.map((mode) => (
          <TransportModeToggle
            key={mode}
            mode={mode}
            enabled={modes[mode]}
            count={counts[mode]}
            onToggle={(enabled: boolean) => onToggleMode(mode, enabled)}
            desiValues={desiByMode[mode]}
            selectedDesi={selectedDesiByMode[mode]}
            onDesiToggle={(desi, checked) => onDesiToggle(mode, desi, checked)}
            onSelectAll={() => onSelectAllDesi(mode)}
            onDeselectAll={() => onDeselectAllDesi(mode)}
          />
        ))}
        <div className="mt-4 border-t pt-4">
          <div className="flex items-center justify-between">
            <span className="font-semibold">Total Vehicles</span>
            <Badge variant="default" className="min-w-[60px] justify-center">
              {totalCount}
            </Badge>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
