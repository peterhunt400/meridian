// GET /api/result?id=abc123def456
// Returns a saved check. Used both while a check runs and for shared links.
// If a saved check still has no "after" satellite image, it quietly retries
// every 6 hours, so shared links fill in once a clear pass happens.

import { json, handleError, HttpError } from "./_lib/util.mjs";
import { getCheck, updateCheck } from "./_lib/store.mjs";
import { triggerRun } from "./_lib/trigger.mjs";

const STUCK_MS = 5 * 60_000;
const IMAGERY_RETRY_MS = 6 * 3600_000;
const RETRY_COOLDOWN_MS = 10 * 60_000; // don't start a second retry while one may be running

export default async (req) => {
  try {
    const id = new URL(req.url).searchParams.get("id");
    let record = await getCheck(id);
    if (!record) throw new HttpError(404, "No saved check with that link. It may have been mistyped.");

    const age = Date.now() - Date.parse(record.startedAt || record.createdAt);
    if ((record.status === "running" || record.status === "pending") && age > STUCK_MS) {
      record = await updateCheck(record.id, { status: "failed", error: "The check timed out. Try submitting it again." });
    }

    const img = record.imagery;
    const imageryStale = record.status === "done" && record.result?.claim?.checkable &&
      img && img.status !== "running" && !img.after &&
      Date.now() - Date.parse(img.checkedAt || 0) > IMAGERY_RETRY_MS &&
      Date.now() - Date.parse(record.imageryRetryAt || 0) > RETRY_COOLDOWN_MS;
    if (imageryStale) {
      record = await updateCheck(record.id, { imageryRetryAt: new Date().toISOString() });
      triggerRun(new URL(req.url).origin, { id: record.id, mode: "imagery" }).catch(console.error);
    }

    const finished = record.status === "failed" || (record.status === "done" && record.imagery?.status !== "running");
    return json(record, { cacheSeconds: finished ? 60 : 0 });
  } catch (err) {
    return handleError(err);
  }
};

export const config = { path: "/api/result" };
