# Meridian

A live situational map built from public data. Pick an area of interest (Middle East by default, or anywhere via **Use view**) and Meridian pulls in live aircraft, earthquakes and satellite fire detections, then surfaces the few things worth a human's attention as **signals**: aircraft squawking emergency codes, M4.5+ earthquakes, and clusters of fire detections.

It's modelled on how platforms like Palantir Gotham work: ingest messy feeds, normalize them into one shape, and put an analysis layer on top.

## The claim checker

Two ways in:

- **Pick on map (no AI):** click the spot, choose the event type, search radius and time window. No Anthropic key needed. This is the default when no key is set.
- **Describe it (AI):** paste a claim in plain words and Claude turns it into the same structured fields. Uses your own `ANTHROPIC_API_KEY` if set; otherwise Netlify's built-in AI Gateway (no Anthropic account needed, billed in Netlify credits, capped at 50 reads a day).

Both feed the same verification engine. The AI is only an input shortcut: remove it and every check still works.

Paste a claim, like *"Large explosion reported at the port of Haifa last night"*, and Meridian checks it against physical sensor data:

1. **Read the claim.** Claude turns the text into structured fields: event type, place, coordinates, search radius and time window.
2. **Pick the sensors that could see it.** Explosions and airstrikes: satellite heat detection and seismic sensors. Fires: satellites. Earthquakes: seismic. Aircraft incidents: live transponders (recent claims only).
3. **Pull the evidence** from NASA FIRMS, USGS and OpenSky (or adsb.lol / adsb.fi) for that exact circle and window.
4. **Decide the verdict by fixed rules, not by the AI:**
   - **Supported** – two independent sensors agree, or a strong single signal
   - **Some data is consistent** – one weaker signal
   - **No sensor signal found** – sensors that should see it saw nothing (which isn't proof it didn't happen)
   - **Can't be checked** – opinions, predictions, or events our sensors can't see

The search circle and matching evidence are drawn on the map. Every verdict lists its findings and its caveats, such as satellite pass timing and cloud cover.

**Ships.** For recent claims, Meridian listens to live ship transponders (AIS) around the location for 20 seconds and flags vessels reporting a distress status: *not under command*, *aground*, or an active emergency beacon.

**Before/after satellite images.** Each check finds the clearest Sentinel-2 image before the event and the first clear one after it, and shows them side by side. Images are for a human to compare; they never change the verdict. If no clear pass has happened yet, the saved check tries again every 6 hours, so a shared link fills in on its own.

**Share links.** Every check is saved and gets a permanent link (`?check=<id>`). The result is stored on the server, so a shared link can't be edited to show a different verdict.

### How a check runs

```
GET  /api/capabilities   which features have keys configured (never returns the keys)
POST /api/check          { claim } or { manual }: saves it, starts the background job, returns an id at once
  /api/run-check         background job (up to 15 min): Claude -> sensors -> verdict -> images
GET  /api/result?id=     the page polls this for progress; shared links load it too
GET  /api/image?id=&which=before|after   saved satellite images
```

Results and images are stored in Netlify Blobs, which needs no setup on Netlify.

Keeping the verdict in code rather than in the AI is a deliberate design choice: the language model only reads text, and it can't be argued into a conclusion the data doesn't support.

## How it works

```
Browser (index.html + src/)            Netlify Functions (netlify/functions/)        Sources
  map, regions, layers, signals  --->   /api/flights  --->  normalize to GeoJSON --->  OpenSky Network
                                        /api/quakes   --->                       --->  USGS
                                        /api/fires    --->                       --->  NASA FIRMS
```

- **Front end** (`src/`): plain JavaScript modules and MapLibre GL. No build step.
- **Functions** (`netlify/functions/`): small server endpoints that call each source, convert it to the same GeoJSON format, and cache results at Netlify's edge so many viewers share one upstream call.
- **Transforms** (`netlify/functions/_lib/transforms.mjs`): pure functions, one per source. This is where messy data becomes clean data, and it's fully unit-tested.
- **Signals** (`src/signals.js`): the analysis layer. Starts rule-based; phase 2 adds AI.
- **Demo mode**: if a feed can't be reached, the layer shows generated sample data marked **DEMO**, so the map is never empty.

## Run it on your computer

