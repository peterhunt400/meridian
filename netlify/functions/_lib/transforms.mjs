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
  return emergenciesFirst(features, limit);
}

// The emergency field ADS-B transponders report alongside (or instead of) a squawk.
const ADSB_EMERGENCIES = {
  general: "General emergency", nordo: "Radio failure", unlawful: "Unlawful interference",
  lifeguard: "Medical emergency", minfuel: "Minimum fuel", downed: "Aircraft down",
};

// adsb.lol / adsb.fi (ADSBExchange v2 format). Takes one or more responses, since
// a box is fetched as several overlapping circles: keeps aircraft inside the box,
// once each (the freshest position wins). Units are already feet and knots.
export function adsbToFeatures(responses, bbox, limit = 2500) {
  const latest = new Map();
  for (const data of [].concat(responses)) {
    for (const a of data?.ac || data?.aircraft || []) {
      if (typeof a.lon !== "number" || typeof a.lat !== "number" || !a.hex) continue;
      if (!inBbox([a.lon, a.lat], bbox)) continue;
      const prev = latest.get(a.hex);
      if (prev && (prev.seen_pos ?? 99) <= (a.seen_pos ?? 99)) continue;
      latest.set(a.hex, a);
    }
  }
  const features = [...latest.values()].map((a) => {
    const squawk = a.squawk || null;
    const onGround = a.alt_baro === "ground";
    const altFt = typeof a.alt_geom === "number" ? a.alt_geom : typeof a.alt_baro === "number" ? a.alt_baro : onGround ? 0 : null;
    const hex = a.hex.replace(/^~/, "");
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [round(a.lon, 4), round(a.lat, 4)] },
      properties: {
        id: hex,
        callsign: (a.flight || "").trim() || hex.toUpperCase(),
        country: "Unknown", // this format has no country of registration
        altitudeFt: altFt == null ? null : Math.round(altFt),
        speedKt: typeof a.gs === "number" ? Math.round(a.gs) : null,
        heading: Math.round(a.track ?? a.true_heading ?? 0),
        onGround,
        squawk,
        emergency: EMERGENCY_SQUAWKS[squawk] || ADSB_EMERGENCIES[a.emergency] || null,
      },
    };
  });
  return emergenciesFirst(features, limit);
}

// Emergencies first so they always survive the cap.
function emergenciesFirst(features, limit) {
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
// `since` (ms) drops older detections before the cap, so the cap never cuts recent ones.
export function firmsCsvToFeatures(csv, limit = 4000, since = 0) {
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
    const detectedAt = c[iDate] ? `${c[iDate]}T${t.slice(0, 2)}:${t.slice(2)}:00Z` : null;
    if (since && !(Date.parse(detectedAt) >= since)) continue;
    out.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        id: `fire-${lat}-${lon}-${c[iDate]}-${t}`,
        frp: iFrp >= 0 ? Number(c[iFrp]) || 0 : 0, // fire radiative power, MW
        detectedAt,
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
