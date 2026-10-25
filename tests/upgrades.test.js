// Ships, satellite imagery, and saved/shareable checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { aisToFeatures, fetchShipsNow } from "../netlify/functions/_lib/ships.mjs";
import { pickScene, imageryWindow } from "../netlify/functions/_lib/imagery.mjs";
import { normalizeClaim, planSensors, assess, filterEvidence } from "../netlify/functions/_lib/claim.mjs";
import { setStores, memoryStores, getCheck, saveCheck, getImage } from "../netlify/functions/_lib/store.mjs";
import { handle } from "../netlify/functions/run-check.mjs";
import resultFn from "../netlify/functions/result.mjs";
import { triggerRun } from "../netlify/functions/_lib/trigger.mjs";

const NOW = Date.now();
const H = 3600_000;
const ashdod = {
  checkable: true, event_type: "ship_incident", summary: "A cargo ship ran aground near Ashdod.", place_name: "Port of Ashdod, Israel",
  latitude: 31.82, longitude: 34.64, radius_km: 6,
  start_time: new Date(NOW - 1.5 * H).toISOString(), end_time: new Date(NOW - 0.5 * H).toISOString(), reason_if_uncheckable: "",
};
const pos = (mmsi, lat, lon, status, name = "") => ({
  MessageType: "PositionReport",
  MetaData: { MMSI: mmsi, ShipName: name, latitude: lat, longitude: lon, time_utc: "2026-10-15 10:00:00" },
  Message: { PositionReport: { Sog: 0.1, Cog: 90, NavigationalStatus: status } },
});

test("AIS messages become one feature per vessel, latest wins", () => {
  const f = aisToFeatures([
    pos(111, 31.80, 34.62, 0, "SEA STAR  "),
    pos(111, 31.81, 34.63, 6, "SEA STAR"),   // same ship, newer report: aground
    pos(222, 31.83, 34.60, 5),
    { MessageType: "ShipStaticData" },
    pos(333, 999, 34.6, 0),                  // invalid position dropped
  ]);
  assert.equal(f.length, 2);
  const star = f.find((x) => x.properties.id === "111");
  assert.equal(star.properties.navStatusLabel, "Aground");
  assert.equal(star.properties.distress, true);
  assert.equal(star.properties.name, "SEA STAR");
  assert.equal(f.find((x) => x.properties.id === "222").properties.name, "MMSI 222");
});

test("ship listener subscribes to the right box and collects messages", async () => {
  process.env.AISSTREAM_API_KEY = "k";
  let sent = null;
  class FakeWS {
    constructor() { setTimeout(() => { this.onopen(); this.onmessage({ data: JSON.stringify(pos(111, 31.81, 34.63, 6, "SEA STAR")) }); }, 5); }
    send(s) { sent = JSON.parse(s); }
    close() {}
  }
  const claim = normalizeClaim(ashdod, NOW);
  const ships = await fetchShipsNow(claim, { listenMs: 40, WebSocketImpl: FakeWS });
  assert.equal(ships.length, 1);
  const [[s, w], [n, e]] = sent.BoundingBoxes[0];
  assert.ok(s < 31.82 && n > 31.82 && w < 34.64 && e > 34.64, "box is [[lat,lon],[lat,lon]] around the port");
  assert.equal(sent.APIKey, "k");
});

test("ship listener reports a rejected key instead of zero ships", async () => {
  process.env.AISSTREAM_API_KEY = "bad";
  class RejectingWS {
    constructor() { setTimeout(() => this.onopen(), 5); }
    send() { setTimeout(() => this.onclose(), 5); } // aisstream closes silently on a bad key
    close() {}
  }
  const claim = normalizeClaim(ashdod, NOW);
  await assert.rejects(fetchShipsNow(claim, { listenMs: 1000, WebSocketImpl: RejectingWS }), /AISSTREAM_API_KEY/);
});

