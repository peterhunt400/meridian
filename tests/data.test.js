// Run with: npm test   (uses Node's built-in test runner, nothing to install)
import { test } from "node:test";
import assert from "node:assert/strict";
import { openSkyToFeatures, usgsToFeatures, firmsCsvToFeatures } from "../netlify/functions/_lib/transforms.mjs";
import { parseBbox } from "../netlify/functions/_lib/util.mjs";
import { buildSignals, clusterFires } from "../src/signals.js";
import { demoFlights, demoQuakes, demoFires } from "../src/demo-data.js";
import { REGIONS } from "../src/regions.js";

const LEVANT = [32, 29, 39.5, 37.5];

test("OpenSky arrays become flight features with unit conversion", () => {
  const raw = { states: [
    ["738065", "ELY001  ", "Israel", 0, 0, 34.88, 32.01, 10000, false, 230, 271.5, 0, null, 10100, "2201"],
    ["abc123", "TST9    ", "Jordan", 0, 0, 35.9, 31.7, 3000, false, 120, 90, 0, null, null, "7700"],
    ["nopos1", "", "Egypt", 0, 0, null, null, null, true, 0, 0, 0, null, null, null],
  ] };
  const f = openSkyToFeatures(raw);
  assert.equal(f.length, 2, "aircraft without a position are dropped");
  assert.equal(f[0].properties.callsign, "TST9", "emergencies sort first");
  assert.equal(f[0].properties.emergency, "General emergency");
  const ely = f[1].properties;
  assert.equal(ely.callsign, "ELY001");
  assert.equal(ely.altitudeFt, 33136); // 10100 m geo altitude
  assert.equal(ely.speedKt, 447);      // 230 m/s
  assert.equal(ely.heading, 272);
});

test("OpenSky with no states returns an empty list", () => {
  assert.deepEqual(openSkyToFeatures({ states: null }), []);
});

test("USGS quakes are filtered to the bbox and minimum magnitude", () => {
  const raw = { features: [
    { id: "a", geometry: { coordinates: [35.5, 33.1, 10] }, properties: { mag: 4.8, place: "Lebanon", time: 2 } },
    { id: "b", geometry: { coordinates: [35.5, 33.1, 10] }, properties: { mag: 1.2, place: "tiny", time: 3 } },
    { id: "c", geometry: { coordinates: [-120, 36, 5] },   properties: { mag: 5.5, place: "California", time: 4 } },
  ] };
  const f = usgsToFeatures(raw, LEVANT);
  assert.deepEqual(f.map((x) => x.properties.id), ["a"]);
  assert.equal(f[0].properties.depthKm, 10);
});

test("FIRMS CSV parses by header name", () => {
  const csv = [
    "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight",
    "31.5,34.5,330.1,0.4,0.4,2026-10-15,113,N20,VIIRS,n,2.0NRT,290.1,12.3,N",
    "bad,row",
  ].join("\n");
  const f = firmsCsvToFeatures(csv);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].geometry.coordinates, [34.5, 31.5]);
  assert.equal(f[0].properties.frp, 12.3);
  assert.equal(f[0].properties.detectedAt, "2026-10-15T01:13:00Z");
});

test("bbox validation rejects bad input", () => {
  assert.deepEqual(parseBbox("http://x/api?bbox=32,29,39.5,37.5"), LEVANT);
  assert.throws(() => parseBbox("http://x/api"), /Missing bbox/);
  assert.throws(() => parseBbox("http://x/api?bbox=40,29,30,37"), /inverted/);
  assert.throws(() => parseBbox("http://x/api?bbox=a,b,c,d"), /four numbers/);
});

test("signals pick out emergencies, big quakes and fire clusters", () => {
  const fires = Array.from({ length: 6 }, (_, i) => ({
    geometry: { coordinates: [35.01 + i * 0.01, 32.01] },
    properties: { frp: 10, detectedAt: "2026-10-15T10:00:00Z" },
  }));
  const s = buildSignals({
    flights: [{ geometry: { coordinates: [35, 32] }, properties: { id: "x", callsign: "TST9", squawk: "7700", emergency: "General emergency", altitudeFt: 9000, country: "Jordan" } }],
    quakes: [
      { geometry: { coordinates: [35, 33] }, properties: { id: "q1", mag: 5.1, place: "Lebanon", time: 1, depthKm: 8 } },
      { geometry: { coordinates: [35, 33] }, properties: { id: "q2", mag: 3.0, place: "small", time: 1 } },
    ],
    fires,
  });
  assert.deepEqual(s.map((x) => x.kind), ["flight", "quake", "fire"]);
  assert.match(s[2].title, /6 detections/);
  assert.equal(clusterFires(fires).length, 1);
});

test("demo data stays inside every region", () => {
  for (const r of REGIONS) {
    const [w, s, e, n] = r.bbox;
    for (const f of [...demoQuakes(r.bbox), ...demoFires(r.bbox)]) {
      const [lon, lat] = f.geometry.coordinates;
      assert.ok(lon >= w - 0.2 && lon <= e + 0.2 && lat >= s - 0.2 && lat <= n + 0.2, `${r.id} point outside`);
    }
    assert.equal(demoFlights(r.bbox).length, 70);
  }
});

