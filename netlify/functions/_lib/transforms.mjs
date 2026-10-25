// Pure functions that turn each source's raw format into GeoJSON features.
// Kept separate from the network code so they can be tested with sample data.

import { inBbox } from "./util.mjs";

// Squawk codes pilots set to signal trouble.
export const EMERGENCY_SQUAWKS = {
  "7500": "Unlawful interference",
  "7600": "Radio failure",
  "7700": "General emergency",
};

const M_TO_FT = 3.28084;
const MS_TO_KT = 1.94384;

// OpenSky /states/all returns arrays, not objects. Index meanings:
// 0 icao24, 1 callsign, 2 origin_country, 5 lon, 6 lat, 7 baro_alt (m),
// 8 on_ground, 9 velocity (m/s), 10 true_track (deg), 11 vertical_rate,
// 13 geo_alt (m), 14 squawk
export function openSkyToFeatures(data, limit = 2500) {
  const states = Array.isArray(data?.states) ? data.states : [];
  const features = [];
  for (const s of states) {
    const lon = s[5];
    const lat = s[6];
    if (typeof lon !== "number" || typeof lat !== "number") continue;
    const squawk = s[14] || null;
    const altM = s[13] ?? s[7];
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [round(lon, 4), round(lat, 4)] },
      properties: {
        id: s[0],
        callsign: (s[1] || "").trim() || s[0].toUpperCase(),
        country: s[2] || "Unknown",
        altitudeFt: typeof altM === "number" ? Math.round(altM * M_TO_FT) : null,
        speedKt: typeof s[9] === "number" ? Math.round(s[9] * MS_TO_KT) : null,
        heading: typeof s[10] === "number" ? Math.round(s[10]) : 0,
        onGround: Boolean(s[8]),
        squawk,
        emergency: EMERGENCY_SQUAWKS[squawk] || null,
      },
    });
  }
  // Emergencies first so they always survive the cap.
  features.sort((a, b) => Number(Boolean(b.properties.emergency)) - Number(Boolean(a.properties.emergency)));
  return features.slice(0, limit);
}

// USGS earthquake GeoJSON is already GeoJSON; we filter and slim it down.
export function usgsToFeatures(data, bbox, minMag = 2.5) {
  const out = [];
  for (const f of data?.features || []) {
    const [lon, lat, depthKm] = f.geometry?.coordinates || [];
    const mag = f.properties?.mag;
    if (typeof lon !== "number" || typeof mag !== "number" || mag < minMag) continue;
    if (!inBbox([lon, lat], bbox)) continue;
    out.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        id: f.id,
        mag: round(mag, 1),
        place: f.properties.place || "Unknown location",
        time: f.properties.time,
        depthKm: typeof depthKm === "number" ? round(depthKm, 1) : null,
        url: f.properties.url,
        tsunami: Boolean(f.properties.tsunami),
      },
    });
  }
  return out.sort((a, b) => b.properties.time - a.properties.time);
}

// NASA FIRMS area API returns CSV. Header row names the columns.
export function firmsCsvToFeatures(csv, limit = 4000) {
  const lines = String(csv || "").trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const head = lines[0].split(",");
  const col = (name) => head.indexOf(name);
  const iLat = col("latitude"), iLon = col("longitude"), iFrp = col("frp");
  const iDate = col("acq_date"), iTime = col("acq_time"), iConf = col("confidence"), iDn = col("daynight");
  if (iLat < 0 || iLon < 0) throw new Error("FIRMS response had no latitude/longitude columns");
  const out = [];
  for (let i = 1; i < lines.length && out.length < limit; i++) {
    const c = lines[i].split(",");
    const lat = Number(c[iLat]);
    const lon = Number(c[iLon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const t = String(c[iTime] || "").padStart(4, "0");
    out.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        id: `fire-${lat}-${lon}-${c[iDate]}-${t}`,
        frp: iFrp >= 0 ? Number(c[iFrp]) || 0 : 0, // fire radiative power, MW
        detectedAt: c[iDate] ? `${c[iDate]}T${t.slice(0, 2)}:${t.slice(2)}:00Z` : null,
        confidence: iConf >= 0 ? c[iConf] : null,
        daynight: iDn >= 0 ? c[iDn] : null,
      },
    });
  }
  return out;
}

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
