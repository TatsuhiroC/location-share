# Development & deployment

[README](../README_EN.md) · [简体中文](development.md)

## Run locally

Requires Node.js 22.12 or later.

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:8787>. Development uses a publicly known test signing key and stores local data in the ignored `.wrangler/` directory, without a public domain. Phone geolocation usually requires HTTPS rather than a plain HTTP LAN address.

## Deploy to Cloudflare

The app and API share an origin on Cloudflare Workers, with Static Assets, SQLite Durable Objects and native rate-limit bindings.

1. Set the Worker name, `routes` and `PUBLIC_ORIGIN` in `wrangler.jsonc`. The custom domain’s active zone must belong to your deployment account. `workers.dev` and preview URLs are disabled by default.
2. For a **new deployment**, set `LEGACY_CAPABILITIES_UNTIL` to an empty string. The repository’s fixed cutoff only supports migration of the original deployment’s old links; never extend it with every update.
3. Sign in, configure the server signing key once, then deploy:

```sh
npx wrangler login
npm run signing:setup
npm run deploy
```

`signing:setup` generates a random 256-bit key and sends it through standard input to the Worker secret `CAPABILITY_KEY`. It does not print or save the key to the repository. Users never enter this server configuration. **Run it only for initial setup**: repeating it rotates the key and invalidates existing new-format links. Routine updates only need `npm run deploy`. Creation fails without a key and writes no request record.

The current site binds `location.pizzasend.dpdns.org` to the `location-share` Worker. PizzaSend uses a different subdomain and Worker. Storage and rate limits are separate, while some account-level platform quotas may be shared. Never commit Cloudflare credentials or production keys.

## Checks & maintenance

```sh
npm run check
npm test
npx playwright install chromium webkit
npm run test:browser
npm run build
```

- `check` verifies JavaScript syntax, vendored browser code against locked dependencies, and consistency of static/API security headers.
- Browser tests use temporary isolated storage and simulated locations, intercepting third-party map resources. They do not collect anyone’s location; passing WebKit tests is not an iPhone device test.
- `build` validates packaging without publishing. GitHub runs the same checks.
- After dependency updates, run `npm run vendor:sync`. After changing `src/security.js`, run `npm run headers:sync`. Vendored libraries retain their licenses; the MapLibre adapter only changes module import paths.

## Implementation & limits

- **Location snapshot**: geolocation starts only after explicit consent. `enableHighAccuracy: true` cannot override system permissions. An estimated radius over 100 metres prompts a choice before upload; this threshold does not detect the OS’s precise-location setting. Samples older than five minutes are rejected. No continuous tracking.
- **Access**: submission and viewing capabilities have separate roles and HMAC-SHA-256 signatures verified before database access. Capabilities live in URL fragments; records store only their hashes. After successful verification, the tab saves access in `sessionStorage` and removes the capability from the address bar. If storage is unavailable, the full link remains.
- **Storage**: transactions enforce one snapshot, with idempotent retries for the same submission ID and content. Links expire after one hour; access is denied immediately, with background alarms clearing records. Viewers can delete early. HTTPS is not end-to-end encryption, and deletion does not promise immediate removal from platform backups.
- **Abuse controls**: valid creation is limited to five per source per minute and 300 site-wide per UTC day, alongside source, link and record limits. Bodies are capped at 4 KiB with a five-second read deadline. IPv6 sources are grouped by /64. Public creation quotas can still be exhausted; edge limits are per location, not precise global quotas or guaranteed DDoS protection. See the [security review (中文)](security-review.md).
- **Maps**: Leaflet, MapLibre and QR generation are locally hosted. The default Nordic light map customizes OpenFreeMap Positron, alongside Liberty and Dark. Vector components load only after receipt. No WebGL2, initialization failure or a 12-second loading deadline triggers OSM raster fallback. Coordinates and maps-app links remain available when maps fail or polar coordinates exceed the projection range.
- **External services**: Amap receives `coordinate=wgs84` and Baidu receives `coord_type=wgs84`. Mobile Baidu offers native and web fallback links. App launching depends on the device and installed apps. Map providers see network information and requested areas; capability fragments are not included in map links or external Referer headers.

Locking the device, backgrounding or unloading the page, and losing connectivity can interrupt geolocation or upload. Cancellation only stops uploads that have not started. Mainland China network reachability and iPhone/Android behavior need device testing; see [validation scope (中文)](validation.md).

## References

[W3C Geolocation](https://www.w3.org/TR/geolocation/) · [iPhone location settings](https://support.apple.com/102647) · [Android location permissions](https://support.google.com/pixelphone/answer/9083622)

[MapLibre](https://maplibre.org/maplibre-gl-js/docs/) · [Leaflet](https://leafletjs.com/reference.html) · [OSM tile policy](https://operations.osmfoundation.org/policies/tiles/) · [Amap](https://lbs.amap.com/api/uri-api/guide/mobile-web/point) · [Baidu](https://lbs.baidu.com/docs/webapi?title=mapadjustment/uri/web) · [Google Maps](https://developers.google.com/maps/documentation/urls/get-started) · [Apple Maps](https://developer.apple.com/documentation/mapkit/unified-map-urls)
