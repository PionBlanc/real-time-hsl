import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { TransportMode } from '@/lib/hsl-types'
import { TRANSPORT_COLORS, TRANSPORT_NAMES } from '@/lib/hsl-types'

interface TransportModeToggleProps {
  mode: TransportMode
  enabled: boolean
  count: number
  onToggle: (enabled: boolean) => void
}

function TransportModeToggle({
  mode,
  enabled,
  count,
  onToggle,
}: TransportModeToggleProps) {
  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex items-center gap-3">
        <div
          className="h-4 w-4 rounded-full"
          style={{ backgroundColor: TRANSPORT_COLORS[mode] }}
        />
        <span className="font-medium">{TRANSPORT_NAMES[mode]}</span>
      </div>
      <div className="flex items-center gap-3">
        <Badge variant="secondary" className="min-w-[50px] justify-center">
          {count}
        </Badge>
        <Switch checked={enabled} onCheckedChange={onToggle} />
      </div>
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
}: ControlPanelProps) {
  const transportModes: TransportMode[] = [
    'bus',
    'tram',
    'train',
    'metro',
    'ferry',
  ]

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
      <CardContent className="space-y-1">
        {transportModes.map((mode) => (
          <TransportModeToggle
            key={mode}
            mode={mode}
            enabled={modes[mode]}
            count={counts[mode]}
            onToggle={(enabled) => onToggleMode(mode, enabled)}
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
