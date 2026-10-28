// GET /api/capabilities
// Tells the page which features have keys configured, so it can show the
// right claim checker mode. Never returns the keys themselves.

import { json, aiProvider } from "./_lib/util.mjs";

export function capabilities(env = process.env) {
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

// TEMPORARY DIAGNOSTIC: env var NAMES only, never values.
const BOOT = Date.now();
let calls = 0;
const WATCH = ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "NETLIFY_AI_GATEWAY_KEY", "NETLIFY_AI_GATEWAY_URL", "OPENAI_API_KEY", "OPENAI_BASE_URL", "FIRMS_MAP_KEY", "AISSTREAM_API_KEY"];
function diag(req) {
  const nenv = globalThis.Netlify?.env;
  const p = WATCH.filter((n) => process.env[n]).join(",") || "-";
  let ne = "n/a";
  if (nenv) ne = WATCH.filter((n) => { try { return nenv.get(n); } catch { return false; } }).join(",") || "-";
  const aiNames = Object.keys(process.env).filter((n) => /AI_GATEWAY|ANTHROPIC|NETLIFY_AI/i.test(n)).join(",") || "-";
  let urlShape = "-";
  try { const u = process.env.ANTHROPIC_BASE_URL; if (u) urlShape = new URL(u).protocol; } catch { urlShape = "bad"; }
  calls += 1;
  return `diag call=${calls} ageMs=${Date.now() - BOOT} ua=${(req.headers.get("user-agent") || "").slice(0, 60)} process.env=[${p}] Netlify.env=[${ne}] aiNames=[${aiNames}] baseProto=${urlShape} ai=${Boolean(aiProvider())}`;
}

export default async (req) => {
  const line = diag(req);
  console.log(line);
  const res = json(capabilities(), { cacheSeconds: 60 });
  res.headers.set("x-meridian-diag", line.replace(/ ua=.*? process/, " process"));
  return res;
};

export const config = { path: "/api/capabilities" };
