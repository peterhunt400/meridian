// Ships: live AIS positions from aisstream.io (free key).
// AIS is the radio system ships use to broadcast identity, position and status.
// aisstream only offers a live stream, so we listen for a short while and keep
// the latest report from each vessel. History needs a stored feed (phase 3).

import { bboxAround } from "./claim.mjs";

export const NAV_STATUS = {
  0: "Under way using engine", 1: "At anchor", 2: "Not under command", 3: "Restricted manoeuvrability",
  4: "Constrained by draught", 5: "Moored", 6: "Aground", 7: "Engaged in fishing", 8: "Under way sailing",
  14: "Emergency beacon (AIS-SART) active", 15: "Undefined",
};
// Statuses that suggest something has gone wrong.
export const DISTRESS_STATUSES = new Set([2, 6, 14]);

// Turn raw aisstream messages into one GeoJSON feature per vessel.
export function aisToFeatures(messages) {
  const latest = new Map();
  for (const m of messages) {
    if (m?.MessageType !== "PositionReport") continue;
    const meta = m.MetaData || {};
    const pr = m.Message?.PositionReport || {};
    const lat = Number(meta.latitude ?? pr.Latitude);
    const lon = Number(meta.longitude ?? pr.Longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const mmsi = String(meta.MMSI ?? pr.UserID ?? "");
    if (!mmsi) continue;
    const status = Number(pr.NavigationalStatus);
    latest.set(mmsi, {
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        id: mmsi,
        name: String(meta.ShipName || "").trim() || `MMSI ${mmsi}`,
        speedKt: Number.isFinite(pr.Sog) ? Math.round(pr.Sog * 10) / 10 : null,
        course: Number.isFinite(pr.Cog) ? Math.round(pr.Cog) : null,
        navStatus: Number.isFinite(status) ? status : 15,
        navStatusLabel: NAV_STATUS[status] || "Undefined",
        distress: DISTRESS_STATUSES.has(status),
        reportedAt: meta.time_utc || null,
      },
    });
  }
  return [...latest.values()];
}

// Listen to the live stream for listenMs and return the vessels heard.
export async function fetchShipsNow(claim, { listenMs = 20000, WebSocketImpl } = {}) {
  const key = process.env.AISSTREAM_API_KEY;
  if (!key) throw new Error("Ship sensor needs AISSTREAM_API_KEY.");
  const WS = WebSocketImpl || globalThis.WebSocket || (await import("ws")).default;
  const [w, s, e, n] = bboxAround(claim.lat, claim.lon, claim.radiusKm);
  const messages = [];

  await new Promise((resolve, reject) => {
    const ws = new WS("wss://stream.aisstream.io/v0/stream");
    let opened = false;
    const stop = setTimeout(() => { try { ws.close(); } catch {} resolve(); }, listenMs);
    // A drop after aisstream has sent something keeps what we heard; a drop before
    // that (bad key, outage) is a sensor failure, never "no ships nearby".
    const fail = (err) => { clearTimeout(stop); try { ws.close(); } catch {} messages.length ? resolve() : reject(err); };
    // aisstream rejects a bad key by dropping the socket without an error message.
    // Node's built-in WebSocket reports that as an error, the ws package as a close.
    const dropped = () => fail(new Error(opened
      ? "aisstream.io closed the connection. Check AISSTREAM_API_KEY."
      : "Couldn't connect to aisstream.io"));

    ws.onopen = () => {
      opened = true;
      ws.send(JSON.stringify({ APIKey: key, BoundingBoxes: [[[s, w], [n, e]]], FilterMessageTypes: ["PositionReport"] }));
    };
    ws.onmessage = async (ev) => {
      try {
        const raw = typeof ev.data === "string" ? ev.data
          : ev.data?.text ? await ev.data.text()
          : Buffer.from(ev.data).toString("utf8");
        const msg = JSON.parse(raw);
        if (msg.error) return fail(new Error(`aisstream: ${msg.error}`));
        messages.push(msg);
      } catch { /* skip malformed messages */ }
    };
    ws.onerror = dropped;
    ws.onclose = dropped;
  });

  return aisToFeatures(messages);
}