test("ship checks in the Eastern Med warn that AIS coverage is limited", () => {
  const limited = /Ship coverage in the Eastern Mediterranean is limited/;
  const med = normalizeClaim(ashdod, NOW);
  assert.ok(assess(med, filterEvidence(med, {}), planSensors(med, NOW)).caveats.some((c) => limited.test(c)));

  const rotterdam = normalizeClaim({ ...ashdod, place_name: "Port of Rotterdam", latitude: 51.95, longitude: 4.05 }, NOW);
  assert.ok(!assess(rotterdam, filterEvidence(rotterdam, {}), planSensors(rotterdam, NOW)).caveats.some((c) => limited.test(c)));

  // Only when the ship sensor actually ran.
  const fire = normalizeClaim({ ...ashdod, event_type: "fire" }, NOW);
  assert.ok(!assess(fire, filterEvidence(fire, {}), planSensors(fire, NOW)).caveats.some((c) => limited.test(c)));
});

test("ship incident verdicts", () => {
  const claim = normalizeClaim(ashdod, NOW);
  const plan = planSensors(claim, NOW);
  assert.deepEqual(plan.run, ["ships", "fires"]);
  const ships = aisToFeatures([pos(111, 31.81, 34.63, 6, "SEA STAR"), pos(222, 31.83, 34.60, 5)]);
  const ev = filterEvidence(claim, { ships });
  const hit = assess(claim, ev, plan);
  assert.equal(hit.verdict, "consistent");
  assert.match(hit.findings.find((f) => f.sensor === "ships").text, /SEA STAR \(Aground\)/);

  const calm = assess(claim, filterEvidence(claim, { ships: aisToFeatures([pos(222, 31.83, 34.60, 5)]) }), plan);
  assert.equal(calm.verdict, "no_signal");

  const old = normalizeClaim({ ...ashdod, start_time: new Date(NOW - 30 * H).toISOString(), end_time: new Date(NOW - 26 * H).toISOString() }, NOW);
  const oldPlan = planSensors(old, NOW);
  assert.deepEqual(oldPlan.run, ["fires"]);
  assert.match(oldPlan.skipped[0].why, /live ship positions/);
});

test("pickScene chooses the right clear scene on each side of the event", () => {
  const claim = { start: Date.parse("2026-10-10T00:00:00Z"), end: Date.parse("2026-10-11T00:00:00Z") };
  const scene = (d, c) => ({ properties: { datetime: d, "eo:cloud_cover": c } });
  const feats = [
    scene("2026-09-20T08:30:00Z", 5),
    scene("2026-10-05T08:30:00Z", 12),   // latest clear before
    scene("2026-10-08T08:30:00Z", 90),   // too cloudy
    scene("2026-10-13T08:30:00Z", 70),   // too cloudy
    scene("2026-10-14T08:30:00Z", 20),   // first clear after
    scene("2026-10-18T08:30:00Z", 0),
  ];
  assert.equal(pickScene(feats, "before", claim).date, "2026-10-05T08:30:00.000Z");
  assert.equal(pickScene(feats, "after", claim).date, "2026-10-14T08:30:00.000Z");
  assert.equal(pickScene([scene("2026-10-14T08:30:00Z", 95)], "after", claim), null);
  const w = imageryWindow(claim, "before");
  assert.equal(w.to.getTime(), claim.start);
});

async function fakeDeps({ shipsDistress = true, imagery = true } = {}) {
  return {
    extractClaim: async () => ashdod,
    fetchFires: async () => [],
    fetchSeismic: async () => [],
    fetchFlightsNow: async () => [],
    fetchShipsNow: async () => aisToFeatures(shipsDistress ? [pos(111, 31.81, 34.63, 6, "SEA STAR")] : []),
    fetchImagery: async () => imagery
      ? { bbox: [1, 2, 3, 4], note: null, before: { date: "2026-10-05T08:30:00Z", cloud: 3, png: new Uint8Array([1, 2]) }, after: { date: "2026-10-15T08:30:00Z", cloud: 8, png: new Uint8Array([3]) } }
      : { bbox: [1, 2, 3, 4], note: "No clear satellite pass since the event yet.", before: { date: "2026-10-05T08:30:00Z", cloud: 3, png: new Uint8Array([1]) }, after: null },
    saveImage: (await import("../netlify/functions/_lib/store.mjs")).saveImage,
  };
}

