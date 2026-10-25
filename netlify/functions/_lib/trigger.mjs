// Start the background job. Netlify answers background functions with 202 immediately,
// but `netlify dev` runs them inline and only answers when the job ends, which can
// outlast the caller's own 30 s limit. So only wait long enough to see an error; a job
// still running after that has started.
const ACK_MS = 5000;

export async function triggerRun(origin, payload, { ackMs = ACK_MS } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ackMs);
  try {
    const res = await fetch(`${origin}/api/run-check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (res.status >= 400) throw new Error(`Background job didn't start (${res.status})`);
  } catch (err) {
    if (err.name !== "AbortError") throw err;
  } finally {
    clearTimeout(timer);
  }
}
