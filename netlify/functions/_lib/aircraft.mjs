// Live aircraft for a box, used by the map layer and by aircraft claim checks.
// OpenSky first. Netlify's servers can't reach OpenSky at all (connections time out
// before any credentials are sent), so in production we fall back to two community
// ADS-B feeds, adsb.fi and then adsb.lol. They answer from the cloud but only for
// "aircraft within 250 nm of a point", so a box is covered with a few circles.

import { fetchWithTimeout, HttpError } from "./util.mjs";
import { openSkyToFeatures, adsbToFeatures } from "./transforms.mjs";

const OPENSKY_TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const OPENSKY_TIMEOUT_MS = 5000;   // fail over fast; a blocked connection otherwise hangs ~10 s
const ADSB_DEADLINE_MS = 9000;     // stop starting new circle requests after this
const MAX_RADIUS_NM = 250;         // both feeds' limit
const MAX_CIRCLES = 8;             // keeps one map refresh well inside the feeds' rate limits
const KM_PER_NM = 1.852;
const USER_AGENT = "Meridian (+https://github.com/peterhunt400/meridian)";

// Tried in order; a circle one feed can't answer goes to the next. adsb.fi first:
// since Oct 2026 adsb.lol answers every point query with an empty 400 (its terms
// say an API key will become required), so it stays only as the backup.
// intervalMs is each feed's per-IP limit, as the minimum gap between request starts.
// adsb.fi: 1/s. adsb.lol: 4/s, 60/min, 500/day.
const ADSB_FEEDS = [
  { name: "adsb.fi", intervalMs: 1050, url: (c) => `https://opendata.adsb.fi/api/v2/lat/${c.lat}/lon/${c.lon}/dist/${c.radiusNm}` },
  { name: "adsb.lol", intervalMs: 350, url: (c) => `https://api.adsb.lol/v2/point/${c.lat}/${c.lon}/${c.radiusNm}` },
];

let cachedToken = null; // { value, expiresAt } — survives between calls on a warm function

async function openSkyToken() {
  const id = process.env.OPENSKY_CLIENT_ID;
  const secret = process.env.OPENSKY_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.value;
  const res = await fetchWithTimeout(OPENSKY_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
  }, OPENSKY_TIMEOUT_MS);
  const data = await res.json();
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 1800) * 1000 };
  return cachedToken.value;
}

async function fromOpenSky([w, s, e, n]) {
  const token = await openSkyToken();
  const url = `https://opensky-network.org/api/states/all?lamin=${s}&lomin=${w}&lamax=${n}&lomax=${e}`;
  const res = await fetchWithTimeout(url, token ? { headers: { authorization: `Bearer ${token}` } } : {}, OPENSKY_TIMEOUT_MS);
  return { features: openSkyToFeatures(await res.json()), meta: { source: "OpenSky Network", authenticated: Boolean(token), coverage: "full" } };
}

// Pure: circles (≤ 250 nm) whose union covers the box. When the box needs more
// than `max`, aim the circles at the busiest airports (see aimAtTraffic) and
// report the coverage as incomplete.
export function coverCircles([w, s, e, n], max = MAX_CIRCLES) {
  const radiusKm = MAX_RADIUS_NM * KM_PER_NM;
  const widestLat = s <= 0 && n >= 0 ? 0 : Math.min(Math.abs(s), Math.abs(n)); // boxes are widest nearest the equator
  const widthKm = (e - w) * 111.32 * Math.cos((widestLat * Math.PI) / 180);
  const heightKm = (n - s) * 111.32;
  const step = radiusKm * Math.SQRT2; // a square this wide fits inside one circle
  const needX = Math.max(1, Math.ceil(widthKm / step));
  const needY = Math.max(1, Math.ceil(heightKm / step));
  const complete = needX * needY <= max;
  // Too big: the grid with the most circles that fits `max`, shaped like the box.
  let nx = needX, ny = needY;
  if (!complete) {
    let best = null;
    for (let y = 1; y <= Math.min(needY, max); y++) {
      const x = Math.min(needX, Math.floor(max / y));
      const shapeError = Math.abs(Math.log((x / y) / (widthKm / heightKm)));
      if (!best || x * y > best.x * best.y || (x * y === best.x * best.y && shapeError < best.shapeError)) best = { x, y, shapeError };
    }
    ({ x: nx, y: ny } = best);
  }

  const cellHalfDiagKm = Math.hypot(widthKm / nx, heightKm / ny) / 2;
  const radiusNm = Math.max(1, Math.min(MAX_RADIUS_NM, Math.ceil(cellHalfDiagKm / KM_PER_NM)));
  const grid = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      grid.push({
        lat: round3(s + ((j + 0.5) * (n - s)) / ny),
        lon: round3(w + ((i + 0.5) * (e - w)) / nx),
        radiusNm,
      });
    }
  }
  if (complete) return { circles: grid, complete };
  return { circles: aimAtTraffic([w, s, e, n], grid, max), complete };
}

