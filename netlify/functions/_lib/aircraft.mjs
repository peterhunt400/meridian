// Live aircraft for a box, used by the map layer and by aircraft claim checks.
// OpenSky first. Netlify's servers can't reach OpenSky at all (connections time out
// before any credentials are sent), so in production we fall back to two community
// ADS-B feeds, adsb.lol and adsb.fi. They answer from the cloud but only for
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

// Each feed's per-IP limit, as the minimum gap between request starts.
// adsb.lol: 4/s, 60/min, 500/day. adsb.fi: 1/s.
const ADSB_FEEDS = [
  { name: "adsb.lol", intervalMs: 350, url: (c) => `https://api.adsb.lol/v2/point/${c.lat}/${c.lon}/${c.radiusNm}` },
  { name: "adsb.fi", intervalMs: 1050, url: (c) => `https://opendata.adsb.fi/api/v2/lat/${c.lat}/lon/${c.lon}/dist/${c.radiusNm}` },
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
// than `max`, spread `max` circles evenly and report the coverage as incomplete.
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
  const circles = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      circles.push({
        lat: round3(s + ((j + 0.5) * (n - s)) / ny),
        lon: round3(w + ((i + 0.5) * (e - w)) / nx),
        radiusNm,
      });
    }
  }
  return { circles, complete };
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
