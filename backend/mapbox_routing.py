"""Mapbox Directions / Geocoding proxy with truck restrictions."""
import asyncio
import bisect
import math
import os
from typing import Any, Dict, List, Optional

import httpx
import polyline
from fastapi import HTTPException

DIRECTIONS_URL = "https://api.mapbox.com/directions/v5/mapbox/{profile}/{coords}"
GEOCODE_URL = "https://api.mapbox.com/search/geocode/v6/forward"


def _token() -> str:
    token = os.environ.get("MAPBOX_ACCESS_TOKEN")
    if not token:
        raise HTTPException(500, "Mapbox token not configured")
    return token


async def geocode(q: str, proximity: Optional[str] = None, limit: int = 5) -> List[Dict[str, Any]]:
    params = {"q": q, "limit": limit, "language": "es", "access_token": _token()}
    if proximity:
        params["proximity"] = proximity
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(GEOCODE_URL, params=params)
    if r.status_code >= 400:
        raise HTTPException(502, "Error en la búsqueda de Mapbox")
    out = []
    for f in r.json().get("features", []):
        coords = f.get("geometry", {}).get("coordinates")
        if not coords:
            continue
        p = f.get("properties", {})
        out.append({
            "id": f.get("id"),
            "name": p.get("name") or p.get("full_address"),
            "full_address": p.get("full_address") or p.get("name"),
            "lng": coords[0],
            "lat": coords[1],
        })
    return out


def _downsample_idx(n: int, max_points: int = 1500) -> List[int]:
    if n <= max_points:
        return list(range(n))
    step = n / max_points
    idx = [int(i * step) for i in range(max_points)]
    if idx[-1] != n - 1:
        idx.append(n - 1)
    return idx


def truck_segment_speed(d: float, t: float, posted_kmh: Optional[float], vehicle_max_kmh: float) -> float:
    """Realistic truck speed (m/s) for a road segment.
    - Never faster than Mapbox's free-flow car speed for that segment (curves, junctions, urban).
    - Legal truck limits (EU/Spain >3.5t): 90 km/h on motorways (posted >= 100),
      80 km/h on conventional roads (posted 80-99), posted limit below that.
    - Never above the vehicle's own max speed (speed limiter)."""
    car = d / t if t > 0 else vehicle_max_kmh / 3.6
    if posted_kmh:
        legal = 90 if posted_kmh >= 100 else 80 if posted_kmh >= 80 else posted_kmh
    else:
        legal = 90
    return max(1.0, min(car, legal / 3.6, vehicle_max_kmh / 3.6))


async def truck_route(origin: Dict[str, float], destination: Dict[str, float],
                      vehicle: Optional[Dict[str, Any]], weight_t: Optional[float] = None) -> Dict[str, Any]:
    coords = f"{origin['lng']},{origin['lat']};{destination['lng']},{destination['lat']}"
    params: Dict[str, Any] = {
        "access_token": _token(),
        "geometries": "polyline6",
        "overview": "full",
        "steps": "true",
        "language": "es",
        "annotations": "distance,duration,maxspeed",
        "alternatives": "false",
    }
    if vehicle:
        # Mapbox ranges: height/width 0-10 m, weight 0-100 t
        params["max_height"] = min(10, vehicle["height_m"])
        params["max_width"] = min(10, vehicle["width_m"])
    if weight_t:
        params["max_weight"] = min(100, weight_t)
    if vehicle and vehicle.get("hazmat"):
        params["exclude"] = "ferry"

    url = DIRECTIONS_URL.format(profile="driving", coords=coords)
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(url, params=params)
    data = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if r.status_code >= 400 or data.get("code") not in (None, "Ok"):
        code = data.get("code")
        if code in ("NoRoute", "NoSegment"):
            raise HTTPException(422, "No se encontró una ruta apta para las dimensiones del vehículo")
        raise HTTPException(502, data.get("message") or "Error de Mapbox Directions")
    routes = data.get("routes") or []
    if not routes:
        raise HTTPException(422, "No se encontró una ruta apta para las dimensiones del vehículo")
    route = routes[0]

    vmax = float(vehicle.get("max_speed_kmh", 90)) if vehicle else 90.0
    truck_s = 0.0
    cum = [0.0]
    cum_m = [0.0]
    for leg in route.get("legs", []):
        ann = leg.get("annotation", {})
        speeds = ann.get("maxspeed") or []
        for i, (d, t) in enumerate(zip(ann.get("distance", []), ann.get("duration", []))):
            posted = None
            if i < len(speeds) and "speed" in speeds[i]:
                posted = speeds[i]["speed"] * (1.609 if speeds[i].get("unit") == "mph" else 1)
            truck_s += d / truck_segment_speed(d, t, posted, vmax)
            cum.append(truck_s)
            cum_m.append(cum_m[-1] + d)
    if truck_s == 0:
        truck_s = route["duration"]

    points = [[lat, lng] for lat, lng in polyline.decode(route["geometry"], 6)]
    aligned = len(cum) == len(points)

    steps = []
    along = 0.0
    for leg in route.get("legs", []):
        for st in leg.get("steps", []):
            man = st.get("maneuver", {})
            loc = man.get("location") or [None, None]
            steps.append({
                "instruction": man.get("instruction", ""),
                "distance_km": round(st.get("distance", 0) / 1000, 2),
                "duration_min": round(st.get("duration", 0) / 60, 1),
                "name": st.get("name", ""),
                "type": man.get("type", ""),
                "modifier": man.get("modifier", ""),
                "lat": loc[1],
                "lng": loc[0],
                "along_m": round(along, 1),
            })
            along += st.get("distance", 0)

    violations = []
    for n in data.get("notifications", []) + [n for leg in route.get("legs", []) for n in leg.get("notifications", [])]:
        if n.get("type") == "violation" or n.get("subtype") in ("maxHeight", "maxWidth", "maxWeight"):
            details = n.get("details", {})
            violations.append(details.get("message") or n.get("subtype") or "Restricción en la ruta")

    idx = _downsample_idx(len(points))
    dist_m = route["distance"]
    return {
        "distance_km": round(dist_m / 1000, 2),
        "duration_min": round(route["duration"] / 60, 1),
        "truck_duration_s": int(truck_s),
        "avg_speed_kmh": round(dist_m / truck_s * 3.6, 1) if truck_s else None,
        "polyline": [points[i] for i in idx],
        "cum_m": [round(cum_m[i], 1) for i in idx] if aligned else None,
        "cum_s": [round(cum[i], 1) for i in idx] if aligned else None,
        "steps": steps,
        "violations": violations,
        "_points": points,
        "_cum": cum if aligned else None,
    }