// Busy airports, with a rough weight (millions of passengers a year). When a box
// is too big to cover, circles go where the planes are instead of empty desert.
export const HUBS = [
  // Middle East and neighbours
  ["DXB", 25.25, 55.36, 87], ["IST", 41.26, 28.74, 80], ["DOH", 25.27, 51.61, 52], ["JED", 21.68, 39.16, 49],
  ["SAW", 40.90, 29.31, 41], ["AYT", 36.90, 30.80, 38], ["RUH", 24.96, 46.70, 37], ["CAI", 30.12, 31.41, 32],
  ["ATH", 37.94, 23.94, 31], ["AUH", 24.43, 54.65, 29], ["TLV", 32.01, 34.89, 21], ["SHJ", 25.33, 55.52, 17],
  ["KWI", 29.24, 47.97, 15], ["MCT", 23.59, 58.28, 15], ["THR", 35.69, 51.31, 15], ["ESB", 40.13, 32.99, 14],
  ["ADB", 38.29, 27.16, 12], ["DMM", 26.47, 49.80, 11], ["MED", 24.55, 39.70, 10], ["IKA", 35.42, 51.15, 10],
  ["MHD", 36.24, 59.64, 10], ["KHI", 24.91, 67.16, 10], ["BAH", 26.27, 50.63, 9], ["AMM", 31.72, 35.99, 9],
  ["LCA", 34.88, 33.63, 9], ["HRG", 27.18, 33.80, 9], ["SSH", 27.98, 34.39, 8], ["BEY", 33.82, 35.49, 7],
  ["BGW", 33.26, 44.23, 7], ["EBL", 36.24, 43.96, 3],
  // Europe
  ["LHR", 51.47, -0.45, 83], ["CDG", 49.01, 2.55, 70], ["AMS", 52.31, 4.76, 66], ["MAD", 40.47, -3.56, 66],
  ["FRA", 50.03, 8.56, 62], ["BCN", 41.30, 2.08, 55], ["FCO", 41.80, 12.25, 50], ["LGW", 51.15, -0.19, 43],
  ["MUC", 48.35, 11.79, 41], ["LIS", 38.77, -9.13, 35], ["DUB", 53.42, -6.27, 33], ["ZRH", 47.46, 8.55, 31],
  ["VIE", 48.11, 16.57, 31], ["CPH", 55.62, 12.65, 30], ["OSL", 60.19, 11.10, 25], ["ARN", 59.65, 17.92, 25],
  ["BRU", 50.90, 4.48, 24], ["WAW", 52.17, 20.97, 21],
  // North America
  ["ATL", 33.64, -84.43, 105], ["DFW", 32.90, -97.04, 81], ["ORD", 41.98, -87.90, 80], ["DEN", 39.86, -104.67, 77],
  ["LAX", 33.94, -118.41, 75], ["JFK", 40.64, -73.78, 62], ["MIA", 25.80, -80.29, 55], ["SFO", 37.62, -122.38, 50],
  ["SEA", 47.45, -122.31, 50], ["EWR", 40.69, -74.17, 49], ["YYZ", 43.68, -79.62, 46], ["MSP", 44.88, -93.22, 37],
  ["DTW", 42.21, -83.35, 33], ["YVR", 49.19, -123.18, 26], ["YUL", 45.47, -73.74, 21], ["MDW", 41.79, -87.75, 20],
  ["CLE", 41.41, -81.85, 10], ["PIT", 40.49, -80.23, 9], ["YOW", 45.32, -75.67, 5], ["BUF", 42.94, -78.73, 5],
  // Rest of the world
  ["HND", 35.55, 139.78, 85], ["DEL", 28.56, 77.10, 73], ["CAN", 23.39, 113.30, 63], ["SIN", 1.36, 103.99, 59],
  ["ICN", 37.46, 126.44, 56], ["CGK", -6.13, 106.66, 55], ["PVG", 31.14, 121.81, 54], ["PEK", 40.08, 116.58, 53],
  ["BOM", 19.09, 72.87, 52], ["BKK", 13.69, 100.75, 51], ["KUL", 2.75, 101.71, 47], ["GRU", -23.43, -46.47, 41],
  ["HKG", 22.31, 113.91, 40], ["SYD", -33.94, 151.18, 38], ["JNB", -26.14, 28.24, 19],
];

