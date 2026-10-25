// GET /api/flights?bbox=w,s,e,n
// Live aircraft positions from the OpenSky Network.
// Works without an account (low daily limit). Add OPENSKY_CLIENT_ID and
// OPENSKY_CLIENT_SECRET in Netlify's environment variables for 10x the limit.

import { parseBbox, json, handleError, fetchWithTimeout, featureCollection } from "./_lib/util.mjs";
import { openSkyToFeatures } from "./_lib/transforms.mjs";

const TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
let cachedToken = null; // { value, expiresAt } — survives between calls on a warm function

async function getToken() {
  const id = process.env.OPENSKY_CLIENT_ID;
  const secret = process.env.OPENSKY_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.value;
  const res = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
  });
  const data = await res.json();
  cachedToken = { value: data.access_token, expiresAt: Date.now() + (data.expires_in || 1800) * 1000 };
  return cachedToken.value;
}

export default async (req) => {
  try {
    const [w, s, e, n] = parseBbox(req.url);
    const url = `https://opensky-network.org/api/states/all?lamin=${s}&lomin=${w}&lamax=${n}&lomax=${e}`;
    const token = await getToken();
    const res = await fetchWithTimeout(url, token ? { headers: { authorization: `Bearer ${token}` } } : {});
    const features = openSkyToFeatures(await res.json());
    return json(featureCollection(features, { source: "OpenSky Network", authenticated: Boolean(token) }), { cacheSeconds: 30 });
  } catch (err) {
    return handleError(err);
  }
};

export const config = { path: "/api/flights" };
