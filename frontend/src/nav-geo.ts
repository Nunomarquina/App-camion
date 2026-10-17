// Geometry helpers for turn-by-turn navigation.
export type LatLng = [number, number];

const R = 6371000;
const toRad = (d: number) => (d * Math.PI) / 180;

export function distM(a: LatLng, b: LatLng): number {
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function bearing(a: LatLng, b: LatLng): number {
  const y = Math.sin(toRad(b[1] - a[1])) * Math.cos(toRad(b[0]));
  const x =
    Math.cos(toRad(a[0])) * Math.sin(toRad(b[0])) -
    Math.sin(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.cos(toRad(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function cumulative(poly: LatLng[]): number[] {
  const out = [0];
  for (let i = 1; i < poly.length; i++) out.push(out[i - 1] + distM(poly[i - 1], poly[i]));
  return out;
}

/** Project p on segment a-b (local flat approximation). Returns t in [0,1] and distance in m. */
function project(p: LatLng, a: LatLng, b: LatLng) {
  const kx = Math.cos(toRad(p[0])) * 111320;
  const ky = 110540;
  const ax = a[1] * kx, ay = a[0] * ky;
  const bx = b[1] * kx, by = b[0] * ky;
  const px = p[1] * kx, py = p[0] * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const qx = ax + t * dx, qy = ay + t * dy;
  return { t, d: Math.hypot(px - qx, py - qy) };
}

export type Progress = { idx: number; alongM: number; offM: number };

/** Locate position on the route, searching near the previous index first. */
export function locate(poly: LatLng[], cum: number[], p: LatLng, hint: number): Progress {
  const search = (from: number, to: number) => {
    let best: Progress = { idx: 0, alongM: 0, offM: Infinity };
    for (let i = Math.max(0, from); i < Math.min(poly.length - 1, to); i++) {
      const { t, d } = project(p, poly[i], poly[i + 1]);
      if (d < best.offM) best = { idx: i, alongM: cum[i] + t * (cum[i + 1] - cum[i]), offM: d };
    }
    return best;
  };
  let best = search(hint - 10, hint + 150);
  if (best.offM > 150) {
    const full = search(0, poly.length);
    if (full.offM < best.offM) best = full;
  }
  if (poly.length === 1) best = { idx: 0, alongM: 0, offM: distM(p, poly[0]) };
  return best;
}

/** Point and heading at a distance along the route. */
export function pointAt(poly: LatLng[], cum: number[], alongM: number): { p: LatLng; heading: number } {
  if (alongM <= 0) return { p: poly[0], heading: poly.length > 1 ? bearing(poly[0], poly[1]) : 0 };
  for (let i = 0; i < poly.length - 1; i++) {
    if (cum[i + 1] >= alongM) {
      const seg = cum[i + 1] - cum[i] || 1;
      const t = (alongM - cum[i]) / seg;
      return {
        p: [poly[i][0] + (poly[i + 1][0] - poly[i][0]) * t, poly[i][1] + (poly[i + 1][1] - poly[i][1]) * t],
        heading: bearing(poly[i], poly[i + 1]),
      };
    }
  }
  const n = poly.length;
  return { p: poly[n - 1], heading: n > 1 ? bearing(poly[n - 2], poly[n - 1]) : 0 };
}

/** Interpolate value array (e.g. cumulative seconds) at a distance along the route. */
export function valueAt(cum: number[], values: number[], alongM: number): number {
  for (let i = 0; i < cum.length - 1; i++) {
    if (cum[i + 1] >= alongM) {
      const seg = cum[i + 1] - cum[i] || 1;
      return values[i] + ((alongM - cum[i]) / seg) * (values[i + 1] - values[i]);
    }
  }
  return values[values.length - 1] ?? 0;
}

export function fmtDist(m: number): string {
  if (m >= 10000) return `${Math.round(m / 1000)} km`;
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  if (m >= 100) return `${Math.round(m / 50) * 50} m`;
  return `${Math.max(0, Math.round(m / 10) * 10)} m`;
}

export function maneuverIcon(type: string, modifier: string): string {
  if (type === "arrive") return "flag-checkered";
  if (type === "depart") return "navigation-variant";
  if (type === "roundabout" || type === "rotary" || type === "roundabout turn" || type === "exit roundabout")
    return "rotate-right";
  if (type === "fork" || type === "on ramp" || type === "off ramp") return "call-split";
  switch (modifier) {
    case "uturn":
      return "arrow-u-left-top";
    case "sharp left":
    case "left":
      return "arrow-left-top";
    case "slight left":
      return "arrow-top-left";
    case "sharp right":
    case "right":
      return "arrow-right-top";
    case "slight right":
      return "arrow-top-right";
    default:
      return "arrow-up";
  }
}