// Pure: pick up to `max` full-size circles. Each one is centred on the airport
// whose circle would take in the most not-yet-covered airport traffic (so one
// circle can catch a cluster like Tel Aviv + Amman + Beirut). Leftover slots go
// to the evenly spread grid circles furthest from anything chosen.
export function aimAtTraffic([w, s, e, n], grid, max) {
  const radiusKm = MAX_RADIUS_NM * KM_PER_NM;
  const hubs = HUBS.filter(([, lat, lon]) => lat >= s && lat <= n && lon >= w && lon <= e);
  const reach = new Map(hubs.map(([code, lat, lon]) => [code,
    hubs.filter(([, la, lo]) => km([lon, lat], [lo, la]) <= radiusKm)]));
  const chosen = [];
  const covered = new Set();
  while (chosen.length < max) {
    let best = null, bestGain = 0;
    for (const [code, lat, lon] of hubs) {
      const gain = reach.get(code).reduce((sum, h) => sum + (covered.has(h[0]) ? 0 : h[3]), 0);
      if (gain > bestGain) { best = { code, lat, lon }; bestGain = gain; }
    }
    if (!best) break;
    chosen.push({ lat: best.lat, lon: best.lon, radiusNm: MAX_RADIUS_NM, hub: best.code });
    for (const h of reach.get(best.code)) covered.add(h[0]);
  }
  const rest = grid
    .map((c) => ({ ...c, radiusNm: MAX_RADIUS_NM, gap: Math.min(Infinity, ...chosen.map((h) => km([c.lon, c.lat], [h.lon, h.lat]))) }))
    .filter((c) => c.gap > radiusKm)
    .sort((a, b) => b.gap - a.gap);
  for (const c of rest) {
    if (chosen.length >= max) break;
    chosen.push({ lat: c.lat, lon: c.lon, radiusNm: c.radiusNm });
  }
  return chosen;
}

function km([lon1, lat1], [lon2, lat2]) {
  const r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

async function fromAdsbFeeds(bbox, deadline) {
  const { circles, complete } = coverCircles(bbox);
  const answers = new Array(circles.length).fill(null);
  const used = new Set();
  const failures = [];
  let lastError = null;

  for (const feed of ADSB_FEEDS) {
    const todo = circles.map((_, i) => i).filter((i) => !answers[i]);
    if (!todo.length) break;
    await Promise.all(todo.map(async (i, k) => {
      await sleep(k * feed.intervalMs);
      if (Date.now() > deadline) return;
      try {
        const res = await fetchWithTimeout(feed.url(circles[i]), { headers: { "user-agent": USER_AGENT } }, 4000);
        answers[i] = await res.json();
        used.add(feed.name);
      } catch (err) {
        lastError = err;
        failures.push(`${feed.name}: ${err.name === "AbortError" ? "timed out" : err.message}`);
      }
    }));
  }
  if (failures.length) console.warn(`ADS-B circles that failed: ${failures.join("; ")}`);

  const answered = answers.filter(Boolean);
  if (!answered.length) throw lastError || new HttpError(502, "No aircraft feed answered");
  const coverage = complete && answered.length === circles.length ? "full" : "partial";
  return {
    features: adsbToFeatures(answered, bbox),
    meta: { source: [...used].join(" + "), coverage, circles: `${answered.length}/${circles.length}` },
  };
}

// Once OpenSky fails, a warm function skips it for a while instead of waiting
// out its timeout on every request.
const OPENSKY_RETRY_MS = 10 * 60_000;
let openSkyDownUntil = 0;

// Returns { features, meta } with meta.source naming whichever feed answered.
export async function fetchAircraft(bbox) {
  if (Date.now() >= openSkyDownUntil) {
    try {
      return await fromOpenSky(bbox);
    } catch (err) {
      openSkyDownUntil = Date.now() + OPENSKY_RETRY_MS;
      console.warn(`OpenSky unavailable, using ADS-B feeds for ${OPENSKY_RETRY_MS / 60_000} min: ${err.cause?.code || err.message}`);
    }
  }
  return fromAdsbFeeds(bbox, Date.now() + ADSB_DEADLINE_MS);
}

function sleep(ms) { return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve(); }
function round3(n) { return Math.round(n * 1000) / 1000; }
