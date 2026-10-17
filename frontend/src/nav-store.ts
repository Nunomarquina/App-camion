// In-memory hand-off of the calculated route to the navigation screen.
export type NavStep = {
  instruction: string;
  distance_km: number;
  duration_min: number;
  name: string;
  type: string;
  modifier: string;
  lat: number | null;
  lng: number | null;
  along_m: number;
};

export type NavStop = {
  type: "break" | "daily_rest";
  at_drive_s: number;
  lat: number | null;
  lng: number | null;
  km: number | null;
  areas: { id: string; name: string; type: string; lat: number; lng: number; route_km: number; minutes_before_limit: number; drive_s_from_start?: number }[];
};

export type NavRoute = {
  distance_km: number;
  truck_duration_s: number;
  polyline: [number, number][];
  cum_m: number[] | null;
  cum_s: number[] | null;
  steps: NavStep[];
  stops: NavStop[];
};

export type NavRequest = {
  origin: { lat: number; lng: number };
  originName: string;
  destination: { lat: number; lng: number };
  destinationName: string;
  vehicleId?: string;
  vehicleMaxSpeed: number;
  weightT?: number;
  useCurrentHours: boolean;
  distanceKm: number;
  estimateS: number;
  baseEstimateS: number;
};

let current: { route: NavRoute; request: NavRequest } | null = null;

export function setNavigation(route: NavRoute, request: NavRequest) {
  current = { route, request };
}

export function getNavigation() {
  return current;
}

export function clearNavigation() {
  current = null;
}
