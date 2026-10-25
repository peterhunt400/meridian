// Claim checker: pure logic. No network calls here, so it is fully testable.
//
// Flow: claim text -> (Claude) structured claim -> sensor evidence -> verdict.
// The verdict is decided by these rules, never by the AI, so it can't be
// talked into a conclusion the data doesn't support.

export const EVENT_TYPES = ["explosion", "airstrike", "fire", "earthquake", "aircraft_incident", "ship_incident", "other"];

// Which sensors can see each kind of event.
export const SENSORS_FOR = {
  explosion:         ["fires", "seismic", "ships"],
  airstrike:         ["fires", "seismic"],
  fire:              ["fires"],
  earthquake:        ["seismic"],
  aircraft_incident: ["flights"],
  ship_incident:     ["ships", "fires"],
  other:             [],
};

export const SENSOR_LABELS = {
  fires: "NASA satellite heat detection",
  seismic: "USGS seismic network",
  flights: "Live aircraft transponders",
  ships: "Live ship transponders (AIS)",
};

// Free AIS (aisstream) relies on volunteer shore receivers, which are sparse in the
// Eastern Mediterranean: a Haifa check hears a handful of ships where Rotterdam hears dozens.
// [west, south, east, north]
export const LIMITED_AIS_AREAS = [
  { name: "Eastern Mediterranean", bbox: [24, 30, 37, 37.5] },
];

const HOUR = 3600_000;
const FIRMS_MAX_AGE_DAYS = 10;   // near-real-time archive the API serves
const LIVE_MAX_AGE_H = 2;        // aircraft and ships are live snapshots only

// Validate and clean what Claude extracted. Throws on anything unusable.
export function normalizeClaim(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object") throw new Error("Claim extraction returned nothing");
  const checkable = raw.checkable === true;
  const type = EVENT_TYPES.includes(raw.event_type) ? raw.event_type : "other";
  const out = {
    checkable,
    type,
    summary: String(raw.summary || "").slice(0, 240),
    place: String(raw.place_name || "").slice(0, 120),
    reason: raw.reason_if_uncheckable ? String(raw.reason_if_uncheckable).slice(0, 240) : null,
  };
  if (!checkable) return out;

  const lat = Number(raw.latitude), lon = Number(raw.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return { ...out, checkable: false, reason: "Couldn't pin the claim to a location on the map." };
  }
  let start = Date.parse(raw.start_time), end = Date.parse(raw.end_time);
  if (!Number.isFinite(end) || end > now) end = now;
  if (!Number.isFinite(start) || start >= end) start = end - 24 * HOUR;
  if (end - start > 7 * 24 * HOUR) start = end - 7 * 24 * HOUR; // keep the window tight

  const radiusKm = clamp(Number(raw.radius_km) || 10, 2, 150);
  return { ...out, lat, lon, radiusKm, start, end };
}

// Manual mode: the user picked the place, type and window themselves, so no
// AI is involved anywhere. Throws a readable error for anything invalid.
export const TYPE_LABELS = {
  explosion: "Explosion", airstrike: "Airstrike", fire: "Fire", earthquake: "Earthquake",
  aircraft_incident: "Aircraft incident", ship_incident: "Ship incident",
};

