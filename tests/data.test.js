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
