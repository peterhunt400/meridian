// Shared helpers for the data functions.

// Parse "west,south,east,north" from the ?bbox= query parameter.
export function parseBbox(url) {
  const raw = new URL(url).searchParams.get("bbox");
  if (!raw) throw new HttpError(400, "Missing bbox. Use ?bbox=west,south,east,north");
  const parts = raw.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    throw new HttpError(400, "bbox must be four numbers: west,south,east,north");
  }
  const [w, s, e, n] = parts;
  if (w < -180 || e > 180 || s < -90 || n > 90 || w >= e || s >= n) {
    throw new HttpError(400, "bbox is out of range or inverted");
  }
  return [w, s, e, n];
}

export function inBbox([lon, lat], [w, s, e, n]) {
  return lon >= w && lon <= e && lat >= s && lat <= n;
}

// The Anthropic key to call api.anthropic.com with, or null. Netlify's AI Gateway
// injects its own ANTHROPIC_API_KEY plus an ANTHROPIC_BASE_URL pointing at the
// gateway; that key doesn't work against api.anthropic.com and would bill Netlify
// credits, so it counts as no key. Set your own key in Netlify to turn AI mode on.
export function ownAnthropicKey(env = process.env) {
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const base = env.ANTHROPIC_BASE_URL;
  if (!base) return key;
  try {
    return new URL(base).hostname === "api.anthropic.com" ? key : null;
  } catch {
    return null;
  }
}

// Which Claude to use for reading claims, or null when AI mode is off.
//   1. Your own ANTHROPIC_API_KEY (pay Anthropic directly; best model).
//   2. Netlify's AI Gateway: no Anthropic account, card or ID needed. Usage comes out
//      of your Netlify credits, so it uses the cheapest capable model and a daily cap.
// Set MERIDIAN_AI=off in Netlify to turn AI mode off completely.
export function aiProvider(env = process.env) {
  if (String(env.MERIDIAN_AI || "").toLowerCase() === "off") return null;
  const own = ownAnthropicKey(env);
  if (own) {
    return { via: "anthropic", baseUrl: "https://api.anthropic.com", key: own, model: env.CLAIM_MODEL || "claude-sonnet-5-5", dailyLimit: null };
  }
  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_BASE_URL && /^https:\/\/[^\s]+$/.test(env.ANTHROPIC_BASE_URL)) {
    const limit = env.AI_DAILY_LIMIT === undefined || env.AI_DAILY_LIMIT === "" ? NaN : Number(env.AI_DAILY_LIMIT);
    return {
      via: "netlify",
      baseUrl: env.ANTHROPIC_BASE_URL.replace(/\/+$/, ""),
      key: env.ANTHROPIC_API_KEY,
      model: env.CLAIM_MODEL || "claude-haiku-5-5",
      dailyLimit: Number.isFinite(limit) && limit >= 0 ? limit : 50,
    };
  }
  return null;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// JSON response. cacheSeconds lets Netlify's CDN share one upstream call
// between everyone viewing the map, which keeps you inside free API limits.
export function json(body, { status = 200, cacheSeconds = 0 } = {}) {
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (cacheSeconds > 0) {
    headers["netlify-cdn-cache-control"] = `public, s-maxage=${cacheSeconds}, stale-while-revalidate=${cacheSeconds}`;
    headers["cache-control"] = "public, max-age=0, must-revalidate";
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function handleError(err) {
  const status = err instanceof HttpError ? err.status : 502;
  console.error(err);
  return json({ error: err.message || "Upstream request failed" }, { status });
}

export async function fetchWithTimeout(url, options = {}, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new HttpError(502, `${new URL(url).host} answered ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export function featureCollection(features, meta = {}) {
  return { type: "FeatureCollection", features, meta: { fetchedAt: new Date().toISOString(), ...meta } };
}
