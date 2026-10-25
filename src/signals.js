// Turns raw layers into "signals": the handful of things worth a human's
// attention. This is the seed of the analysis layer; phase 2 adds AI linking.

const KM_PER_DEG = 111.32;

export function buildSignals({ flights = [], quakes = [], fires = [] }) {
  const out = [];

  for (const f of flights) {
    const p = f.properties;
    if (!p.emergency) continue;
    out.push({
      id: `sig-${p.id}`, kind: "flight", severity: 3,
      title: `${p.callsign} squawking ${p.squawk}`,
      detail: `${p.emergency} · ${fmt(p.altitudeFt)} ft · ${p.country}`,
      coords: f.geometry.coordinates, time: Date.now(),
    });
  }

  for (const q of quakes) {
    const p = q.properties;
    if (p.mag < 4.5) continue;
    out.push({
      id: `sig-${p.id}`, kind: "quake", severity: p.mag >= 6 ? 3 : 2,
      title: `M${p.mag.toFixed(1)} earthquake`,
      detail: `${p.place}${p.depthKm != null ? ` · ${p.depthKm} km deep` : ""}`,
      coords: q.geometry.coordinates, time: p.time,
    });
  }

  for (const c of clusterFires(fires)) {
    if (c.count < 5) continue;
    out.push({
      id: `sig-fire-${c.key}`, kind: "fire", severity: c.count >= 15 ? 2 : 1,
      title: `Fire cluster · ${c.count} detections`,
      detail: `Total ${Math.round(c.frp)} MW radiative power · ~${c.radiusKm} km across`,
      coords: c.center, time: c.latest,
    });
  }

  return out.sort((a, b) => b.severity - a.severity || b.time - a.time);
}

// Group fire points into a ~25 km grid so one wildfire reads as one signal.
export function clusterFires(fires, cellDeg = 0.25) {
  const cells = new Map();
  for (const f of fires) {
    const [lon, lat] = f.geometry.coordinates;
    const key = `${Math.floor(lon / cellDeg)}:${Math.floor(lat / cellDeg)}`;
    const c = cells.get(key) || { key, count: 0, frp: 0, sumLon: 0, sumLat: 0, minLon: lon, maxLon: lon, minLat: lat, maxLat: lat, latest: 0 };
    c.count++;
    c.frp += f.properties.frp || 0;
    c.sumLon += lon; c.sumLat += lat;
    c.minLon = Math.min(c.minLon, lon); c.maxLon = Math.max(c.maxLon, lon);
    c.minLat = Math.min(c.minLat, lat); c.maxLat = Math.max(c.maxLat, lat);
    const t = Date.parse(f.properties.detectedAt) || 0;
    c.latest = Math.max(c.latest, t);
    cells.set(key, c);
  }
  return [...cells.values()].map((c) => {
    const center = [c.sumLon / c.count, c.sumLat / c.count];
    const spanKm = Math.max((c.maxLat - c.minLat) * KM_PER_DEG, (c.maxLon - c.minLon) * KM_PER_DEG * Math.cos((center[1] * Math.PI) / 180));
    return { ...c, center, radiusKm: Math.max(1, Math.round(spanKm)) };
  });
}

function fmt(n) {
  return n == null ? "?" : n.toLocaleString("en-CA");
}
