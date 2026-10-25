// GET /api/quakes?bbox=w,s,e,n
// Earthquakes from the last 7 days (USGS, free, no key needed).

import { parseBbox, json, handleError, fetchWithTimeout, featureCollection } from "./_lib/util.mjs";
import { usgsToFeatures } from "./_lib/transforms.mjs";

const FEED = "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson";

export default async (req) => {
  try {
    const bbox = parseBbox(req.url);
    const res = await fetchWithTimeout(FEED);
    const features = usgsToFeatures(await res.json(), bbox);
    return json(featureCollection(features, { source: "USGS", window: "7 days" }), { cacheSeconds: 300 });
  } catch (err) {
    return handleError(err);
  }
};

export const config = { path: "/api/quakes" };
