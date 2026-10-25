// Sample data used when the live feeds can't be reached (for example when you
// open index.html straight from your computer without running the server).
// Everything here is generated and labelled DEMO in the interface.

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function seedFor(bbox, salt) {
  return Math.abs(Math.round(bbox[0] * 131 + bbox[1] * 71 + bbox[2] * 37 + bbox[3] * 17)) + salt;
}

const AIRLINES = ["ELY", "UAE", "QTR", "THY", "RJA", "MEA", "SVA", "ETD", "AIZ", "ISR", "GFA", "OMA"];
const COUNTRIES = ["Israel", "United Arab Emirates", "Qatar", "Turkey", "Jordan", "Lebanon", "Saudi Arabia", "Egypt", "Cyprus", "Greece"];

export function demoFlights(bbox, count = 70) {
  const r = seeded(seedFor(bbox, 1));
  const [w, s, e, n] = bbox;
  const t = Date.now() / 60000; // drift slowly so refreshes visibly move
  return Array.from({ length: count }, (_, i) => {
    const heading = Math.floor(r() * 360);
    const rad = (heading * Math.PI) / 180;
    const drift = ((t % 60) / 60) * 0.6;
    const lon = w + r() * (e - w) + Math.sin(rad) * drift;
    const lat = s + r() * (n - s) + Math.cos(rad) * drift;
    const code = AIRLINES[Math.floor(r() * AIRLINES.length)];
    const emergency = i === 7 ? "General emergency" : null;
    return {
      type: "Feature",
      geometry: { type: "Point", coordinates: [lon, lat] },
      properties: {
        id: `demo-${i}`,
        callsign: `${code}${100 + Math.floor(r() * 899)}`,
        country: COUNTRIES[Math.floor(r() * COUNTRIES.length)],
        altitudeFt: Math.round(8000 + r() * 33000),
        speedKt: Math.round(280 + r() * 220),
        heading,
        onGround: false,
        squawk: emergency ? "7700" : String(1000 + Math.floor(r() * 6000)),
        emergency,
        demo: true,
      },
    };
  });
}

export function demoQuakes(bbox, count = 9) {
  const r = seeded(seedFor(bbox, 2));
  const [w, s, e, n] = bbox;
  return Array.from({ length: count }, (_, i) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: [w + r() * (e - w), s + r() * (n - s)] },
    properties: {
      id: `demo-q-${i}`,
      mag: Math.round((2.5 + r() * 3) * 10) / 10,
      place: "Demo earthquake",
      time: Date.now() - Math.floor(r() * 6 * 86400000),
      depthKm: Math.round(r() * 40),
      url: null,
      demo: true,
    },
  })).sort((a, b) => b.properties.time - a.properties.time);
}

export function demoFires(bbox, clusters = 6) {
  const r = seeded(seedFor(bbox, 3));
  const [w, s, e, n] = bbox;
  const out = [];
  for (let c = 0; c < clusters; c++) {
    const cx = w + r() * (e - w);
    const cy = s + r() * (n - s);
    const size = 3 + Math.floor(r() * 14);
    for (let i = 0; i < size; i++) {
      out.push({
        type: "Feature",
        geometry: { type: "Point", coordinates: [cx + (r() - 0.5) * 0.25, cy + (r() - 0.5) * 0.25] },
        properties: {
          id: `demo-f-${c}-${i}`,
          frp: Math.round(r() * 80 * 10) / 10,
          detectedAt: new Date(Date.now() - Math.floor(r() * 20 * 3600000)).toISOString(),
          confidence: r() > 0.5 ? "h" : "n",
          demo: true,
        },
      });
    }
  }
  return out;
}
