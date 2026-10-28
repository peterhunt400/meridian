// GET /api/capabilities
// Tells the page which features have keys configured, so it can show the
// right claim checker mode. Never returns the keys themselves.

import { json, aiProvider, aiVarNames, runtimeEnv } from "./_lib/util.mjs";

export function capabilities(env = runtimeEnv()) {
  return {
    ai: Boolean(aiProvider(env)),
    sensors: {
      fires: Boolean(env.FIRMS_MAP_KEY),
      seismic: true,
      flights: true,
      ships: Boolean(env.AISSTREAM_API_KEY),
    },
    imagery: Boolean(env.CDSE_CLIENT_ID && env.CDSE_CLIENT_SECRET),
  };
}

// Only a positive answer goes in the CDN cache. "AI off" may be one invocation
// missing its variables, and caching it would hand Pick-on-map mode to every
// visitor for the next minute.
export function capabilitiesResponse(env = runtimeEnv()) {
  const caps = capabilities(env);
  if (!caps.ai) {
    console.warn(`capabilities: AI off. AI variables set: process.env [${aiVarNames(process.env).join(", ")}], with Netlify.env [${aiVarNames(env).join(", ")}]`);
  }
  if (caps.ai) return json(caps, { cacheSeconds: 60 });
  const res = json(caps);
  res.headers.set("cache-control", "no-store");
  return res;
}

export default async () => capabilitiesResponse();

export const config = { path: "/api/capabilities" };
