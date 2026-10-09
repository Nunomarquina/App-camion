"""Mapbox Directions / Geocoding proxy with truck restrictions."""
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


def _downsample(points: List[List[float]], max_points: int = 1500) -> List[List[float]]:
    if len(points) <= max_points:
        return points
    step = len(points) / max_points
    res = [points[int(i * step)] for i in range(max_points)]
    res.append(points[-1])
    return res


async def truck_route(origin: Dict[str, float], destination: Dict[str, float],
                      vehicle: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    coords = f"{origin['lng']},{origin['lat']};{destination['lng']},{destination['lat']}"
    params: Dict[str, Any] = {
        "access_token": _token(),
        "geometries": "polyline6",
        "overview": "full",
        "steps": "true",
        "language": "es",
        "annotations": "distance,duration",
        "alternatives": "false",
    }
    if vehicle:
        # Mapbox ranges: height/width 0-10 m, weight 0-100 t
        params["max_height"] = min(10, vehicle["height_m"])
        params["max_width"] = min(10, vehicle["width_m"])
        params["max_weight"] = min(100, vehicle["weight_t"])
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

    # Truck time: cap each segment's speed at the vehicle max speed
    max_speed_ms = (vehicle.get("max_speed_kmh", 90) if vehicle else 90) / 3.6
    truck_s = 0.0
    for leg in route.get("legs", []):
        ann = leg.get("annotation", {})
        for d, t in zip(ann.get("distance", []), ann.get("duration", [])):
            truck_s += max(t, d / max_speed_ms)
    if truck_s == 0:
        truck_s = route["duration"]
    # Heavy vehicles accelerate/brake slower: small penalty by weight
    if vehicle and vehicle.get("weight_t", 0) > 20:
        truck_s *= 1.05

    steps = []
    for leg in route.get("legs", []):
        for st in leg.get("steps", []):
            man = st.get("maneuver", {})
            steps.append({
                "instruction": man.get("instruction", ""),
                "distance_km": round(st.get("distance", 0) / 1000, 2),
                "duration_min": round(st.get("duration", 0) / 60, 1),
                "name": st.get("name", ""),
            })

    points = [[lat, lng] for lat, lng in polyline.decode(route["geometry"], 6)]

    violations = []
    for n in data.get("notifications", []) + [n for leg in route.get("legs", []) for n in leg.get("notifications", [])]:
        if n.get("type") == "violation" or n.get("subtype") in ("maxHeight", "maxWidth", "maxWeight"):
            details = n.get("details", {})
            violations.append(details.get("message") or n.get("subtype") or "Restricción en la ruta")

    return {
        "distance_km": round(route["distance"] / 1000, 2),
        "duration_min": round(route["duration"] / 60, 1),
        "truck_duration_s": int(truck_s),
        "polyline": _downsample(points),
        "steps": steps,
        "violations": violations,
    }
