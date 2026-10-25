// Regions the map can switch between.
// bbox is [west, south, east, north] in degrees. Add your own by copying an entry.

export const REGIONS = [
  { id: "middle-east",  name: "Middle East",           bbox: [25, 12, 63, 42],     center: [42, 28],     zoom: 4 },
  { id: "levant",       name: "Israel & Levant",       bbox: [32, 29, 39.5, 37.5], center: [35.4, 32.6], zoom: 6.3 },
  { id: "east-med",     name: "Eastern Mediterranean", bbox: [22, 30, 37, 40],     center: [29.5, 35],   zoom: 5.2 },
  { id: "gulf",         name: "Persian Gulf",          bbox: [47, 22, 60, 31],     center: [53, 26.5],   zoom: 5.4 },
  { id: "red-sea",      name: "Red Sea & Bab el-Mandeb", bbox: [32, 11, 45, 30],   center: [39, 20],     zoom: 4.8 },
  { id: "europe",       name: "Europe",                bbox: [-12, 35, 32, 62],    center: [10, 50],     zoom: 3.6 },
  { id: "canada-lakes", name: "Canada & Great Lakes",  bbox: [-93, 41, -73, 50],   center: [-82, 45.5],  zoom: 4.8 },
  { id: "global",       name: "Global",                bbox: [-180, -70, 180, 75], center: [20, 25],     zoom: 1.6 },
];

export const DEFAULT_REGION = "middle-east";

export function findRegion(id) {
  return REGIONS.find((r) => r.id === id) || REGIONS.find((r) => r.id === DEFAULT_REGION);
}

// Turn the visible map area into a region, so "Current view" works anywhere.
export function regionFromBounds(bounds) {
  const w = Math.max(-180, bounds.getWest());
  const e = Math.min(180, bounds.getEast());
  const s = Math.max(-85, bounds.getSouth());
  const n = Math.min(85, bounds.getNorth());
  return { id: "view", name: "Current view", bbox: [w, s, e, n], custom: true };
}
