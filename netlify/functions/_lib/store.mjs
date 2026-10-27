// Saved checks live in Netlify Blobs (built into Netlify, no setup).
// Tests swap in an in-memory store with setStores().

let stores = null;

async function load() {
  if (stores) return stores;
  const { getStore } = await import("@netlify/blobs");
  stores = {
    checks: getStore({ name: "checks", consistency: "strong" }),
    images: getStore({ name: "check-images", consistency: "strong" }),
  };
  return stores;
}

export function setStores(s) { stores = s; }

export const ID_PATTERN = /^[a-z0-9]{12}$/;

export function newId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export async function getCheck(id) {
  if (!ID_PATTERN.test(id || "")) return null;
  return (await load()).checks.get(id, { type: "json" });
}

export async function saveCheck(record) {
  await (await load()).checks.setJSON(record.id, { ...record, updatedAt: new Date().toISOString() });
}

export async function updateCheck(id, patch) {
  const current = (await getCheck(id)) || { id };
  const next = { ...current, ...patch };
  await saveCheck(next);
  return next;
}

// Daily counter for AI claim reads billed to Netlify credits. Best effort: two
// checks at the same instant can both squeeze in, which is fine for a soft cap.
function usageKey(now) { return `usage-ai-${new Date(now).toISOString().slice(0, 10)}`; }

export async function aiUsedToday(now = Date.now()) {
  const v = await (await load()).checks.get(usageKey(now), { type: "json" });
  return Number(v?.count) || 0;
}

export async function recordAiUse(now = Date.now()) {
  const count = (await aiUsedToday(now)) + 1;
  await (await load()).checks.setJSON(usageKey(now), { count });
  return count;
}

export async function saveImage(id, which, bytes) {
  await (await load()).images.set(`${id}-${which}`, bytes);
}

export async function getImage(id, which) {
  if (!ID_PATTERN.test(id || "") || !["before", "after"].includes(which)) return null;
  return (await load()).images.get(`${id}-${which}`, { type: "arrayBuffer" });
}

// In-memory stand-in with the same methods we use, for tests.
export function memoryStores() {
  const make = () => {
    const m = new Map();
    return {
      async get(k, o) { if (!m.has(k)) return null; const v = m.get(k); return o?.type === "json" ? JSON.parse(v) : v; },
      async setJSON(k, v) { m.set(k, JSON.stringify(v)); },
      async set(k, v) { m.set(k, v); },
      _map: m,
    };
  };
  return { checks: make(), images: make() };
}
