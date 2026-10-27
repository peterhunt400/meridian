// POST /api/check
//   AI mode:     { "claim": "Explosion at Haifa port last night" }   (needs ANTHROPIC_API_KEY)
//   Manual mode: { "manual": { lat, lon, radiusKm, type, start, end, place? } }   (no AI, no key)
// Saves the request, starts the background check, and returns its id at once.
// The page then polls /api/result?id=... and the id doubles as the share link.

import { json, handleError, HttpError, aiProvider } from "./_lib/util.mjs";
import { newId, saveCheck, aiUsedToday, recordAiUse } from "./_lib/store.mjs";
import { triggerRun } from "./_lib/trigger.mjs";
import { normalizeManual } from "./_lib/claim.mjs";

const MAX_CHARS = 600;

// Light protection for your API bill: a few checks per visitor per minute.
// Resets when the function cold-starts, so also set a spend limit in the Claude Console.
const recent = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const hits = (recent.get(ip) || []).filter((t) => now - t < 60_000);
  hits.push(now);
  recent.set(ip, hits);
  return hits.length > 5;
}

// Validate the request body and turn it into what gets saved.
export function parseRequest(body, { aiAvailable, now = Date.now() }) {
  if (body?.manual) {
    let claim;
    try {
      claim = normalizeManual(body.manual, now);
    } catch (err) {
      throw new HttpError(400, err.message);
    }
    const { lat, lon, radiusKm, type, start, end, place } = claim;
    return {
      mode: "manual",
      manual: { lat, lon, radiusKm, type, place, start: new Date(start).toISOString(), end: new Date(end).toISOString() },
      claimText: claim.summary,
    };
  }
  const text = String(body?.claim || "").trim();
  if (!aiAvailable) {
    throw new HttpError(503, "Describing a claim in words isn't switched on for this site. Use Pick on map instead.");
  }
  if (text.length < 8) throw new HttpError(400, "Write out the claim, including a place and roughly when.");
  if (text.length > MAX_CHARS) throw new HttpError(400, `Keep the claim under ${MAX_CHARS} characters.`);
  return { mode: "ai", claimText: text };
}

export default async (req, context) => {
  try {
    if (req.method !== "POST") throw new HttpError(405, "Use POST with a JSON body: { claim } or { manual }");
    if (rateLimited(context?.ip || "unknown")) throw new HttpError(429, "Too many checks. Wait a minute and try again.");

    const body = await req.json().catch(() => ({}));
    const provider = aiProvider();
    const parsed = parseRequest(body, { aiAvailable: Boolean(provider) });
    // AI reads billed to Netlify credits have a daily cap so the free plan can't run dry.
    if (parsed.mode === "ai" && provider.dailyLimit != null) {
      if ((await aiUsedToday()) >= provider.dailyLimit) {
        throw new HttpError(429, "Today's quota for describing claims in words is used up. Use Pick on map, or try again tomorrow.");
      }
      await recordAiUse();
    }

    const id = newId();
    const record = { id, status: "pending", stage: "Queued", ...parsed, createdAt: new Date().toISOString() };
    await saveCheck(record);
    try {
      await triggerRun(new URL(req.url).origin, { id });
    } catch (err) {
      await saveCheck({ ...record, status: "failed", error: err.message });
      throw new HttpError(502, "Couldn't start the check. Try again in a moment.");
    }
    return json({ id, status: "pending" }, { status: 202 });
  } catch (err) {
    return handleError(err);
  }
};

export const config = { path: "/api/check" };
