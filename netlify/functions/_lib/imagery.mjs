// Before/after satellite images from Sentinel-2 via the Copernicus Data Space
// Ecosystem (free account). Sentinel-2 photographs each spot about every 5 days
// at 10 m per pixel: enough to see burn scars, smoke and large-scale damage,
// not individual cars or small craters.

import { fetchWithTimeout } from "./util.mjs";
import { bboxAround } from "./claim.mjs";

const TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";
const CATALOG_URL = "https://sh.dataspace.copernicus.eu/api/v1/catalog/1.0.0/search";
const PROCESS_URL = "https://sh.dataspace.copernicus.eu/api/v1/process";

const DAY = 86400_000;
const BEFORE_LOOKBACK_DAYS = 45;
const MAX_CLOUD = 40;          // percent cloud cover over the whole scene
const IMAGE_RADIUS_KM = 6;     // imagery covers a tighter box than the sensor search
const SIZE = 640;

// Pure: choose the scene to show from catalogue results.
//   before: the most recent clear scene that ends before the event window starts
//   after:  the first clear scene after the window ends
export function pickScene(features, which, claim) {
  const scenes = (features || [])
    .map((f) => ({ date: f.properties?.datetime, cloud: Number(f.properties?.["eo:cloud_cover"]) }))
    .filter((s) => s.date && Number.isFinite(s.cloud) && s.cloud <= MAX_CLOUD)
    .map((s) => ({ ...s, t: Date.parse(s.date) }))
    .filter((s) => (which === "before" ? s.t < claim.start : s.t > claim.end));
  if (!scenes.length) return null;
  scenes.sort((a, b) => (which === "before" ? b.t - a.t : a.t - b.t));
  const s = scenes[0];
  return { date: new Date(s.t).toISOString(), cloud: Math.round(s.cloud) };
}

export function imageryWindow(claim, which, now = Date.now()) {
  if (which === "before") return { from: new Date(claim.start - BEFORE_LOOKBACK_DAYS * DAY), to: new Date(claim.start) };
  return { from: new Date(claim.end), to: new Date(now) };
}

const EVALSCRIPT = `//VERSION=3
function setup() { return { input: ["B02", "B03", "B04", "dataMask"], output: { bands: 4 } }; }
function evaluatePixel(s) { return [2.6 * s.B04, 2.6 * s.B03, 2.6 * s.B02, s.dataMask]; }`;

async function getToken() {
  const id = process.env.CDSE_CLIENT_ID;
  const secret = process.env.CDSE_CLIENT_SECRET;
  if (!id || !secret) throw new Error("Satellite images need CDSE_CLIENT_ID and CDSE_CLIENT_SECRET.");
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
  });
  return (await res.json()).access_token;
}

async function searchScenes(token, bbox, from, to) {
  const res = await fetchWithTimeout(CATALOG_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      bbox, collections: ["sentinel-2-l2a"], limit: 100,
      datetime: `${from.toISOString()}/${to.toISOString()}`,
    }),
  }, 20000);
  return (await res.json()).features || [];
}

async function renderScene(token, bbox, isoDate) {
  const day = isoDate.slice(0, 10);
  const res = await fetchWithTimeout(PROCESS_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "image/png" },
    body: JSON.stringify({
      input: {
        bounds: { bbox, properties: { crs: "http://www.opengis.net/def/crs/EPSG/0/4326" } },
        data: [{ type: "sentinel-2-l2a", dataFilter: { timeRange: { from: `${day}T00:00:00Z`, to: `${day}T23:59:59Z` } } }],
      },
      output: { width: SIZE, height: SIZE, responses: [{ identifier: "default", format: { type: "image/png" } }] },
      evalscript: EVALSCRIPT,
    }),
  }, 45000);
  return new Uint8Array(await res.arrayBuffer());
}

// Returns { before, after, bbox, note } where before/after are
// { date, cloud, png } or null when no clear image exists yet.
export async function fetchImagery(claim, now = Date.now()) {
  const bbox = bboxAround(claim.lat, claim.lon, Math.min(claim.radiusKm, IMAGE_RADIUS_KM));
  const token = await getToken();
  const out = { bbox, before: null, after: null, note: null };

  for (const which of ["before", "after"]) {
    const { from, to } = imageryWindow(claim, which, now);
    if (to <= from) continue;
    const scene = pickScene(await searchScenes(token, bbox, from, to), which, claim);
    if (scene) out[which] = { ...scene, png: await renderScene(token, bbox, scene.date) };
  }
  if (!out.after) out.note = "No clear satellite pass since the event yet. Sentinel-2 revisits every few days; check this link again later.";
  return out;
}
