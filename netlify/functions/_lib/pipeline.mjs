// The whole claim check, start to finish. Each data source is passed in as a
// dependency so tests can run the full flow with fake sources.

import { normalizeClaim, normalizeManual, planSensors, filterEvidence, trimEvidence, assess, SENSOR_LABELS } from "./claim.mjs";

// input is either the claim text (AI mode) or { manual: {...} } (no AI).
export async function runCheck(input, deps, { now = Date.now(), onStage = async () => {} } = {}) {
  let claim;
  if (input && typeof input === "object" && input.manual) {
    claim = normalizeManual(input.manual, now);
  } else {
    await onStage("Reading the claim");
    claim = { ...normalizeClaim(await deps.extractClaim(String(input), new Date(now)), now), source: "ai" };
  }
  const plan = claim.checkable ? planSensors(claim, now) : { run: [], skipped: [] };

  await onStage("Querying sensors");
  const raw = { fires: [], quakes: [], flights: [], ships: [] };
  const fetchers = { fires: deps.fetchFires, seismic: deps.fetchSeismic, flights: deps.fetchFlightsNow, ships: deps.fetchShipsNow };
  const sensorErrors = [];
  await Promise.all(plan.run.map(async (sensor) => {
    try {
      raw[sensor === "seismic" ? "quakes" : sensor] = await fetchers[sensor](claim);
    } catch (err) {
      sensorErrors.push({ sensor, why: `${SENSOR_LABELS[sensor]} unavailable: ${err.message}` });
    }
  }));
  // A sensor that failed can't vote either way.
  const effectivePlan = {
    run: plan.run.filter((s) => !sensorErrors.some((e) => e.sensor === s)),
    skipped: [...plan.skipped, ...sensorErrors],
  };
  const evidence = filterEvidence(claim, raw);
  const verdict = assess(claim, evidence, effectivePlan);

  return {
    claim,
    ...verdict,
    sensorsUsed: effectivePlan.run.map((s) => SENSOR_LABELS[s]),
    evidence: trimEvidence(evidence),
    checkedAt: new Date(now).toISOString(),
  };
}

// Satellite images are context for a human to look at. They never change the verdict.
export async function runImagery(id, claim, deps, { now = Date.now() } = {}) {
  if (!claim?.checkable) return { status: "skipped", note: "No location to photograph." };
  try {
    const img = await deps.fetchImagery(claim, now);
    const meta = { status: "done", bbox: img.bbox, note: img.note, checkedAt: new Date(now).toISOString(), before: null, after: null };
    for (const which of ["before", "after"]) {
      if (img[which]) {
        await deps.saveImage(id, which, img[which].png);
        meta[which] = { date: img[which].date, cloud: img[which].cloud };
      }
    }
    return meta;
  } catch (err) {
    return { status: "failed", note: `Satellite images unavailable: ${err.message}`, checkedAt: new Date(now).toISOString() };
  }
}
