// Claim checker panel, two ways in:
//   Describe it  – paste a claim; Claude reads it (needs an Anthropic key)
//   Pick on map  – click the spot, choose the event type and time window; no AI at all
// Either way, submitting starts a background check and the page polls for
// progress. Every check gets a permanent link (?check=<id>).

const EXAMPLES = [
  "Large explosion reported at the port of Haifa last night",
  "Wildfire burning near Mount Carmel today",
  "Earthquake felt across Beirut this week",
  "Cargo ship ran aground near Ashdod port this morning",
];

const COLORS = { area: "#6cc4ff", fires: "#ff5a36", quakes: "#f2b43c", flights: "#ff3d5e", ships: "#c58cff" };
const POLL_MS = 2000;
const POLL_LIMIT_MS = 4 * 60_000;
const HOUR = 3600_000;
const $ = (id) => document.getElementById(id);

const ui = { mode: "ai", aiAvailable: true, sharedMode: null, pick: null, busy: false };
let pollTimer = null;
let currentId = null;
let mapRef = null;

export function initChecker(map) {
  mapRef = map;
  map.addSource("claim-area", { type: "geojson", data: empty() });
  map.addSource("claim-evidence", { type: "geojson", data: empty() });
  map.addLayer({ id: "claim-area-fill", type: "fill", source: "claim-area", paint: { "fill-color": COLORS.area, "fill-opacity": 0.08 } });
  map.addLayer({ id: "claim-area-line", type: "line", source: "claim-area", paint: { "line-color": COLORS.area, "line-width": 1.5, "line-dasharray": [3, 2] } });
  map.addLayer({
    id: "claim-evidence", type: "circle", source: "claim-evidence",
    paint: {
      "circle-radius": 7,
      "circle-color": ["match", ["get", "kind"], "fires", COLORS.fires, "quakes", COLORS.quakes, "ships", COLORS.ships, COLORS.flights],
      "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5,
    },
  });

  $("claim-examples").innerHTML = EXAMPLES.map((e) => `<button type="button" class="example">${e}</button>`).join("");
  $("claim-examples").addEventListener("click", (ev) => {
    const btn = ev.target.closest(".example");
    if (!btn) return;
    $("claim-input").value = btn.textContent;
    $("claim-input").focus();
  });

  // Mode tabs
  $("mode-ai").addEventListener("click", () => setMode("ai"));
  $("mode-manual").addEventListener("click", () => setMode("manual"));

  // Manual mode controls
  map.on("click", (e) => {
    if (ui.mode !== "manual" || ui.busy) return;
    setPick({ lat: e.lngLat.lat, lon: e.lngLat.lng });
  });
  $("manual-radius").addEventListener("change", drawPickPreview);
  $("manual-window").addEventListener("change", () => {
    const custom = $("manual-window").value === "custom";
    $("custom-window").hidden = !custom;
    if (custom && !$("manual-start").value) {
      $("manual-end").value = toLocalInput(Date.now());
      $("manual-start").value = toLocalInput(Date.now() - 24 * HOUR);
    }
  });

  // Submitting either form (Enter key) or the button runs the check.
  for (const id of ["claim-form", "manual-form"]) {
    $(id).addEventListener("submit", (ev) => { ev.preventDefault(); submit(); });
  }
  $("claim-submit").addEventListener("click", submit);

  $("claim-clear").addEventListener("click", () => {
    stopPolling();
    currentId = null;
    $("claim-input").value = "";
    $("claim-result").hidden = true;
    $("claim-clear").hidden = true;
    setLink(null);
    ui.sharedMode = null;
    renderAiAvailability();
    ui.pick = null;
    renderPick();
    clearMap();
    setBusy(false);
  });

  // Which modes does the server support?
  loadCapabilities();

  // Opened from a shared link?
  const shared = new URLSearchParams(location.search).get("check");
  if (shared) {
    showStatus("Loading saved check…");
    poll(shared, Date.now());
  }
}

async function fetchAiAvailable() {
  const res = await fetch("/api/capabilities", { cache: "no-store" });
  if (!res.ok) throw new Error();
  return Boolean((await res.json()).ai);
}

