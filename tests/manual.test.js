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

test("AI mode: own Anthropic key first, Netlify AI Gateway as the no-card fallback", async () => {
  const { aiProvider } = await import("../netlify/functions/_lib/util.mjs");
  assert.equal(capabilities({}).ai, false);
  assert.equal(capabilities({ ANTHROPIC_API_KEY: "sk-ant-own" }).ai, true);
  const own = aiProvider({ ANTHROPIC_API_KEY: "sk-ant-own", ANTHROPIC_BASE_URL: "https://api.anthropic.com" });
  assert.equal(own.via, "anthropic");
  assert.equal(own.dailyLimit, null, "your own key has no Meridian-side cap");

  // The gateway injects its key together with a base URL pointing at itself.
  const gw = aiProvider({ ANTHROPIC_API_KEY: "gw", ANTHROPIC_BASE_URL: "https://ai-gateway.netlify.app/anthropic/" });
  assert.equal(gw.via, "netlify");
  assert.equal(gw.baseUrl, "https://ai-gateway.netlify.app/anthropic");
  assert.equal(gw.model, "claude-haiku-5-5", "cheapest capable model on Netlify credits");
  assert.equal(gw.dailyLimit, 50);
  assert.equal(aiProvider({ ANTHROPIC_API_KEY: "gw", ANTHROPIC_BASE_URL: "https://x/a", AI_DAILY_LIMIT: "5" }).dailyLimit, 5);
  assert.equal(capabilities({ ANTHROPIC_API_KEY: "gw", ANTHROPIC_BASE_URL: "not a url" }).ai, false);
  assert.equal(capabilities({ ANTHROPIC_API_KEY: "gw", ANTHROPIC_BASE_URL: "https://x/a", MERIDIAN_AI: "off" }).ai, false);
});

test("AI Gateway is detected from either injected pair, process.env or Netlify.env", async () => {
  const { aiProvider, runtimeEnv } = await import("../netlify/functions/_lib/util.mjs");
  const GW = "https://meridian-osint.netlify.app/.netlify/ai";

  // Only the always-injected NETLIFY_AI_GATEWAY_* pair: still the gateway, same URL.
  const fallback = aiProvider({ NETLIFY_AI_GATEWAY_KEY: "gw", NETLIFY_AI_GATEWAY_URL: `${GW}/` });
  assert.equal(fallback.via, "netlify");
  assert.equal(fallback.baseUrl, GW);
  assert.equal(fallback.key, "gw");

  // The gateway's key without its base URL is not "your own key" for api.anthropic.com.
  assert.equal(aiProvider({ ANTHROPIC_API_KEY: "gw", NETLIFY_AI_GATEWAY_KEY: "gw", NETLIFY_AI_GATEWAY_URL: GW }).via, "netlify");
  assert.equal(aiProvider({ ANTHROPIC_API_KEY: "gw", ANTHROPIC_BASE_URL: ` ${GW}\n` }).baseUrl, GW, "stray whitespace is trimmed");

  // Variables visible only through Netlify.env still count.
  const netlifyEnv = new Map([["NETLIFY_AI_GATEWAY_KEY", "gw"], ["NETLIFY_AI_GATEWAY_URL", GW]]);
  assert.equal(capabilities(runtimeEnv({ FIRMS_MAP_KEY: "f" }, netlifyEnv)).ai, true);
  assert.equal(capabilities(runtimeEnv({}, { get() { throw new Error("outside a request"); } })).ai, false);
  assert.equal(runtimeEnv({ MERIDIAN_AI: "off" }, netlifyEnv).MERIDIAN_AI, "off");
});

test("a negative AI answer is never cached by the CDN", async () => {
  const { capabilitiesResponse } = await import("../netlify/functions/capabilities.mjs");
  const on = capabilitiesResponse({ NETLIFY_AI_GATEWAY_KEY: "gw", NETLIFY_AI_GATEWAY_URL: "https://gw.example" });
  assert.equal((await on.json()).ai, true);
  assert.match(on.headers.get("netlify-cdn-cache-control"), /s-maxage=60/);

  const warn = console.warn;
  const logged = [];
  console.warn = (msg) => logged.push(msg);
  try {
    const off = capabilitiesResponse({ FIRMS_MAP_KEY: "secret-value" });
    assert.equal((await off.json()).ai, false);
    assert.equal(off.headers.get("netlify-cdn-cache-control"), null);
    assert.equal(off.headers.get("cache-control"), "no-store");
  } finally {
    console.warn = warn;
  }
  assert.equal(logged.length, 1, "AI off is logged with variable names");
  assert.ok(!logged[0].includes("secret-value"), "never values");
});

test("a shared check Claude read never says AI mode is switched off", async () => {
  const { aiAvailabilityView } = await import("../src/checker.js");
  assert.equal(aiAvailabilityView(false, "ai").hintHidden, true);
  assert.equal(aiAvailabilityView(false, "manual").hintHidden, false);
  assert.equal(aiAvailabilityView(false, null).hintHidden, false);
  assert.deepEqual(aiAvailabilityView(true, null), { hintHidden: true, inputDisabled: false, examplesHidden: false });
});

test("Netlify-billed AI reads stop at the daily cap", async () => {
  const { aiUsedToday, recordAiUse } = await import("../netlify/functions/_lib/store.mjs");
  setStores(memoryStores());
  const day = Date.parse("2026-10-27T12:00:00Z");
  assert.equal(await aiUsedToday(day), 0);
  await recordAiUse(day); await recordAiUse(day);
  assert.equal(await aiUsedToday(day), 2);
  assert.equal(await aiUsedToday(day + 24 * H), 0, "resets the next UTC day");
});

test("extractClaim talks to whichever provider it's given", async () => {
  const { extractClaim } = await import("../netlify/functions/_lib/claim-sources.mjs");
  const realFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, opts) => {
    seen = { url, body: JSON.parse(opts.body), key: opts.headers["x-api-key"] };
    return new Response(JSON.stringify({ content: [{ type: "tool_use", name: "record_claim", input: { checkable: true } }] }));
  };
  try {
    const out = await extractClaim("Explosion at Haifa port", new Date(NOW),
      { via: "netlify", baseUrl: "https://gw.example/anthropic", key: "gw", model: "claude-haiku-5-5" });
    assert.equal(out.checkable, true);
    assert.equal(seen.url, "https://gw.example/anthropic/v1/messages");
    assert.equal(seen.key, "gw");
    assert.equal(seen.body.model, "claude-haiku-5-5");
    assert.equal(seen.body.tools[0].strict, undefined, "no strict flag through the gateway");
    await extractClaim("Explosion at Haifa port", new Date(NOW),
      { via: "anthropic", baseUrl: "https://api.anthropic.com", key: "own", model: "claude-sonnet-5-5" });
    assert.equal(seen.url, "https://api.anthropic.com/v1/messages");
    assert.equal(seen.body.tools[0].strict, true);
    await assert.rejects(extractClaim("x", new Date(NOW), null), /Pick on map/);
  } finally {
    globalThis.fetch = realFetch;
  }
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
