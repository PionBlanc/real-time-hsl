# HSL Live

A tiny, mobile-first live map of HSL vehicles. It opens on your GPS position
(once you've shared it) and shows the buses, trams, metros, trains and ferries around you,
moving in real time.

- **Tap a vehicle**: its route is drawn (driven part greyed, remaining part in
  the line colour, stop dots), and a card shows destination, delay, speed and the
  next stops with ETAs. The map follows it until you pan.
- **Tap a stop** (stop dots appear when zoomed in, and on a selected vehicle's
  route): a live departures board like the screens at stops. It shows the next
  departures with realtime estimates (pulsing dot) and refreshes every 20 s. Tap
  a departure marked with a pin to jump to that vehicle on the map. The stop is
  kept in the URL (`/?stop=hsl:1130446`), so you can bookmark "your" stop.
- **Type a line** (`551`, `15 9`, `M1`) to see that line's vehicles anywhere in
  the region. The filter is kept in the URL (`/?line=551`), so you can bookmark it.
- **Type a vehicle number** (`#1234`, the *kylkinumero* on the side of the bus) to
  find that vehicle anywhere. Operators can share numbers, so there may be more than one.
  Combine with lines: `551 #1234`.
- **Type chips** under the search bar: tap Bus / Tram / … to hide or show that type.
- **Cities**: Helsinki (HSL), Tampere (Nysse), Turku (Föli) and Jyväskylä (Linkki) work the
  same way, as far as each city's data goes: only HSL sends delays and door status, Turku's feed has
  no vehicle numbers, and the type chips only show the city's own modes. Anything a feed lacks is
  left out, never guessed (see `api/_cities.ts`). Zoom out to see a marker
  per city; tap one to go there. Searches and stop links follow the city on screen, which is
  kept in the URL (`/?city=tampere&line=3`, `/?stop=tampere:3598`).
- **Privacy** (bottom left): what the app stores (only in your browser) and sends, and a
  "Forget my location" button. No cookies or analytics. Keep its text in sync if that changes.
- **Crosshair**: show your location. The location permission is only requested when you tap
  it; after that, the app opens on your position automatically.

## How it works

| Piece | What | Size |
| --- | --- | --- |
| `api/_cities.ts` | **The cities**: feed ids, Digitransit router, service area, id shapes. Shared by the app and `/api`. Adding a city starts here | |
| `src/feed.ts` | What all live feeds have in common: the `Msg` every vehicle update becomes, and the `Feed` interface | |
| `src/mqtt.ts` | Minimal MQTT-over-WebSocket client (no key needed for either broker) | ~2 KB |
| `src/live.ts` | One MQTT connection per broker, opened only once something on it is wanted | |
| `src/hfp.ts` | HSL's [HFP](https://digitransit.fi/en/developers/apis/5-realtime-api/vehicle-positions/high-frequency-positioning/) feed (`wss://mqtt.hsl.fi`). Builds **geohash topic filters for the visible map area** so the phone only receives nearby vehicles. When zoomed out it subscribes only to "moved ~100 m" updates (~12 % of traffic) | |
| `src/gtfsrt.ts` | Digitransit's [GTFS-RT feed](https://digitransit.fi/en/developers/apis/5-realtime-api/vehicle-positions/digitransit-mqtt/) for the other cities (`wss://mqtt.digitransit.fi`): same geohash area filters, plus a tiny protobuf decoder. No delay or door status in this feed | |
| `src/city-markers.ts` | Zoomed-out city markers | |
| `src/vehicles.ts` | Leaflet markers, batched per frame, smooth CSS movement | |
| `src/trip-line.ts` | Route drawing split at the vehicle | |
| `api/trip.ts` | Edge function: vehicle → GTFS trip (path + stops): by trip id (GTFS-RT) or Digitransit `fuzzyTrip` (HSL) | CDN-cached 1 day |
| `src/stops.ts` | Stop dots for the visible area (zoom ≥ 15), loaded per fixed grid cell | |
| `api/stop.ts` | Edge function: a stop's next departures (realtime where available) | CDN-cached 15 s |
| `api/stops.ts` | Edge function: stops in one grid cell | CDN-cached 1 day |
| `api/routes.ts` | Edge function: line number → route ids, for the line filter | CDN-cached |
| `api/tile.ts` | Node function (Stockholm): proxies HSL's English background map tiles and converts them to WebP. Only the cities' areas close up, all of Finland when zoomed out | CDN-cached 30 days |
| `public/sw.js` | Service worker: the app opens instantly from cache after the first visit | |

The whole app is about 52 KB of JS and 8 KB of CSS (gzipped), mostly Leaflet. Live data
pauses when the tab is in the background.

## Digitransit API key

> **Rules:** the terms of use, attribution, rate limits and MQTT guidance are summarised,
> with links, in [docs/API-TERMS.md](docs/API-TERMS.md). Read it before changing anything in `/api`.

Route paths, the line filter and the HSL map tiles need a free key from
<https://portal-api.digitransit.fi/>. Set it as **`DIGITRANSIT_API_KEY`** in
Vercel (Project → Settings → Environment Variables, for Production *and* Preview)
and redeploy. The key is only used server-side in `/api`.

Without a key the app still shows live vehicles on OpenStreetMap's tiles (for
development only: their usage policy forbids production traffic, so a Vercel production
build fails without the key); tapping a
vehicle shows its info but no route.

## Development

```bash
bun install
echo "DIGITRANSIT_API_KEY=..." > .env   # optional
bun run dev       # http://localhost:3000, /api functions run locally too
bun run dev:lan   # same, but reachable from your phone on the same network
bun run test
bun run build
```

`VITE_BROKER=ws://localhost:18884 bun run dev` points the app at a local MQTT
broker for testing with simulated vehicles.

`dev:lan` exposes the dev server, including the `/api` proxy that uses your key, to
everyone on the network. Only use it on networks you trust, and stop it when you're done.