async function loadCapabilities() {
  try {
    ui.aiAvailable = await fetchAiAvailable();
    // "Off" can be one server instance missing its variables; ask once more before believing it.
    if (!ui.aiAvailable) {
      await new Promise((r) => setTimeout(r, 1000));
      ui.aiAvailable = await fetchAiAvailable();
    }
  } catch {
    // Opened without the server (e.g. straight from a file): manual mode can't run either,
    // but default to it so the page explains itself when the check is attempted.
    ui.aiAvailable = false;
  }
  renderAiAvailability();
  if (!ui.aiAvailable && !new URLSearchParams(location.search).get("check")) setMode("manual");
}

// What the "Describe it" form shows. sharedMode is the mode of the shared check on
// screen, if any: a check Claude read proves AI mode works, so never call it switched off.
export function aiAvailabilityView(aiAvailable, sharedMode) {
  return {
    hintHidden: aiAvailable || sharedMode === "ai",
    inputDisabled: !aiAvailable,
    examplesHidden: !aiAvailable,
  };
}

function renderAiAvailability() {
  const view = aiAvailabilityView(ui.aiAvailable, ui.sharedMode);
  $("ai-unavailable").hidden = view.hintHidden;
  $("claim-input").disabled = view.inputDisabled;
  $("claim-examples").hidden = view.examplesHidden;
}

function setMode(mode) {
  ui.mode = mode;
  $("mode-ai").setAttribute("aria-selected", String(mode === "ai"));
  $("mode-manual").setAttribute("aria-selected", String(mode === "manual"));
  $("claim-form").hidden = mode !== "ai";
  $("manual-form").hidden = mode !== "manual";
  document.querySelector(".map-wrap")?.classList.toggle("picking", mode === "manual");
  if (mode === "manual") drawPickPreview();
}

function setPick(p) {
  ui.pick = p;
  renderPick();
  drawPickPreview();
  // A new pick means any old result no longer matches the circle.
  mapRef.getSource("claim-evidence")?.setData(empty());
  const box = $("claim-result");
  if (box.classList.contains("error")) box.hidden = true;
}

function renderPick() {
  const el = $("pick-readout");
  if (ui.pick) {
    el.textContent = `${ui.pick.lat.toFixed(3)}°, ${ui.pick.lon.toFixed(3)}° · click again to move`;
    el.classList.add("set");
  } else {
    el.textContent = "Click the map to set the spot";
    el.classList.remove("set");
  }
}

function drawPickPreview() {
  if (ui.mode !== "manual" || !ui.pick) return;
  const r = Number($("manual-radius").value);
  mapRef.getSource("claim-area")?.setData({ type: "FeatureCollection", features: [circle([ui.pick.lon, ui.pick.lat], r)] });
}

function buildManualRequest() {
  if (!ui.pick) throw new Error("Click the map to set where it happened.");
  const w = $("manual-window").value;
  let start, end;
  if (w === "custom") {
    start = Date.parse($("manual-start").value);
    end = Date.parse($("manual-end").value);
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("Fill in both the From and To times.");
    if (start >= end) throw new Error("From has to be before To.");
  } else {
    end = Date.now();
    start = end - Number(w) * HOUR;
  }
  return {
    manual: {
      lat: ui.pick.lat, lon: ui.pick.lon,
      radiusKm: Number($("manual-radius").value),
      type: $("manual-type").value,
      place: $("manual-place").value.trim(),
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    },
  };
}

async function submit() {
  if (ui.busy) return;
  let body;
  try {
    if (ui.mode === "manual") {
      body = buildManualRequest();
    } else {
      const text = $("claim-input").value.trim();
      if (!text) return;
      body = { claim: text };
    }
  } catch (err) {
    showError(err.message);
    return;
  }

  setBusy(true);
  showStatus("Sending the claim…");
  try {
    const res = await fetch("/api/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.id) {
      throw new Error(data?.error || (res.status === 404
        ? "The claim checker runs on the server. Start the app with npm run dev, or use the live site."
        : `Check failed (${res.status}).`));
    }
    setLink(data.id);
    poll(data.id, Date.now());
  } catch (err) {
    showError(err.message);
    setBusy(false);
  }
}

