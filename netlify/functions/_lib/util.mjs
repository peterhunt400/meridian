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