test("ADS-B feeds become the same flight features, deduped and clipped to the box", async () => {
  const { adsbToFeatures } = await import("../netlify/functions/_lib/transforms.mjs");
  const lol = { ac: [
    { hex: "738065", flight: "ELY001  ", lat: 32.01, lon: 34.88, alt_baro: 33000, alt_geom: 33150, gs: 447.4, track: 271.6, squawk: "2201", emergency: "none", seen_pos: 2 },
    { hex: "abc123", flight: "TST9    ", lat: 31.7, lon: 35.9, alt_baro: 3000, gs: 120, track: 90, squawk: "1200", emergency: "general", seen_pos: 1 },
    { hex: "~0a1b2c", lat: 31.9, lon: 34.9, alt_baro: "ground", gs: 3, seen_pos: 1 },
    { hex: "farout", flight: "FAR1", lat: 45, lon: 10, alt_baro: 30000 },
    { hex: "nopos", flight: "NOPOS" },
  ] };
  const fi = { aircraft: [{ hex: "738065", flight: "ELY001  ", lat: 32.02, lon: 34.9, alt_baro: 33000, gs: 447, track: 272, seen_pos: 0.5 }] };
  const f = adsbToFeatures([lol, fi], LEVANT);
  assert.deepEqual(f.map((x) => x.properties.id).sort(), ["0a1b2c", "738065", "abc123"], "inside the box, once each");
  assert.equal(f[0].properties.emergency, "General emergency", "emergency field counts, and sorts first");
  const ely = f.find((x) => x.properties.id === "738065");
  assert.deepEqual(ely.geometry.coordinates, [34.9, 32.02], "freshest position wins");
  assert.equal(ely.properties.callsign, "ELY001");
  assert.equal(ely.properties.altitudeFt, 33000);
  const ground = f.find((x) => x.properties.id === "0a1b2c").properties;
  assert.equal(ground.onGround, true);
  assert.equal(ground.callsign, "0A1B2C");
});

test("aircraft fallback covers a box with ≤250 nm circles", async () => {
  const { coverCircles } = await import("../netlify/functions/_lib/aircraft.mjs");
  const levant = coverCircles(LEVANT);
  assert.equal(levant.complete, true);
  assert.ok(levant.circles.length <= 4 && levant.circles.every((c) => c.radiusNm <= 250));
  const small = coverCircles([34.9, 32.7, 35.1, 32.9]);
  assert.equal(small.circles.length, 1);
  assert.ok(small.circles[0].radiusNm < 15, "small boxes ask for a small circle");
  const me = coverCircles([25, 12, 63, 42]);
  assert.equal(me.complete, false, "too big for 8 circles is reported as partial");
  assert.ok(me.circles.length <= 8);
  for (const { lat, lon } of me.circles) assert.ok(lon > 25 && lon < 63 && lat > 12 && lat < 42);
});

test("aircraft: OpenSky unreachable falls back to adsb.lol, then adsb.fi", async () => {
  const { fetchAircraft } = await import("../netlify/functions/_lib/aircraft.mjs");
  const realFetch = globalThis.fetch;
  const asked = [];
  const ac = [{ hex: "738065", flight: "ELY001", lat: 32.8, lon: 35.0, alt_baro: 9000, gs: 250, track: 10 }];
  try {
    globalThis.fetch = async (url) => {
      const host = new URL(url).host;
      asked.push(host);
      if (host === "opensky-network.org") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
      if (host === "api.adsb.lol") return Response.json({ ac });
      throw new Error("unexpected " + host);
    };
    const lol = await fetchAircraft([34.9, 32.7, 35.1, 32.9]);
    assert.equal(lol.meta.source, "adsb.lol");
    assert.equal(lol.meta.coverage, "full");
    assert.equal(lol.features[0].properties.callsign, "ELY001");

    // adsb.lol rate-limited: adsb.fi picks the circle up.
    globalThis.fetch = async (url) => {
      const host = new URL(url).host;
      if (host === "opensky-network.org") throw new TypeError("fetch failed");
      if (host === "api.adsb.lol") return new Response("slow down", { status: 429 });
      return Response.json({ aircraft: ac });
    };
    const fi = await fetchAircraft([34.9, 32.7, 35.1, 32.9]);
    assert.equal(fi.meta.source, "adsb.fi");
    assert.equal(fi.features.length, 1);

    globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
    await assert.rejects(fetchAircraft([34.9, 32.7, 35.1, 32.9]));
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(asked, ["opensky-network.org", "api.adsb.lol"]);

  // After a failure, OpenSky is skipped for a while rather than timing out on every request.
  const hosts = [];
  try {
    globalThis.fetch = async (url) => { hosts.push(new URL(url).host); return Response.json({ ac }); };
    await fetchAircraft([34.9, 32.7, 35.1, 32.9]);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(hosts, ["api.adsb.lol"]);
});
