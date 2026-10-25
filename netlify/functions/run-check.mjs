// Background job (up to 15 minutes): runs a saved check and writes the result.
// POST /api/run-check  { id }                    -> full check
// POST /api/run-check  { id, mode: "imagery" }   -> retry satellite images only
// Netlify answers the caller with 202 straight away; progress goes to the store.

import { getCheck, updateCheck, saveImage } from "./_lib/store.mjs";
import { runCheck, runImagery } from "./_lib/pipeline.mjs";
import { extractClaim, fetchFires, fetchSeismic, fetchFlightsNow } from "./_lib/claim-sources.mjs";
import { fetchShipsNow } from "./_lib/ships.mjs";
import { fetchImagery } from "./_lib/imagery.mjs";

export const DEPS = { extractClaim, fetchFires, fetchSeismic, fetchFlightsNow, fetchShipsNow, fetchImagery, saveImage };

export async function handle(payload, deps = DEPS) {
  const record = await getCheck(payload?.id);
  if (!record) return;

  if (payload.mode === "imagery") {
    if (record.status !== "done" || record.imagery?.status === "running") return;
    await updateCheck(record.id, { imagery: { ...(record.imagery || {}), status: "running" } });
    const imagery = await runImagery(record.id, record.result.claim, deps);
    await updateCheck(record.id, { imagery });
    return;
  }

  if (record.status !== "pending") return; // already handled (Netlify may retry)
  await updateCheck(record.id, { status: "running", stage: "Starting", startedAt: new Date().toISOString() });
  try {
    const input = record.mode === "manual" ? { manual: record.manual } : record.claimText;
    const result = await runCheck(input, deps, {
      onStage: (stage) => updateCheck(record.id, { stage }),
    });
    // Publish the verdict first so the page can show it, then fetch images.
    await updateCheck(record.id, { status: "done", stage: "Fetching satellite images", result, imagery: { status: "running" } });
    const imagery = await runImagery(record.id, result.claim, deps);
    await updateCheck(record.id, { stage: "Done", imagery });
  } catch (err) {
    console.error(err);
    await updateCheck(record.id, { status: "failed", error: err.message || "Check failed" });
  }
}

export default async (req) => {
  // Never throw: an error here makes Netlify retry the whole job.
  try {
    await handle(await req.json());
  } catch (err) {
    console.error(err);
  }
};

export const config = { path: "/api/run-check", background: true };