1. Install [Node.js](https://nodejs.org) 18 or newer.
2. In this folder, run `npm install`, then copy `.env.example` to `.env` and add your keys (see below).
3. Run `npm run dev` and open the address it prints (usually http://localhost:8888).
4. Run `npm test` to check the data logic.

Opening `index.html` directly works too, but every layer will be in DEMO mode because the `/api` functions only run under `netlify dev` or on Netlify.

## Keys (all free to start)

| Key | Layer | Where to get it |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | "Describe it" mode of the claim checker (optional, pay per use; "Pick on map" works without it) | https://console.anthropic.com. Set a monthly spend limit. |
| `AISSTREAM_API_KEY` | Ship sensor (free) | https://aisstream.io, sign in with GitHub, then API Keys |
| `CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET` | Satellite images (free) | Copernicus Data Space account, then an OAuth client in the Sentinel Hub dashboard |
| `FIRMS_MAP_KEY` | Fires and claim checker (required) | https://firms.modaps.eosdis.nasa.gov/api/map_key/ |
| `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET` | Aircraft (optional, raises OpenSky's daily limit when running locally) | Create an OpenSky account, then Account > API client |

Earthquakes need no key. Each claim check makes one Claude call, so cost scales with how many people use it; the endpoint also limits each visitor to 5 checks a minute.

**Aircraft on Netlify.** OpenSky doesn't accept connections from Netlify's servers, so no OpenSky key helps there. `/api/flights` tries OpenSky for 5 seconds, then falls back to the free community feed [adsb.fi](https://github.com/adsbfi/opendata), with [adsb.lol](https://api.adsb.lol/docs) as a backup for any circle adsb.fi can't answer (since Oct 2026 adsb.lol rejects point queries with an empty 400; its terms say an API key will become required). Those only answer for a 250 nm circle around a point, so a region is covered with up to 8 circles. The Middle East, Red Sea, Europe and Global views are bigger than that, so their coverage is partial: the 8 circles are aimed at the busiest airports (each one placed to take in the most airport traffic not already covered), and the layer shows **PARTIAL** instead of LIVE. Pick a smaller area or use "Use view" to see every plane. Both feeds limit requests per IP (adsb.fi: 1 a second; adsb.lol: 4 a second, 60 a minute, 500 a day), so answers are cached at the CDN for 60 seconds.

**AI on Netlify.** Netlify's AI Gateway injects its own `ANTHROPIC_API_KEY` plus an `ANTHROPIC_BASE_URL` pointing at the gateway. Meridian uses it when you haven't set your own key: it calls `claude-haiku-5-5` (a claim read costs roughly 0.03 Netlify credits) and stops at `AI_DAILY_LIMIT` reads a day (default 50) so the free plan's 300 monthly credits can't run dry. Set your own `ANTHROPIC_API_KEY` to use Anthropic directly with a stronger model, or `MERIDIAN_AI=off` to disable AI mode.

## Put it online

1. Push this folder to a GitHub repo.
2. In Netlify: Add new site > Import from GitHub > pick the repo. No build command; publish directory is `.`.
3. Add the keys under Site configuration > Environment variables, then redeploy.

## Adding a region

Add one line to `src/regions.js` with a name and a `[west, south, east, north]` box. It appears in the dropdown automatically.

## Roadmap

**Phase 1 (done):** region switcher, live aircraft, earthquakes, fires, rule-based signals, demo mode, tests.

**Claim checker v1 (done):** Claude extracts the claim, three sensors gather evidence, rule-based verdict with caveats, drawn on the map.

**Claim checker v2 (done):** ships as a fourth sensor, before/after Sentinel-2 images, saved checks with permanent share links, background processing.

**Claim checker next:**
- Store ship and aircraft history so older claims can use them too.
- A preview card (title and image) when a share link is posted on social media.

**Phase 2: ships and news**
- Ship positions via AIS (aisstream.io is free; Spire or MarineTraffic for satellite coverage). Needs a small always-on worker since AIS streams over a WebSocket.
- "Went dark" detection: a ship or aircraft stops transmitting inside the region.
- News events with locations from GDELT.

**Phase 3: the AI analyst**
- Store everything in Postgres + PostGIS (Supabase) so you can query history: "what was near here yesterday?"
- Claude API reads news items, extracts places and entities, and links them to nearby tracks and events.
- An "Ask the map" box: plain-English questions answered from your own data, with sources.

**Phase 4: polish for the portfolio**
- Time slider to replay the last 24 hours.
- Watch zones that alert you when something enters them.
- Demo video, write-up, LinkedIn post.

## Rough monthly cost

Phase 1 runs on free tiers. Phases 2–3 add hosting for the ship worker, a database and Claude API usage, which should fit under the $50/month target; check each provider's current pricing before signing up.

## Notes

- Basemap: CARTO Dark Matter (free for non-commercial use). Swap `BASEMAP` in `src/app.js` for Mapbox or MapTiler later if you want a 3D globe.
- Only public data. Don't add sources that track private individuals.