export function normalizeManual(raw, now = Date.now()) {
  if (!raw || typeof raw !== "object") throw new Error("Missing the manual check details.");
  const type = String(raw.type || "");
  if (!TYPE_LABELS[type]) throw new Error("Pick what kind of event it was.");
  const blank = (v) => v === null || v === undefined || v === "";
  const lat = Number(raw.lat), lon = Number(raw.lon);
  if (blank(raw.lat) || blank(raw.lon) || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new Error("Click the map to set where it happened.");
  }
  let start = Date.parse(raw.start), end = Date.parse(raw.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("Set when it happened.");
  if (end > now) end = now;
  if (start >= end) throw new Error("The start time has to be before the end time, and not in the future.");
  if (end - start > 7 * 24 * HOUR) throw new Error("Keep the time window to 7 days or less.");
  const radiusKm = clamp(Number(raw.radiusKm) || 10, 2, 150);
  const place = String(raw.place || "").trim().slice(0, 120) || `${lat.toFixed(3)}, ${lon.toFixed(3)}`;
  return {
    checkable: true, source: "manual", type, place, lat, lon, radiusKm, start, end, reason: null,
    summary: `${TYPE_LABELS[type]} reported near ${place}.`,
  };
}

// Bounding box around a point, for APIs that take boxes.
export function bboxAround(lat, lon, radiusKm) {
  const dLat = radiusKm / 111.32;
  const dLon = radiusKm / (111.32 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return [
    clamp(lon - dLon, -180, 180), clamp(lat - dLat, -90, 90),
    clamp(lon + dLon, -180, 180), clamp(lat + dLat, -90, 90),
  ].map((n) => Math.round(n * 1000) / 1000);
}

export function distanceKm([lon1, lat1], [lon2, lat2]) {
  const R = 6371, toRad = (d) => (d * Math.PI) / 180;
  const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Which sensors to query for this claim, and why any are skipped.
export function planSensors(claim, now = Date.now()) {
  const wanted = SENSORS_FOR[claim.type] || [];
  const run = [], skipped = [];
  for (const s of wanted) {
    if (s === "fires" && now - claim.start > FIRMS_MAX_AGE_DAYS * 24 * HOUR) {
      skipped.push({ sensor: s, why: `Satellite archive used here only covers the last ${FIRMS_MAX_AGE_DAYS} days.` });
    } else if ((s === "flights" || s === "ships") && now - claim.end > LIVE_MAX_AGE_H * HOUR) {
      // Only worth mentioning when this is the main sensor for the claim.
      if (wanted[0] === s) {
        skipped.push({ sensor: s, why: `Only live ${s === "flights" ? "aircraft" : "ship"} positions are available, and this claim is older than ${LIVE_MAX_AGE_H} hours.` });
      }
    } else {
      run.push(s);
    }
  }
  return { run, skipped };
}

// Keep only evidence inside the search circle and time window.
// Satellites pass over a given spot roughly twice a day, so fire detections get
// a 12-hour grace period after the window.
export function filterEvidence(claim, { fires = [], quakes = [], flights = [], ships = [] }) {
  const here = [claim.lon, claim.lat];
  const near = (f) => distanceKm(here, f.geometry.coordinates) <= claim.radiusKm;
  const withDist = (f) => ({ ...f, properties: { ...f.properties, distanceKm: Math.round(distanceKm(here, f.geometry.coordinates) * 10) / 10 } });
  const inTime = (t, graceAfter = 0) => t >= claim.start - HOUR && t <= claim.end + graceAfter;

  return {
    fires: fires.filter((f) => near(f) && inTime(Date.parse(f.properties.detectedAt), 12 * HOUR)).map(withDist),
    quakes: quakes.filter((f) => near(f) && inTime(Number(f.properties.time), HOUR)).map(withDist),
    flights: flights.filter((f) => near(f)).map(withDist),
    ships: ships.filter((f) => near(f)).map(withDist),
  };
}

// Keep stored results small: only the evidence that matters, plus counts.
export function trimEvidence(evidence) {
  return {
    fires: (evidence.fires || []).slice(0, 200),
    quakes: evidence.quakes || [],
    flights: (evidence.flights || []).filter((f) => f.properties.emergency),
    ships: (evidence.ships || []).filter((f) => f.properties.distress),
    counts: {
      fires: (evidence.fires || []).length,
      quakes: (evidence.quakes || []).length,
      flights: (evidence.flights || []).length,
      ships: (evidence.ships || []).length,
    },
  };
}

// The verdict. Three outcomes, worded so we never overclaim:
//   consistent  – at least one sensor saw something matching the claim
//   no_signal   – sensors that should see this kind of event saw nothing
//   uncheckable – none of our sensors can see this kind of event
export function assess(claim, evidence, plan) {
  if (!claim.checkable) {
    return { verdict: "uncheckable", confidence: null, headline: "Can't be checked with sensor data", findings: [], caveats: [claim.reason || "This claim doesn't describe a physical event at a specific place."] };
  }
  if (plan.run.length === 0) {
    return {
      verdict: "uncheckable", confidence: null,
      headline: "Our sensors can't see this kind of event",
      findings: [],
      caveats: plan.skipped.length ? plan.skipped.map((s) => s.why) : [`Meridian has no sensor for ${claim.type.replace("_", " ")} events yet.`],
    };
  }

  const findings = [];
  const hits = new Set();

  if (plan.run.includes("fires")) {
    const f = evidence.fires;
    if (f.length) {
      hits.add("fires");
      const frp = f.reduce((s, x) => s + (x.properties.frp || 0), 0);
      const closest = Math.min(...f.map((x) => x.properties.distanceKm));
      findings.push({ sensor: "fires", found: true, text: `${f.length} heat detection${f.length > 1 ? "s" : ""} within ${claim.radiusKm} km (closest ${closest} km away), ${Math.round(frp)} MW total.` });
    } else {
      findings.push({ sensor: "fires", found: false, text: `No satellite heat detections within ${claim.radiusKm} km during the window.` });
    }
  }
  if (plan.run.includes("seismic")) {
    const q = evidence.quakes;
    if (q.length) {
      hits.add("seismic");
      const big = q.reduce((a, b) => (b.properties.mag > a.properties.mag ? b : a));
      findings.push({ sensor: "seismic", found: true, text: `${q.length} seismic event${q.length > 1 ? "s" : ""} recorded nearby, largest M${big.properties.mag} at ${big.properties.distanceKm} km.` });
    } else {
      findings.push({ sensor: "seismic", found: false, text: "No seismic events recorded nearby during the window." });
    }
  }
  if (plan.run.includes("flights")) {
    const fl = evidence.flights;
    const alerts = fl.filter((x) => x.properties.emergency);
    if (alerts.length) {
      hits.add("flights");
      findings.push({ sensor: "flights", found: true, text: `${alerts.map((a) => `${a.properties.callsign} (${a.properties.emergency})`).join(", ")} squawking an emergency code nearby.` });
    } else {
      findings.push({ sensor: "flights", found: false, text: `${fl.length} aircraft tracked nearby right now, none squawking an emergency code.` });
    }
  }

  if (plan.run.includes("ships")) {
    const sh = evidence.ships || [];
    const distress = sh.filter((x) => x.properties.distress);
    if (distress.length) {
      hits.add("ships");
      findings.push({ sensor: "ships", found: true, text: `${distress.map((v) => `${v.properties.name} (${v.properties.navStatusLabel})`).join(", ")} reporting a distress status nearby.` });
    } else if (sh.length || claim.type === "ship_incident") {
      findings.push({ sensor: "ships", found: false, text: `${sh.length} vessel${sh.length === 1 ? "" : "s"} transmitting nearby, none reporting a distress status.` });
    }
  }

  const caveats = [...plan.skipped.map((s) => s.why)];
  if (plan.run.includes("ships")) {
    caveats.push("Ships report their own status, and some switch transponders off; ship data covers only the last few minutes.");
    const limited = LIMITED_AIS_AREAS.find(({ bbox: [w, s, e, n] }) => claim.lon >= w && claim.lon <= e && claim.lat >= s && claim.lat <= n);
    if (limited) caveats.push(`Ship coverage in the ${limited.name} is limited: few receivers pick up transponders here, so many vessels nearby won't be heard.`);
  }
  if (plan.run.includes("fires")) caveats.push("Satellites pass over roughly twice a day and can't see through thick cloud, so short or small events can be missed.");
  if (plan.run.includes("seismic")) caveats.push("Outside the US, the global network mostly records larger events; small blasts often don't register.");

  if (hits.size > 0) {
    const strong = hits.size >= 2 || evidence.fires.length >= 3 || evidence.quakes.some((q) => q.properties.mag >= 3);
    return {
      verdict: "consistent", confidence: strong ? "strong" : "weak",
      headline: strong ? "Sensor data supports this claim" : "Some sensor data is consistent with this claim",
      findings, caveats: ["Sensors show that something happened, not who or what caused it.", ...caveats],
    };
  }
  return {
    verdict: "no_signal", confidence: null,
    headline: "No sensor signal found",
    findings, caveats: ["No signal isn't proof it didn't happen.", ...caveats],
  };
}

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
