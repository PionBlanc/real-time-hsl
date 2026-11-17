# HSL Live

A tiny, mobile-first live map of HSL vehicles. It opens straight on your GPS
position and shows the buses, trams, metros, trains and ferries around you,
moving in real time.

- **Tap a vehicle**: its route is drawn (driven part greyed, remaining part in
  the line colour, stop dots), and a card shows destination, delay, speed and the
  next stops with ETAs. The map follows it until you pan.
- **Type a line** (`551`, `15 9`, `M1`) to see that line's vehicles anywhere in
  the region. The filter is kept in the URL (`/?line=551`), so you can bookmark it.
- **Sliders button**: show/hide vehicle types.
- **Crosshair**: back to your location.

## How it works

| Piece | What | Size |
| --- | --- | --- |
| `src/mqtt.ts` | Minimal MQTT-over-WebSocket client for HSL's open [HFP](https://digitransit.fi/en/developers/apis/5-realtime-api/vehicle-positions/high-frequency-positioning/) feed (`wss://mqtt.hsl.fi`, no key) | ~2 KB |
| `src/hfp.ts` | Topic parsing; builds **geohash topic filters for the visible map area** so the phone only receives nearby vehicles. When zoomed out it subscribes only to "moved ~100 m" updates (~12 % of traffic) | |
| `src/vehicles.ts` | Leaflet markers, batched per frame, smooth CSS movement | |
| `src/trip-line.ts` | Route drawing split at the vehicle | |
| `api/trip.ts` | Edge function: vehicle → GTFS trip (path + stops) via Digitransit `fuzzyTrip` | CDN-cached 1 day |
| `api/routes.ts` | Edge function: line number → route ids, for the line filter | CDN-cached |
| `api/tile.ts` | Edge function: proxies HSL's English background map tiles | CDN-cached 30 days |
| `public/sw.js` | Service worker: the app opens instantly from cache after the first visit | |

The whole app is about 52 KB of JS and 8 KB of CSS (gzipped), mostly Leaflet. Live data
pauses when the tab is in the background.

## Digitransit API key

Route paths, the line filter and the HSL map tiles need a free key from
<https://portal-api.digitransit.fi/>. Set it as **`DIGITRANSIT_API_KEY`** in
Vercel (Project → Settings → Environment Variables, for Production *and* Preview)
and redeploy. The key is only used server-side in `/api`.

Without a key the app still shows live vehicles on a CARTO base map; tapping a
vehicle shows its info but no route.

## Development

```bash
bun install
echo "DIGITRANSIT_API_KEY=..." > .env   # optional
bun run dev       # http://localhost:3000, /api functions run locally too
bun run test
bun run build
```

`VITE_BROKER=ws://localhost:18884 bun run dev` points the app at a local MQTT
broker for testing with simulated vehicles.