# ---------- Rest areas along the route ----------
CATEGORY_URL = "https://api.mapbox.com/search/searchbox/v1/category/{cat}"
REST_CATEGORIES = [("rest_area", "Área de descanso"), ("service_area", "Área de servicio")]
SEARCH_WINDOW_S = 40 * 60      # look for stops in the 40 min of driving before the limit
MAX_OFF_ROUTE_KM = 1.5


def _hav_km(a_lat, a_lng, b_lat, b_lng) -> float:
    r = 6371.0
    p1, p2 = math.radians(a_lat), math.radians(b_lat)
    dp, dl = p2 - p1, math.radians(b_lng - a_lng)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def _index_at(cum: List[float], t: float) -> int:
    return min(len(cum) - 1, bisect.bisect_left(cum, t))


async def _category(client: httpx.AsyncClient, cat: str, bbox: str, proximity: str) -> List[Dict[str, Any]]:
    try:
        r = await client.get(CATEGORY_URL.format(cat=cat), params={
            "access_token": _token(), "bbox": bbox, "proximity": proximity,
            "limit": 25, "language": "es",
        })
        if r.status_code >= 400:
            return []
        return r.json().get("features", [])
    except httpx.HTTPError:
        return []


async def rest_areas_for_stops(points: List[List[float]], cum: Optional[List[float]],
                               stops: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    if not stops or not cum:
        return [{**s, "lat": None, "lng": None, "km": None, "areas": []} for s in stops]
    # cumulative km per point
    km = [0.0]
    for i in range(1, len(points)):
        km.append(km[-1] + _hav_km(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]))

    async def one(stop):
        end_i = _index_at(cum, stop["at_drive_s"])
        start_i = _index_at(cum, max(0, stop["at_drive_s"] - SEARCH_WINDOW_S))
        window = points[start_i:end_i + 1] or [points[end_i]]
        lats = [p[0] for p in window]
        lngs = [p[1] for p in window]
        pad = 0.03
        bbox = f"{min(lngs) - pad},{min(lats) - pad},{max(lngs) + pad},{max(lats) + pad}"
        prox = f"{points[end_i][1]},{points[end_i][0]}"
        async with httpx.AsyncClient(timeout=15) as client:
            results = await asyncio.gather(*[_category(client, c, bbox, prox) for c, _ in REST_CATEGORIES])
        seen, areas = set(), []
        step = max(1, len(window) // 300)
        sampled = list(range(start_i, end_i + 1, step)) or [end_i]
        for (cat, label), feats in zip(REST_CATEGORIES, results):
            for f in feats:
                coords = f.get("geometry", {}).get("coordinates")
                fid = f.get("properties", {}).get("mapbox_id") or f.get("id")
                if not coords or fid in seen:
                    continue
                lng, lat = coords
                best_i, best_d = None, None
                for i in sampled:
                    d = _hav_km(lat, lng, points[i][0], points[i][1])
                    if best_d is None or d < best_d:
                        best_i, best_d = i, d
                if best_d is None or best_d > MAX_OFF_ROUTE_KM:
                    continue
                seen.add(fid)
                p = f.get("properties", {})
                areas.append({
                    "id": fid,
                    "name": p.get("name") or label,
                    "address": p.get("full_address") or p.get("place_formatted") or "",
                    "type": label,
                    "lat": lat,
                    "lng": lng,
                    "off_route_km": round(best_d, 2),
                    "route_km": round(km[best_i], 1),
                    "drive_s_from_start": int(cum[best_i]),
                    "minutes_before_limit": int((stop["at_drive_s"] - cum[best_i]) / 60),
                })
        # Prefer the latest stop before the limit (uses the most driving time)
        areas.sort(key=lambda a: a["minutes_before_limit"])
        return {
            **stop,
            "lat": points[end_i][0],
            "lng": points[end_i][1],
            "km": round(km[end_i], 1),
            "areas": areas[:5],
        }

    return list(await asyncio.gather(*[one(s) for s in stops]))