async function poll(id, startedAt) {
  stopPolling();
  currentId = id;
  try {
    const res = await fetch(`/api/result?id=${encodeURIComponent(id)}`);
    const rec = await res.json().catch(() => null);
    if (id !== currentId) return; // user started another check
    if (!res.ok || !rec) throw new Error(rec?.error || `Couldn't load the check (${res.status}).`);

    restoreInputs(rec);

    if (rec.status === "failed") {
      showError(rec.error || "The check failed.");
      setBusy(false);
      return;
    }
    if (rec.status !== "done") {
      showStatus(`${rec.stage || "Working"}…`);
    } else {
      showResult(rec);
      drawOnMap(rec.result);
      setBusy(false);
    }
    const imageryPending = rec.status === "done" && rec.imagery?.status === "running";
    const keepGoing = (rec.status !== "done" || imageryPending) && Date.now() - startedAt < POLL_LIMIT_MS;
    if (keepGoing) pollTimer = setTimeout(() => poll(id, startedAt), POLL_MS);
  } catch (err) {
    showError(err.message);
    setBusy(false);
  }
}

// Shared links: show what was checked in the matching form.
let restoredFor = null;
function restoreInputs(rec) {
  if (restoredFor === rec.id) return;
  restoredFor = rec.id;
  ui.sharedMode = rec.mode;
  renderAiAvailability();
  if (rec.mode === "manual" && rec.manual) {
    setMode("manual");
    const m = rec.manual;
    $("manual-type").value = m.type;
    if (![...$("manual-radius").options].some((o) => Number(o.value) === m.radiusKm)) {
      $("manual-radius").add(new Option(`${m.radiusKm} km`, String(m.radiusKm)));
    }
    $("manual-radius").value = String(m.radiusKm);
    $("manual-place").value = /^-?\d/.test(m.place) ? "" : m.place;
    $("manual-window").value = "custom";
    $("custom-window").hidden = false;
    $("manual-start").value = toLocalInput(Date.parse(m.start));
    $("manual-end").value = toLocalInput(Date.parse(m.end));
    ui.pick = { lat: m.lat, lon: m.lon };
    renderPick();
  } else if (rec.claimText && !$("claim-input").value) {
    setMode("ai");
    $("claim-input").value = rec.claimText;
  }
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

function setBusy(busy) {
  ui.busy = busy;
  const b = $("claim-submit");
  b.disabled = busy;
  b.textContent = busy ? "Checking sensors…" : "Check against sensors";
}

function setLink(id) {
  const url = new URL(location.href);
  if (id) url.searchParams.set("check", id); else url.searchParams.delete("check");
  history.replaceState(null, "", url);
}

function showStatus(text) {
  const box = $("claim-result");
  box.hidden = false;
  $("claim-clear").hidden = false;
  box.className = "claim-result";
  box.innerHTML = `<p class="restated"><span class="spinner" aria-hidden="true"></span>${esc(text)}</p>`;
}

function showError(message) {
  const box = $("claim-result");
  box.hidden = false;
  $("claim-clear").hidden = false;
  box.className = "claim-result error";
  box.innerHTML = `<p class="verdict">Couldn't check that</p><p class="restated">${esc(message)}</p>`;
}

function showResult(rec) {
  const d = rec.result;
  const c = d.claim;
  const box = $("claim-result");
  box.hidden = false;
  $("claim-clear").hidden = false;
  const where = c.checkable ? `${esc(c.place)} · ${c.radiusKm} km radius · ${fmtWindow(c.start, c.end)}` : "";
  const how = c.source === "manual" ? "Entered by hand · no AI used" : "Claim read by Claude · verdict by fixed rules";
  box.className = `claim-result ${d.verdict}`;
  box.innerHTML = `
    <p class="verdict">${esc(d.headline)}</p>
    ${c.summary ? `<p class="restated">Claim: ${esc(c.summary)}</p>` : ""}
    ${where ? `<p class="meta">${where}</p>` : ""}
    ${d.findings.length ? `<ul>${d.findings.map((f) => `
      <li><span class="dot ${f.found ? "hit" : "miss"}">${f.found ? "●" : "○"}</span><span>${esc(f.text)}</span></li>`).join("")}</ul>` : ""}
    ${imageryBlock(rec)}
    ${d.caveats.length ? `<div class="caveats">${d.caveats.map(esc).join(" ")}</div>` : ""}
    <div class="share-row">
      <button type="button" id="share-btn">Copy share link</button>
      <input id="share-url" readonly value="${esc(location.href)}" aria-label="Share link">
    </div>
    <p class="meta">${how} · Checked ${new Date(d.checkedAt).toLocaleString("en-CA")}${d.sensorsUsed.length ? ` · ${esc(d.sensorsUsed.join(", "))}` : ""}</p>`;

  $("share-btn").addEventListener("click", async () => {
    const input = $("share-url");
    try {
      await navigator.clipboard.writeText(input.value);
      $("share-btn").textContent = "Link copied";
    } catch {
      input.focus();
      input.select();
      $("share-btn").textContent = "Press Ctrl+C to copy";
    }
    setTimeout(() => { const b = $("share-btn"); if (b) b.textContent = "Copy share link"; }, 2500);
  });
}

function imageryBlock(rec) {
  const c = rec.result.claim;
  if (!c.checkable) return "";
  const img = rec.imagery;
  if (!img || img.status === "running") {
    return `<div class="imagery"><p class="meta"><span class="spinner" aria-hidden="true"></span>Fetching Sentinel-2 satellite images…</p></div>`;
  }
  if (img.status !== "done") return img.note ? `<p class="meta">${esc(img.note)}</p>` : "";
  const tile = (which, label) => {
    const s = img[which];
    if (!s) return `<figure class="tile empty"><div class="ph">No clear image yet</div><figcaption>${label}</figcaption></figure>`;
    return `<figure class="tile"><a href="/api/image?id=${rec.id}&which=${which}" target="_blank" rel="noopener">
      <img src="/api/image?id=${rec.id}&which=${which}" alt="Satellite image ${label.toLowerCase()} the event, ${fmtDate(s.date)}" loading="lazy" width="640" height="640"></a>
      <figcaption>${label} · ${fmtDate(s.date)} · ${s.cloud}% cloud</figcaption></figure>`;
  };
  return `<div class="imagery">
    <div class="tiles">${tile("before", "Before")}${tile("after", "After")}</div>
    <p class="meta">Sentinel-2, 10 m per pixel. Shows large changes like burn scars or smoke, not small details.${img.note ? " " + esc(img.note) : ""}</p>
  </div>`;
}

function drawOnMap(d) {
  const c = d.claim;
  if (!c.checkable) return clearMap();
  mapRef.getSource("claim-area").setData({ type: "FeatureCollection", features: [circle([c.lon, c.lat], c.radiusKm)] });
  const pts = [];
  for (const kind of ["fires", "quakes", "flights", "ships"]) {
    for (const f of d.evidence[kind] || []) pts.push({ ...f, properties: { ...f.properties, kind } });
  }
  mapRef.getSource("claim-evidence").setData({ type: "FeatureCollection", features: pts });
  const r = c.radiusKm / 111.32;
  mapRef.fitBounds([[c.lon - r * 1.6, c.lat - r * 1.2], [c.lon + r * 1.6, c.lat + r * 1.2]], { padding: 40, duration: 1200 });
}

function clearMap() {
  mapRef?.getSource("claim-area")?.setData(empty());
  mapRef?.getSource("claim-evidence")?.setData(empty());
}

// Polygon approximating a circle on the map.
export function circle([lon, lat], radiusKm, steps = 64) {
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    const dLat = (radiusKm / 111.32) * Math.cos(a);
    const dLon = (radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.sin(a);
    ring.push([lon + dLon, lat + dLat]);
  }
  return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: {} };
}

// <input type="datetime-local"> wants local time without a zone: YYYY-MM-DDTHH:MM
function toLocalInput(ms) {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}
function fmtWindow(start, end) {
  const o = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
  return `${new Date(start).toLocaleString("en-CA", o)} – ${new Date(end).toLocaleString("en-CA", o)}`;
}
function fmtDate(iso) { return new Date(iso).toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" }); }
function empty() { return { type: "FeatureCollection", features: [] }; }
function esc(v) { return String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])); }
