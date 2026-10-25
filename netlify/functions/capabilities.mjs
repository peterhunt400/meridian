// GET /api/capabilities
// Tells the page which features have keys configured, so it can show the
// right claim checker mode. Never returns the keys themselves.

import { json, ownAnthropicKey } from "./_lib/util.mjs";

export function capabilities(env = process.env) {
  return {
    ai: Boolean(ownAnthropicKey(env)),
    sensors: {
      fires: Boolean(env.FIRMS_MAP_KEY),
      seismic: true,
      flights: true,
      ships: Boolean(env.AISSTREAM_API_KEY),
    },
    imagery: Boolean(env.CDSE_CLIENT_ID && env.CDSE_CLIENT_SECRET),
  };
}

export default async () => json(capabilities(), { cacheSeconds: 60 });

export const config = { path: "/api/capabilities" };
