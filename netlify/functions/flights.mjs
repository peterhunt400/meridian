// GET /api/flights?bbox=w,s,e,n
// Live aircraft positions: OpenSky Network, falling back to the adsb.lol / adsb.fi
// community feeds when OpenSky can't be reached (it can't from Netlify's servers).
// OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET raise OpenSky's limit where it is reachable.

import { parseBbox, json, handleError, featureCollection } from "./_lib/util.mjs";
import { fetchAircraft } from "./_lib/aircraft.mjs";

export default async (req) => {
  try {
    const { features, meta } = await fetchAircraft(parseBbox(req.url));
    // The fallback feeds have per-IP daily limits, so let the CDN share their answers longer.
    const cacheSeconds = meta.source === "OpenSky Network" ? 30 : 60;
    return json(featureCollection(features, meta), { cacheSeconds });
  } catch (err) {
    return handleError(err);
  }
};

export const config = { path: "/api/flights" };
