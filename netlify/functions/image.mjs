// GET /api/image?id=abc123def456&which=before|after   -> PNG
// Satellite images saved with a check. They never change once saved.

import { getImage } from "./_lib/store.mjs";

export default async (req) => {
  const q = new URL(req.url).searchParams;
  try {
    const bytes = await getImage(q.get("id"), q.get("which"));
    if (!bytes) return new Response("Not found", { status: 404 });
    return new Response(bytes, {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    console.error(err);
    return new Response("Image unavailable", { status: 502 });
  }
};

export const config = { path: "/api/image" };
