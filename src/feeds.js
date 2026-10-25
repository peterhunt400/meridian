// Talks to our own /api functions. If a feed fails, falls back to demo data
// so the map is never empty, and reports which mode each layer is in.

import { demoFlights, demoQuakes, demoFires } from "./demo-data.js";

export const FEEDS = {
  flights: { label: "Aircraft",    endpoint: "/api/flights", refreshMs: 60_000,  demo: demoFlights },
  quakes:  { label: "Earthquakes", endpoint: "/api/quakes",  refreshMs: 300_000, demo: demoQuakes },
  fires:   { label: "Fires & heat", endpoint: "/api/fires",  refreshMs: 900_000, demo: demoFires },
};

export async function loadFeed(key, bbox) {
  const feed = FEEDS[key];
  const qs = `bbox=${bbox.map((n) => n.toFixed(3)).join(",")}`;
  try {
    const res = await fetch(`${feed.endpoint}?${qs}`, { headers: { accept: "application/json" } });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.type !== "FeatureCollection") {
      throw new Error(body?.error || `Feed answered ${res.status}`);
    }
    return { mode: "live", features: body.features, meta: body.meta || {} };
  } catch (err) {
    return { mode: "demo", features: feed.demo(bbox), meta: { reason: err.message } };
  }
}
