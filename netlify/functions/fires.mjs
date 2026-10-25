// GET /api/fires?bbox=w,s,e,n
// Satellite fire and heat detections from the last 24 hours (NASA FIRMS).
// Needs a free MAP_KEY: https://firms.modaps.eosdis.nasa.gov/api/map_key/
// Set it as FIRMS_MAP_KEY in Netlify's environment variables.

import { parseBbox, json, handleError, fetchWithTimeout, featureCollection, HttpError } from "./_lib/util.mjs";
import { firmsCsvToFeatures } from "./_lib/transforms.mjs";

export default async (req) => {
  try {
    const key = process.env.FIRMS_MAP_KEY;
    if (!key) throw new HttpError(503, "Fire layer needs FIRMS_MAP_KEY. See README.");
    const [w, s, e, n] = parseBbox(req.url);
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_NOAA20_NRT/${w},${s},${e},${n}/1`;
    const res = await fetchWithTimeout(url, {}, 20000);
    const features = firmsCsvToFeatures(await res.text());
    return json(featureCollection(features, { source: "NASA FIRMS (VIIRS NOAA-20)", window: "24 hours" }), { cacheSeconds: 900 });
  } catch (err) {
    return handleError(err);
  }
};

export const config = { path: "/api/fires" };
