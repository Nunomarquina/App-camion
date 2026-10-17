"""Iteration 6 backend tests - Truck speed model recalibration.

Real trip reference: Burgos (Polígono Gamonal, 42.362,-3.645) ->
1935 Rte de la Gare, 40290 Misson, France (43.587684,-0.942001).
Real truck time: 4h15-4h20 (target ~4h18). Car time ~3h16.

Model: motorway 90*0.97, conventional min(car*0.92, 80*0.92 or posted),
weight slowdown 0.15%/t over 20t, +60s per toll, +10s per maneuver.
"""
import os
import pytest
import requests

BASE_URL = os.environ["EXPO_PUBLIC_BACKEND_URL"].rstrip("/")
API = f"{BASE_URL}/api"

EMAIL = "driver@test.com"
PASSWORD = "test1234"

BURGOS = {"lat": 42.362, "lng": -3.645}
MISSON = {"lat": 43.587684, "lng": -0.942001}
MADRID = {"lat": 40.4168, "lng": -3.7038}
BARCELONA = {"lat": 41.3851, "lng": 2.1734}
SOL = {"lat": 40.4168, "lng": -3.7038}
ATOCHA = {"lat": 40.4065, "lng": -3.6895}


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    r = s.post(f"{API}/auth/login", json={"email": EMAIL, "password": PASSWORD})
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    tok = r.json()["access_token"]
    s.headers.update({"Authorization": f"Bearer {tok}"})
    return s


def _calc(session, origin, destination, weight_t=None):
    body = {"origin": origin, "destination": destination, "use_current_hours": False}
    if weight_t is not None:
        body["weight_t"] = weight_t
    r = session.post(f"{API}/routes/calculate", json=body)
    assert r.status_code == 200, f"{r.status_code} {r.text}"
    return r.json()


# ============ BURGOS -> MISSON (real-trip calibration) ============
class TestBurgosMissonCalibration:
    @classmethod
    def setup_class(cls):
        s = requests.Session()
        s.headers.update({"Content-Type": "application/json"})
        r = s.post(f"{API}/auth/login", json={"email": EMAIL, "password": PASSWORD})
        assert r.status_code == 200
        s.headers.update({"Authorization": f"Bearer {r.json()['access_token']}"})
        cls.s = s
        cls.d_w40 = _calc(s, BURGOS, MISSON, weight_t=40)
        cls.d_now = _calc(s, BURGOS, MISSON)

    def test_distance_around_319_km(self):
        d = self.d_w40["distance_km"]
        assert 300 <= d <= 345, f"distance_km={d}"

    def test_truck_time_in_window_40t(self):
        hours = self.d_w40["truck_duration_s"] / 3600
        # Target ~4h18, acceptable 4h05 - 4h30
        assert 4.0833 <= hours <= 4.5, f"truck hours={hours}"

    def test_tolls_present(self):
        assert self.d_w40["tolls"] >= 1, self.d_w40["tolls"]

    def test_avg_speed_reasonable(self):
        v = self.d_w40["avg_speed_kmh"]
        assert v is not None and 65 <= v <= 85, f"avg_speed_kmh={v}"

    def test_truck_gte_car(self):
        d = self.d_w40
        car_s = d["duration_min"] * 60
        assert d["truck_duration_s"] >= car_s - 60

    def test_no_weight_slightly_faster_than_40t(self):
        # Weight slowdown over 20t: 40t -> 1 + 0.15%*20 = 1.03, so ~3% slower
        t_w40 = self.d_w40["truck_duration_s"]
        t_now = self.d_now["truck_duration_s"]
        assert t_now < t_w40, f"expected no-weight ({t_now}s) < 40t ({t_w40}s)"
        # Expect no-weight around 4h11 (~15060s); should be <= 4h25
        hours_now = t_now / 3600
        assert 3.95 <= hours_now <= 4.42, f"no-weight hours={hours_now}"


# ============ MADRID -> BARCELONA ============
class TestMadridBarcelona:
    def test_truck_time_7h_to_8h15(self, session):
        d = _calc(session, MADRID, BARCELONA, weight_t=40)
        hours = d["truck_duration_s"] / 3600
        assert 7.0 <= hours <= 8.25, f"MAD-BCN hours={hours}"
        # Also sanity-check avg speed and distance
        assert d["avg_speed_kmh"] is not None
        assert d["distance_km"] > 500


# ============ SHORT URBAN SOL -> ATOCHA ============
class TestShortUrban:
    def test_truck_car_ratio(self, session):
        d = _calc(session, SOL, ATOCHA)
        car_s = d["duration_min"] * 60
        assert car_s > 0
        ratio = d["truck_duration_s"] / car_s
        assert 0.9 <= ratio <= 1.6, f"urban ratio={ratio}"
