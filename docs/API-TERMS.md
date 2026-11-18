# HSL / Digitransit API rules

This is a summary of the rules that apply to the external services this app uses, with links to
the source pages. It was last checked on **2026-11-17**. The terms can change without notice
(Terms §6, §10), so re-read the linked pages before relying on this file.

## Official pages

| Topic | Link |
| --- | --- |
| Terms of use (the binding document) | <https://digitransit.fi/en/developers/apis/7-terms-of-use/> |
| API keys, quotas, rate limiting | <https://digitransit.fi/en/developers/api-registration/> |
| Key portal (register, regenerate keys) | <https://portal-api.digitransit.fi/> |
| Routing API (GraphQL) | <https://digitransit.fi/en/developers/apis/1-routing-api/> |
| Background map tiles | <https://digitransit.fi/en/developers/apis/4-map-api/background-map/> |
| Realtime: HFP vehicle positions (MQTT) | <https://digitransit.fi/en/developers/apis/5-realtime-api/vehicle-positions/high-frequency-positioning/> |
| Deprecations | <https://digitransit.fi/en/developers/deprecations/> |
| HSL open data (license info) | <https://www.hsl.fi/en/hsl/open-data> |
| OpenStreetMap ODbL / attribution | <https://www.openstreetmap.org/copyright> |
| OSM tile usage policy (fallback map) | <https://operations.osmfoundation.org/policies/tiles/> |

## The rules and how this app follows them

### 1. License and attribution
- The data is licensed **CC BY 4.0**. You must credit Digitransit as the author, together with the
  date or time the data was received, for example "© Digitransit 2021" (Terms §3).
- Map, routing and geocoding data based on OpenStreetMap is under **ODbL**, which requires an
  OSM credit.
- **In the app:** the map's attribution line shows `Data © Digitransit <year>`, set in
  `src/main.ts`. The HSL map tiles add `© HSL © OSM`, and the OSM fallback tiles add
  `© OpenStreetMap`. Don't remove or hide `.leaflet-control-attribution`.

### 2. API keys
- Every request to `api.digitransit.fi` and `cdn.digitransit.fi` needs a key, sent in the
  `digitransit-subscription-key` header or URL parameter.
- Don't send the key to deprecated APIs.
- **In the app:** the key (`DIGITRANSIT_API_KEY`) is only used server-side, in `api/*.ts`, and is
  always sent as a header. The browser never sees it; only a `__HAS_KEY__` boolean is built into
  the bundle. Keep it that way, and never put the key in a client-side URL.

### 3. Rate limits and fair use
- Quotas have been enforced since 31.1.2024. They are meant to stop misuse, not normal use. If
  you hit the limits you get HTTP **403**; contact Digitransit if that happens.
- For batch jobs with thousands of requests, wait 0.5–1 s between requests.
- Digitransit can rate-limit or close an account without notice (Terms §3, §4), so keep the
  contact email on the portal account up to date.
- **In the app:** every Digitransit response is cached at Vercel's edge, which keeps the request
  volume low however many people use the app:

  | Data | Cache |
  | --- | --- |
  | Trips | 1 day |
  | Line lookups | 1 day |
  | Stops per grid cell | 1 day |
  | Departures | 15 s |
  | Map tiles | 30 days |

  Stops are fetched per fixed grid cell so these caches are shared between users. Don't add
  uncached per-user polling.

### 4. Caching, proxying, redistribution
- None of the official pages say anything about caching responses or proxying tiles (as of the
  check date). The CC BY terms allow redistribution as long as attribution is kept.
- If Digitransit ever publishes caching rules, update the `cache-control` values in `api/*.ts` to
  follow them.

### 5. Routing API (GraphQL)
- Requests must use POST with `Content-Type: application/json`. This is in
  `api/_digitransit.ts`.
- The current endpoint is `https://api.digitransit.fi/routing/v2/hsl/gtfs/v1`. Routing v1 was
  removed in 2025.
- Avoid deprecated queries and fields. ⚠️ `stopsByBbox` (used in `api/stops.ts`) is not listed on
  the [stops docs page](https://digitransit.fi/en/developers/apis/1-routing-api/stops/), which
  only documents `stopsByRadius`, `stops`, `stop` and `nearest`. It works, but if it is ever
  removed, switch to `stopsByRadius` or `nearest`.

### 6. Map tiles
- Use map **v3**: `cdn.digitransit.fi/map/v3/<source>/…`. v1 and v2 have been removed.
- **In the app:** `api/tile.ts` proxies the `hsl-map-en` source with the key in a header and
  converts the tiles to WebP. The map's attribution stays as described in section 1.

### 7. HFP / MQTT (`wss://mqtt.hsl.fi:443/`, no key needed)
- In browsers, use port 443 (TLS). The docs prefer it to protect users' location privacy.
- End every topic filter with `#`, so new topic levels HSL adds later don't break subscriptions.
- In topic filters, operator ids must be exactly 4 digits and vehicle numbers exactly 5 digits
  (zero-padded). See `vehicleNumberFilter` in `src/hfp.ts`.
- `deadrun` and `signoff` messages are only for authorized users. This app subscribes only to
  `journey/ongoing/vp`.
- There is no stated limit on the number of filters ("Go hog wild"). The app caps itself at 160,
  and when zoomed out it subscribes only to geohash levels 0–3 to save bandwidth.

### 8. Fallback map without a key (OpenStreetMap tiles)
- `tile.openstreetmap.org` has its own usage policy: it requires attribution and forbids heavy or
  bulk use. It is only meant as a no-key fallback for development. Production should always have
  `DIGITRANSIT_API_KEY` set so the HSL tiles are used.
