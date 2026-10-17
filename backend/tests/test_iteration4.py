"""Iteration 4 backend tests:
- /api/routes/calculate weight_t validation and timings realism (Madrid->Barcelona)
- Response shape: avg_speed_kmh, cum_m/cum_s length matches polyline, steps fields,
  warnings mention weight when weight_t sent
- /api/vehicles POST/PUT without weight_t succeeds (weight_t removed from profile)
"""
import os
import uuid
import pytest
import requests

BASE_URL = (os.environ.get("EXPO_PUBLIC_BACKEND_URL")
            or os.environ.get("EXPO_BACKEND_URL")
            or "https://big-rig-maps-1.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


def _fresh():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    email = f"it4_{uuid.uuid4().hex[:10]}@test.com"
    r = s.post(f"{API}/auth/register", json={"email": email, "password": "test1234", "name": "IT4"})
    assert r.status_code == 201, r.text
    s.headers.update({"Authorization": f"Bearer {r.json()['access_token']}"})
    return s


# ============ VEHICLES WITHOUT WEIGHT ============
class TestVehiclesNoWeight:
    def test_create_without_weight(self):
        s = _fresh()
        r = s.post(f"{API}/vehicles", json={
            "name": "Camión 1", "plate": "1234ABC", "vehicle_type": "truck",
            "length_m": 16.5, "width_m": 2.55, "height_m": 4.0, "axles": 5,
            "max_speed_kmh": 90, "hazmat": False,
        })
        assert r.status_code == 201, r.text
        v = r.json()
        assert "weight_t" not in v
        assert v["max_speed_kmh"] == 90

    def test_create_with_extra_weight_t_is_ignored(self):
        s = _fresh()
        r = s.post(f"{API}/vehicles", json={
            "name": "C2", "length_m": 10, "width_m": 2.4, "height_m": 3.5,
            "axles": 3, "weight_t": 40,  # extra, must be ignored
        })
        assert r.status_code == 201, r.text
        assert "weight_t" not in r.json()

    def test_update_without_weight(self):
        s = _fresh()
        r = s.post(f"{API}/vehicles", json={
            "name": "C", "length_m": 10, "width_m": 2.4, "height_m": 3.5, "axles": 3,
        })
        vid = r.json()["id"]
        r2 = s.put(f"{API}/vehicles/{vid}", json={
            "name": "C-mod", "length_m": 12, "width_m": 2.5, "height_m": 3.6,
            "axles": 4, "max_speed_kmh": 80,
        })
        assert r2.status_code == 200, r2.text
        assert r2.json()["name"] == "C-mod"
        assert r2.json()["max_speed_kmh"] == 80


# ============ ROUTE WEIGHT_T VALIDATION ============
class TestRouteWeight:
    def test_weight_zero_422(self):
        s = _fresh()
        r = s.post(f"{API}/routes/calculate", json={
            "origin": {"lat": 40.4168, "lng": -3.7038},
            "destination": {"lat": 41.3851, "lng": 2.1734},
            "use_current_hours": False, "weight_t": 0,
        })
        assert r.status_code == 422, r.text

    def test_weight_negative_422(self):
        s = _fresh()
        r = s.post(f"{API}/routes/calculate", json={
            "origin": {"lat": 40.4168, "lng": -3.7038},
            "destination": {"lat": 41.3851, "lng": 2.1734},
            "use_current_hours": False, "weight_t": -3,
        })
        assert r.status_code == 422

    def test_weight_too_big_422(self):
        s = _fresh()
        r = s.post(f"{API}/routes/calculate", json={
            "origin": {"lat": 40.4168, "lng": -3.7038},
            "destination": {"lat": 41.3851, "lng": 2.1734},
            "use_current_hours": False, "weight_t": 150,
        })
        assert r.status_code == 422

    def test_weight_mentions_warning(self):
        s = _fresh()
        s.post(f"{API}/vehicles", json={
            "name": "C", "length_m": 10, "width_m": 2.4, "height_m": 3.5, "axles": 3,
        })
        r = s.post(f"{API}/routes/calculate", json={
            "origin": {"lat": 40.4168, "lng": -3.7038},
            "destination": {"lat": 41.3851, "lng": 2.1734},
            "use_current_hours": False, "weight_t": 24,
        })
        assert r.status_code == 200, r.text
        warnings = r.json()["warnings"]
        assert any("24" in w and "t" in w.lower() for w in warnings), warnings


# ============ ROUTE SHAPE + REALISTIC TIMINGS ============
class TestRouteShapeAndTiming:
    @classmethod
    def setup_class(cls):
        cls.s = _fresh()
        r = cls.s.post(f"{API}/routes/calculate", json={
            "origin": {"lat": 40.4168, "lng": -3.7038},
            "destination": {"lat": 41.3851, "lng": 2.1734},
            "use_current_hours": False,
        })
        assert r.status_code == 200, r.text
        cls.data = r.json()

    def test_cum_arrays_length_matches_polyline(self):
        d = self.data
        n = len(d["polyline"])
        assert n > 0
        assert d["cum_m"] is not None and len(d["cum_m"]) == n
        assert d["cum_s"] is not None and len(d["cum_s"]) == n

    def test_cum_monotonic(self):
        d = self.data
        for arr in (d["cum_m"], d["cum_s"]):
            for a, b in zip(arr, arr[1:]):
                assert b >= a - 1e-6

    def test_avg_speed_is_realistic(self):
        d = self.data
        # Madrid-Barcelona on motorway: average ~80-95 km/h for a truck
        assert d["avg_speed_kmh"] is not None
        assert 75 <= d["avg_speed_kmh"] <= 95, d["avg_speed_kmh"]

    def test_truck_time_realistic_7_to_7_6h(self):
        d = self.data
        hours = d["truck_duration_s"] / 3600
        # Must NOT be above 8h; around 7.0-7.6h
        assert hours < 8.0, f"truck too slow: {hours}h"
        assert hours >= 6.5, f"truck too fast: {hours}h"

    def test_truck_time_gte_car_time(self):
        d = self.data
        car_s = d["duration_min"] * 60
        assert d["truck_duration_s"] >= car_s - 60  # allow 1 min rounding

    def test_steps_have_type_modifier_latlng_along(self):
        d = self.data
        steps = d["steps"]
        assert len(steps) >= 2
        for s in steps:
            for k in ("type", "modifier", "lat", "lng", "along_m", "instruction"):
                assert k in s, (k, s)
        # along_m monotonic
        for a, b in zip(steps, steps[1:]):
            assert b["along_m"] >= a["along_m"] - 1e-6


class TestShortUrbanRoute:
    def test_short_truck_similar_to_car(self):
        s = _fresh()
        # ~2 km inside Madrid (Sol -> Atocha)
        r = s.post(f"{API}/routes/calculate", json={
            "origin": {"lat": 40.4169, "lng": -3.7033},
            "destination": {"lat": 40.4068, "lng": -3.6919},
            "use_current_hours": False,
        })
        assert r.status_code == 200, r.text
        d = r.json()
        car_s = d["duration_min"] * 60
        # On urban roads legal truck limit == posted limit, so truck time ~= car time
        if car_s > 0:
            ratio = d["truck_duration_s"] / car_s
            assert 0.9 <= ratio <= 1.4, ratio
