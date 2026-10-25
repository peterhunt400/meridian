// Manual mode: checks that run with no AI and no Anthropic key.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeManual } from "../netlify/functions/_lib/claim.mjs";
import { parseRequest } from "../netlify/functions/check.mjs";
import { capabilities } from "../netlify/functions/capabilities.mjs";
import { runCheck } from "../netlify/functions/_lib/pipeline.mjs";
import { setStores, memoryStores, saveCheck, getCheck } from "../netlify/functions/_lib/store.mjs";
import { handle } from "../netlify/functions/run-check.mjs";

const NOW = Date.parse("2026-10-21T20:00:00Z");
const H = 3600_000;
const haifa = {
  lat: 32.82, lon: 35.0, radiusKm: 5, type: "explosion", place: "Port of Haifa",
  start: new Date(NOW - 24 * H).toISOString(), end: new Date(NOW).toISOString(),
};

test("normalizeManual builds a checkable claim with no AI", () => {
  const c = normalizeManual(haifa, NOW);
  assert.equal(c.checkable, true);
  assert.equal(c.source, "manual");
  assert.equal(c.summary, "Explosion reported near Port of Haifa.");
  assert.equal(c.end - c.start, 24 * H);
  const noName = normalizeManual({ ...haifa, place: "" }, NOW);
  assert.equal(noName.place, "32.820, 35.000");
});

test("normalizeManual rejects bad input with readable messages", () => {
  assert.throws(() => normalizeManual({ ...haifa, type: "other" }, NOW), /what kind of event/);
  assert.throws(() => normalizeManual({ ...haifa, lat: null }, NOW), /Click the map/);
  assert.throws(() => normalizeManual({ ...haifa, lat: 95 }, NOW), /Click the map/);
  assert.throws(() => normalizeManual({ ...haifa, start: "nope" }, NOW), /Set when/);
  assert.throws(() => normalizeManual({ ...haifa, start: haifa.end, end: haifa.start }, NOW), /before the end/);
  assert.throws(() => normalizeManual({ ...haifa, start: new Date(NOW - 10 * 24 * H).toISOString() }, NOW), /7 days/);
  // A future end is clamped to now, not rejected.
  const c = normalizeManual({ ...haifa, end: new Date(NOW + 5 * H).toISOString() }, NOW);
  assert.equal(c.end, NOW);
  assert.equal(normalizeManual({ ...haifa, radiusKm: 9999 }, NOW).radiusKm, 150);
});

test("check request: manual works without a key, text needs one", () => {
  const m = parseRequest({ manual: haifa }, { aiAvailable: false, now: NOW });
  assert.equal(m.mode, "manual");
  assert.equal(m.claimText, "Explosion reported near Port of Haifa.");
  assert.equal(m.manual.radiusKm, 5);

  assert.throws(() => parseRequest({ claim: "Explosion at Haifa port last night" }, { aiAvailable: false, now: NOW }),
    (e) => e.status === 503 && /Pick on map/.test(e.message));
  assert.equal(parseRequest({ claim: "Explosion at Haifa port last night" }, { aiAvailable: true, now: NOW }).mode, "ai");
  assert.throws(() => parseRequest({ manual: { ...haifa, lat: "x" } }, { aiAvailable: true, now: NOW }), (e) => e.status === 400);
});

test("capabilities report keys without exposing them", () => {
  const caps = capabilities({ FIRMS_MAP_KEY: "secret", AISSTREAM_API_KEY: "x", CDSE_CLIENT_ID: "a", CDSE_CLIENT_SECRET: "b" });
  assert.deepEqual(caps, { ai: false, sensors: { fires: true, seismic: true, flights: true, ships: true }, imagery: true });
  assert.ok(!JSON.stringify(caps).includes("secret"));
});

test("Netlify AI Gateway's injected Anthropic key doesn't turn AI mode on", () => {
  assert.equal(capabilities({}).ai, false);
  assert.equal(capabilities({ ANTHROPIC_API_KEY: "sk-ant-own" }).ai, true);
  // The gateway injects its key together with a base URL pointing at itself.
  assert.equal(capabilities({ ANTHROPIC_API_KEY: "gw", ANTHROPIC_BASE_URL: "https://ai-gateway.netlify.app/anthropic" }).ai, false);
  assert.equal(capabilities({ ANTHROPIC_API_KEY: "gw", ANTHROPIC_BASE_URL: "not a url" }).ai, false);
  assert.equal(capabilities({ ANTHROPIC_API_KEY: "sk-ant-own", ANTHROPIC_BASE_URL: "https://api.anthropic.com" }).ai, true);
});

test("manual check runs end to end and never calls the AI", async () => {
  let aiCalls = 0;
  const deps = {
    extractClaim: async () => { aiCalls++; throw new Error("should not be called"); },
    fetchFires: async () => [{ type: "Feature", geometry: { type: "Point", coordinates: [35.003, 32.821] }, properties: { frp: 40, detectedAt: new Date(NOW - 5 * H).toISOString() } }],
    fetchSeismic: async () => [],
    fetchFlightsNow: async () => [],
    fetchShipsNow: async () => [],
    fetchImagery: async () => ({ bbox: [0, 0, 1, 1], note: null, before: null, after: null }),
    saveImage: async () => {},
  };
  const direct = await runCheck({ manual: haifa }, deps, { now: NOW });
  assert.equal(direct.claim.source, "manual");
  assert.equal(direct.verdict, "consistent");

  setStores(memoryStores());
  const parsed = parseRequest({ manual: { ...haifa, start: new Date(Date.now() - 6 * H).toISOString(), end: new Date().toISOString() } }, { aiAvailable: false });
  await saveCheck({ id: "eeeeeeeeeeee", status: "pending", ...parsed, createdAt: new Date().toISOString() });
  await handle({ id: "eeeeeeeeeeee" }, deps);
  const rec = await getCheck("eeeeeeeeeeee");
  assert.equal(rec.status, "done");
  assert.equal(rec.result.claim.source, "manual");
  assert.equal(aiCalls, 0);
});
