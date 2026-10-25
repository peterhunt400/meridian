// Meridian front end: map, region switcher, layers, signals.
import { REGIONS, DEFAULT_REGION, findRegion, regionFromBounds } from "./regions.js";
import { FEEDS, loadFeed } from "./feeds.js";
import { buildSignals } from "./signals.js";
import { initChecker } from "./checker.js";

const BASEMAP = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";
const COLORS = { flights: "#6cc4ff", quakes: "#f2b43c", fires: "#ff5a36", alert: "#ff3d5e" };

const state = {
  region: findRegion(new URLSearchParams(location.search).get("region") || DEFAULT_REGION),
  enabled: { flights: true, quakes: true, fires: true },
  data: { flights: [], quakes: [], fires: [] },
  status: { flights: "loading", quakes: "loading", fires: "loading" },
  updated: {},
  timers: {},
  loadToken: 0,
};

const $ = (id) => document.getElementById(id);

// ---------- Map ----------
const map = new maplibregl.Map({
  container: "map",
  style: BASEMAP,
  center: state.region.center,
  zoom: state.region.zoom,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");

map.on("load", () => {
  map.addImage("plane", planeIcon(), { sdf: true, pixelRatio: 2 });

  for (const key of Object.keys(FEEDS)) {
    map.addSource(key, { type: "geojson", data: emptyFC() });
  }

  map.addLayer({
    id: "fires", type: "circle", source: "fires",
    paint: {
      "circle-color": COLORS.fires,
      "circle-radius": ["interpolate", ["linear"], ["get", "frp"], 0, 2.5, 50, 5, 300, 9],
      "circle-opacity": 0.75, "circle-blur": 0.4,
    },
  });

  map.addLayer({
    id: "quakes", type: "circle", source: "quakes",
    paint: {
      "circle-color": COLORS.quakes, "circle-opacity": 0.25,
      "circle-stroke-color": COLORS.quakes, "circle-stroke-width": 1.5,
      "circle-radius": ["interpolate", ["exponential", 1.8], ["get", "mag"], 2.5, 4, 5, 12, 7, 28],
    },
  });

  map.addLayer({
    id: "flight-alerts", type: "circle", source: "flights", filter: ["!=", ["get", "emergency"], null],
    paint: { "circle-radius": 15, "circle-color": "rgba(0,0,0,0)", "circle-stroke-color": COLORS.alert, "circle-stroke-width": 2 },
  });
  map.addLayer({
    id: "flights", type: "symbol", source: "flights",
    layout: {
      "icon-image": "plane", "icon-size": 0.75, "icon-allow-overlap": true, "icon-ignore-placement": true,
      "icon-rotate": ["get", "heading"], "icon-rotation-alignment": "map",
    },
    paint: {
      "icon-color": ["case", ["!=", ["get", "emergency"], null], COLORS.alert, ["get", "onGround"], "#4b6170", COLORS.flights],
    },
  });

  initChecker(map); // drawn last so its layers sit on top

  for (const id of ["flights", "quakes", "fires"]) {
    map.on("click", id, (e) => showPopup(id, e.features[0]));
    map.on("mouseenter", id, () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", id, () => (map.getCanvas().style.cursor = ""));
  }

  loadAll();
});

// ---------- Data ----------
async function loadAll() {
  const token = ++state.loadToken;
  for (const key of Object.keys(FEEDS)) {
    clearTimeout(state.timers[key]);
    refresh(key, token);
  }
}

async function refresh(key, token) {
  if (token !== state.loadToken) return; // region changed since this was scheduled
  if (!state.enabled[key] || document.hidden) {
    state.timers[key] = setTimeout(() => refresh(key, token), 5000);
    return;
  }
  const result = await loadFeed(key, state.region.bbox);
  if (token !== state.loadToken) return;
  state.data[key] = result.features;
  state.status[key] = result.mode;
  state.updated[key] = new Date();
  map.getSource(key)?.setData({ type: "FeatureCollection", features: result.features });
  render();
  state.timers[key] = setTimeout(() => refresh(key, token), FEEDS[key].refreshMs);
}

// ---------- Region switching ----------
function setRegion(region, { fly = true } = {}) {
  state.region = region;
  for (const key of Object.keys(FEEDS)) state.status[key] = "loading";
  if (!region.custom) {
    const url = new URL(location.href);
    url.searchParams.set("region", region.id);
    history.replaceState(null, "", url);
    if (fly) map.fitBounds([[region.bbox[0], region.bbox[1]], [region.bbox[2], region.bbox[3]]], { padding: 30, duration: 1200 });
  }
  render();
  loadAll();
}

function buildRegionSelect() {
  const sel = $("region");
  sel.innerHTML = REGIONS.map((r) => `<option value="${r.id}">${r.name}</option>`).join("") +
    `<option value="view" hidden>Current view</option>`;
  sel.value = state.region.id;
  sel.addEventListener("change", () => setRegion(findRegion(sel.value)));
  $("use-view").addEventListener("click", () => {
    setRegion(regionFromBounds(map.getBounds()), { fly: false });
    sel.value = "view";
  });
}

// ---------- Panel ----------
function buildLayerList() {
  $("layers").innerHTML = Object.entries(FEEDS).map(([key, f]) => `
    <li class="layer">
      <input type="checkbox" id="toggle-${key}" ${state.enabled[key] ? "checked" : ""}>
      <label for="toggle-${key}"><span class="swatch" style="background:${COLORS[key]}"></span>${f.label}</label>
      <span class="n" id="n-${key}">–</span>
      <span class="pill loading" id="pill-${key}">…</span>
    </li>`).join("");
  for (const key of Object.keys(FEEDS)) {
    $(`toggle-${key}`).addEventListener("change", (e) => {
      state.enabled[key] = e.target.checked;
      const vis = e.target.checked ? "visible" : "none";
      const ids = key === "flights" ? ["flights", "flight-alerts"] : [key];
      ids.forEach((id) => map.getLayer(id) && map.setLayoutProperty(id, "visibility", vis));
      render();
    });
  }
}

function render() {
  const [w, s, e, n] = state.region.bbox;
  $("bbox-readout").textContent = `${s.toFixed(1)}°–${n.toFixed(1)}° lat · ${w.toFixed(1)}°–${e.toFixed(1)}° lon`;

  for (const key of Object.keys(FEEDS)) {
    const pill = $(`pill-${key}`);
    const st = state.status[key];
    pill.className = `pill ${st}`;
    pill.textContent = st === "live" ? "LIVE" : st === "demo" ? "DEMO" : "…";
    pill.title = st === "demo" ? "Live feed unavailable, showing generated sample data" : "";
    $(`n-${key}`).textContent = st === "loading" ? "–" : state.data[key].length.toLocaleString("en-CA");
  }

  const visible = Object.fromEntries(Object.keys(FEEDS).map((k) => [k, state.enabled[k] ? state.data[k] : []]));
  // Signals from a layer in demo mode come from generated data; label them so they never read as real alerts.
  const signals = buildSignals(visible).map((s) =>
    state.status[s.kind + "s"] === "demo" ? { ...s, title: `DEMO · ${s.title}` } : s);
  $("signal-count").textContent = signals.length;
  $("signals").innerHTML = signals.length
    ? signals.slice(0, 50).map((s) => `
      <li class="signal" data-lon="${s.coords[0]}" data-lat="${s.coords[1]}" tabindex="0">
        <span class="stripe" style="background:${s.severity >= 3 ? COLORS.alert : COLORS[s.kind === "flight" ? "flights" : s.kind + "s"]}"></span>
        <div><div class="t">${esc(s.title)}</div><div class="d">${esc(s.detail)}</div><div class="when">${ago(s.time)}</div></div>
      </li>`).join("")
    : `<li class="empty">Nothing unusual in this area right now. Emergencies, M4.5+ quakes and fire clusters show up here.</li>`;

  const latest = Math.max(0, ...Object.values(state.updated).map((d) => d.getTime()));
  $("hud").textContent = `${state.region.name.toUpperCase()} · ${latest ? "updated " + new Date(latest).toLocaleTimeString("en-CA", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "loading"}`;
}

$("signals").addEventListener("click", (e) => focusSignal(e.target.closest(".signal")));
$("signals").addEventListener("keydown", (e) => e.key === "Enter" && focusSignal(e.target.closest(".signal")));
function focusSignal(li) {
  if (!li) return;
  map.flyTo({ center: [Number(li.dataset.lon), Number(li.dataset.lat)], zoom: Math.max(map.getZoom(), 7), duration: 1000 });
}

// ---------- Popups ----------
function showPopup(layer, f) {
  const p = f.properties;
  const demo = p.demo === true || p.demo === "true" ? `<p class="warn" style="color:var(--quake)">Demo data</p>` : "";
  let html;
  if (layer === "flights") {
    const em = p.emergency && p.emergency !== "null" ? `<p class="warn">${esc(p.emergency)} (${esc(p.squawk)})</p>` : "";
    html = `${demo}${em}<h3>${esc(p.callsign)}</h3><dl>
      <dt>Origin</dt><dd>${esc(p.country)}</dd>
      <dt>Altitude</dt><dd>${num(p.altitudeFt)} ft</dd>
      <dt>Speed</dt><dd>${num(p.speedKt)} kt</dd>
      <dt>Heading</dt><dd>${esc(p.heading)}°</dd>
      <dt>Squawk</dt><dd>${esc(p.squawk ?? "–")}</dd>
      <dt>ICAO24</dt><dd>${esc(p.id)}</dd></dl>`;
  } else if (layer === "quakes") {
    html = `${demo}<h3>M${esc(p.mag)} earthquake</h3><dl>
      <dt>Where</dt><dd>${esc(p.place)}</dd>
      <dt>When</dt><dd>${new Date(Number(p.time)).toLocaleString("en-CA")}</dd>
      <dt>Depth</dt><dd>${esc(p.depthKm)} km</dd></dl>
      ${p.url && p.url !== "null" ? `<p><a href="${esc(p.url)}" target="_blank" rel="noopener">USGS event page</a></p>` : ""}`;
  } else {
    html = `${demo}<h3>Heat detection</h3><dl>
      <dt>Detected</dt><dd>${p.detectedAt ? new Date(p.detectedAt).toLocaleString("en-CA") : "–"}</dd>
      <dt>Power</dt><dd>${esc(p.frp)} MW</dd>
      <dt>Confidence</dt><dd>${esc({ l: "low", n: "nominal", h: "high" }[p.confidence] || p.confidence || "–")}</dd></dl>`;
  }
  new maplibregl.Popup({ maxWidth: "280px" }).setLngLat(f.geometry.coordinates).setHTML(`<div class="pop">${html}</div>`).addTo(map);
}

// ---------- Helpers ----------
function planeIcon() {
  const size = 48;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.beginPath();
  g.moveTo(24, 4);  g.lineTo(28, 20); g.lineTo(44, 28); g.lineTo(44, 32);
  g.lineTo(28, 28); g.lineTo(27, 38); g.lineTo(32, 42); g.lineTo(32, 45);
  g.lineTo(24, 42); g.lineTo(16, 45); g.lineTo(16, 42); g.lineTo(21, 38);
  g.lineTo(20, 28); g.lineTo(4, 32);  g.lineTo(4, 28);  g.lineTo(20, 20);
  g.closePath();
  g.fill();
  return g.getImageData(0, 0, size, size);
}
function emptyFC() { return { type: "FeatureCollection", features: [] }; }
function esc(v) { return String(v ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])); }
function num(v) { return v == null || v === "null" ? "–" : Number(v).toLocaleString("en-CA"); }
function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

document.addEventListener("visibilitychange", () => { if (!document.hidden) render(); });

buildRegionSelect();
buildLayerList();
render();