test("background job runs a saved check end to end and stores images", async () => {
  setStores(memoryStores());
  await saveCheck({ id: "abcdefabcdef", status: "pending", claimText: "Cargo ship ran aground near Ashdod", createdAt: new Date().toISOString() });
  await handle({ id: "abcdefabcdef" }, await fakeDeps());
  const rec = await getCheck("abcdefabcdef");
  assert.equal(rec.status, "done");
  assert.equal(rec.result.verdict, "consistent");
  assert.equal(rec.result.evidence.counts.ships, 1);
  assert.equal(rec.imagery.status, "done");
  assert.equal(rec.imagery.after.cloud, 8);
  assert.ok(await getImage("abcdefabcdef", "before"));

  // A retry from Netlify must not run it twice.
  const before = rec.updatedAt;
  await handle({ id: "abcdefabcdef" }, await fakeDeps());
  assert.equal((await getCheck("abcdefabcdef")).updatedAt, before);
});

test("a failing source marks the check failed instead of hanging", async () => {
  setStores(memoryStores());
  await saveCheck({ id: "bbbbbbbbbbbb", status: "pending", claimText: "x".repeat(10), createdAt: new Date().toISOString() });
  const deps = await fakeDeps();
  deps.extractClaim = async () => { throw new Error("Claude unavailable"); };
  await handle({ id: "bbbbbbbbbbbb" }, deps);
  const rec = await getCheck("bbbbbbbbbbbb");
  assert.equal(rec.status, "failed");
  assert.match(rec.error, /Claude unavailable/);
});

test("result endpoint: share links, stuck jobs, and imagery retries", async () => {
  setStores(memoryStores());
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push([String(url), JSON.parse(opts.body)]); return new Response(null, { status: 202 }); };

  const notFound = await resultFn(new Request("http://site/api/result?id=nope"));
  assert.equal(notFound.status, 404);

  await saveCheck({ id: "cccccccccccc", status: "running", claimText: "x", createdAt: new Date(NOW - 10 * 60_000).toISOString(), startedAt: new Date(NOW - 10 * 60_000).toISOString() });
  const stuck = await (await resultFn(new Request("http://site/api/result?id=cccccccccccc"))).json();
  assert.equal(stuck.status, "failed");

  const claim = normalizeClaim(ashdod, NOW);
  await saveCheck({ id: "dddddddddddd", status: "done", claimText: "x", createdAt: new Date().toISOString(), result: { claim },
    imagery: { status: "done", after: null, checkedAt: new Date(NOW - 7 * H).toISOString() } });
  await resultFn(new Request("http://site/api/result?id=dddddddddddd"));
  assert.deepEqual(calls[0], ["http://site/api/run-check", { id: "dddddddddddd", mode: "imagery" }]);
  await resultFn(new Request("http://site/api/result?id=dddddddddddd"));
  assert.equal(calls.length, 1, "second viewer doesn't start another retry");

  // The retry job itself runs (it isn't blocked by the request marker).
  await handle({ id: "dddddddddddd", mode: "imagery" }, await fakeDeps());
  assert.equal((await getCheck("dddddddddddd")).imagery.after.cloud, 8);
});

test("triggerRun doesn't wait for a job that runs inline, but still reports errors", async () => {
  // netlify dev runs the background job inside the request: no answer until the job ends.
  globalThis.fetch = (url, opts) => new Promise((_, reject) =>
    opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const t = Date.now();
  await triggerRun("http://site", { id: "x" }, { ackMs: 30 });
  assert.ok(Date.now() - t < 1000, "returns once the ack window passes");

  globalThis.fetch = async () => new Response(null, { status: 500 });
  await assert.rejects(triggerRun("http://site", { id: "x" }, { ackMs: 30 }), /didn't start \(500\)/);
});
