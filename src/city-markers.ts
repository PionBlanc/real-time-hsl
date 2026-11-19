import L from 'leaflet'
import { CITIES } from '../api/_cities'
import type { City } from '../api/_cities'
import { escapeHtml } from './trip-line'

/**
 * One marker per city, shown when zoomed out too far for vehicles. It's how you find the
 * other cities (and get back): tapping one zooms into that city.
 */
export class CityMarkers {
  private group = L.layerGroup()

  constructor(
    private map: L.Map,
    /** Shown below this zoom. */
    private belowZoom: number,
    onClick: (c: City) => void,
  ) {
    for (const c of CITIES) {
      L.marker(c.center, {
        icon: L.divIcon({
          className: 'city',
          html: escapeHtml(c.name),
          iconSize: undefined, // size from CSS
        }),
        title: `Show ${c.name}`,
        alt: c.name,
        keyboard: true, // focusable; Enter taps it
        riseOnHover: true,
      })
        .on('click', () => onClick(c))
        .addTo(this.group)
    }
    this.update()
  }

  /** Call after the map moved. */
  update(): void {
    if (this.map.getZoom() < this.belowZoom) this.group.addTo(this.map)
    else this.group.remove()
  }
}
