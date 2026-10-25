import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeClaim, planSensors, filterEvidence, assess, distanceKm, bboxAround } from "../netlify/functions/_lib/claim.mjs";

const NOW = Date.parse("2026-10-15T12:00:00Z");
const H = 3600_000;
const haifa = { checkable: true, event_type: "explosion", summary: "Explosion at Haifa port", place_name: "Port of Haifa", latitude: 32.82, longitude: 35.0, radius_km: 5, start_time: "2026-10-14T18:00:00Z", end_time: "2026-10-15T03:00:00Z", reason_if_uncheckable: "" };

const fire = (lon, lat, iso, frp = 20) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { frp, detectedAt: iso } });
const quake = (lon, lat, t, mag) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: { mag, time: t } });

test("distance and bbox are sane", () => {
  assert.ok(Math.abs(distanceKm([35, 32], [35, 33]) - 111.2) < 0.5);
  const [w, s, e, n] = bboxAround(32.82, 35.0, 5);
  assert.ok(w < 35 && e > 35 && s < 32.82 && n > 32.82);
});

test("normalizeClaim clamps bad windows and radii", () => {
  const c = normalizeClaim({ ...haifa, end_time: "2030-01-01T00:00:00Z", radius_km: 9999 }, NOW);
  assert.equal(c.end, NOW, "future end is clamped to now");
  assert.equal(c.radiusKm, 150);
  const bad = normalizeClaim({ ...haifa, latitude: "x" }, NOW);
  assert.equal(bad.checkable, false);
  const noTime = normalizeClaim({ ...haifa, start_time: "", end_time: "" }, NOW);
  assert.equal(noTime.end - noTime.start, 24 * H);
});

test("planSensors skips sensors that can't cover the claim", () => {
  const explosion = normalizeClaim(haifa, NOW);
  assert.deepEqual(planSensors(explosion, NOW).run, ["fires", "seismic"]);

  const oldJets = normalizeClaim({ ...haifa, event_type: "aircraft_incident", start_time: "2026-10-10T00:00:00Z", end_time: "2026-10-10T02:00:00Z" }, NOW);
  const p = planSensors(oldJets, NOW);
  assert.deepEqual(p.run, []);
  assert.match(p.skipped[0].why, /older than 2 hours/);

  // Old ship claim: live AIS can't help, satellites still can.
  const ship = normalizeClaim({ ...haifa, event_type: "ship_incident" }, NOW);
  const sp = planSensors(ship, NOW);
  assert.deepEqual(sp.run, ["fires"]);
  assert.match(sp.skipped[0].why, /live ship positions/);
});

test("evidence is filtered by distance and time", () => {
  const c = normalizeClaim(haifa, NOW);
  const ev = filterEvidence(c, {
    fires: [
      fire(35.01, 32.82, "2026-10-14T23:30:00Z"),  // in
      fire(35.01, 32.82, "2026-10-15T10:00:00Z"),  // in: within 12h satellite grace
      fire(35.5, 32.82, "2026-10-14T23:30:00Z"),   // out: ~47 km away
      fire(35.01, 32.82, "2026-10-10T23:30:00Z"),  // out: days before
    ],
    quakes: [quake(35.0, 32.83, Date.parse("2026-10-14T23:31:00Z"), 1.8)],
  });
  assert.equal(ev.fires.length, 2);
  assert.equal(ev.quakes.length, 1);
  assert.ok(ev.fires[0].properties.distanceKm < 2);
});

test("verdicts: strong, weak, no signal, uncheckable", () => {
  const c = normalizeClaim(haifa, NOW);
  const plan = planSensors(c, NOW);
  const q = [{ ...quake(35, 32.83, NOW - 10 * H, 1.8), properties: { mag: 1.8, time: NOW - 10 * H, distanceKm: 1 } }];
  const f = [{ ...fire(35.01, 32.82, "2026-10-14T23:30:00Z"), properties: { frp: 30, distanceKm: 1 } }];

  const strong = assess(c, { fires: f, quakes: q, flights: [] }, plan);
  assert.equal(strong.verdict, "consistent");
  assert.equal(strong.confidence, "strong", "two independent sensors agree");

  const weak = assess(c, { fires: f, quakes: [], flights: [] }, plan);
  assert.equal(weak.confidence, "weak");

  const none = assess(c, { fires: [], quakes: [], flights: [] }, plan);
  assert.equal(none.verdict, "no_signal");
  assert.match(none.caveats[0], /isn't proof/);

  const opinion = normalizeClaim({ checkable: false, event_type: "other", summary: "X will win", reason_if_uncheckable: "Prediction, not an event." }, NOW);
  assert.equal(assess(opinion, {}, { run: [], skipped: [] }).verdict, "uncheckable");
});
