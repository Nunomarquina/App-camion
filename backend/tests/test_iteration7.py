"""Iteration 7 backend tests - TTS, trips lifecycle, pace learning, same-side rest areas."""
import os
import uuid
import pytest
import requests

def _load_backend_url():
    v = os.environ.get("EXPO_PUBLIC_BACKEND_URL") or os.environ.get("EXPO_BACKEND_URL")
    if v:
        return v.rstrip("/")
    from pathlib import Path
    env_path = Path(__file__).resolve().parents[2] / "frontend" / ".env"
    for line in env_path.read_text().splitlines():
        if line.startswith("EXPO_PUBLIC_BACKEND_URL=") or line.startswith("EXPO_BACKEND_URL="):
            return line.split("=", 1)[1].strip().rstrip("/")
    raise RuntimeError("Backend URL not configured")


BASE_URL = _load_backend_url()
API = f"{BASE_URL}/api"

EMAIL = "driver@test.com"
PASSWORD = "test1234"

MADRID = {"lat": 40.4168, "lng": -3.7038}
BARCELONA = {"lat": 41.3851, "lng": 2.1734}


@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{API}/auth/login", json={"email": EMAIL, "password": PASSWORD})
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    body = r.json()
    assert "access_token" in body and body.get("user", {}).get("email") == EMAIL
    return body["access_token"]


@pytest.fixture(scope="module")
def session(token):
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json",
                      "Authorization": f"Bearer {token}"})
    return s


# ================= AUTH =================
class TestAuth:
    def test_login_returns_bearer(self, token):
        assert isinstance(token, str) and len(token) > 20


# ================= TTS =================
class TestTTS:
    TEXT = "En 500 metros, gire a la derecha"

    def test_create_tts(self, session):
        r = session.post(f"{API}/tts", json={"text": self.TEXT})
        assert r.status_code == 200, r.text
        data = r.json()
        assert "key" in data and "url" in data
        assert data["url"].endswith(".mp3")
        TestTTS.key = data["key"]

    def test_get_tts_mp3(self, session):
        r = requests.get(f"{API}/tts/{TestTTS.key}.mp3")
        assert r.status_code == 200
        assert r.headers.get("content-type", "").startswith("audio/mpeg")
        assert len(r.content) > 100

    def test_tts_cached_same_key(self, session):
        r = session.post(f"{API}/tts", json={"text": self.TEXT})
        assert r.status_code == 200
        assert r.json()["key"] == TestTTS.key

    def test_tts_invalid_key_404(self):
        bad_key = "a" * 64
        r = requests.get(f"{API}/tts/{bad_key}.mp3")
        assert r.status_code == 404
        r2 = requests.get(f"{API}/tts/nothex.mp3")
        assert r2.status_code == 404

    def test_tts_empty_text_rejected(self, session):
        r = session.post(f"{API}/tts", json={"text": ""})
        assert r.status_code in (400, 422), f"got {r.status_code}: {r.text}"


# ================= TRIPS CRUD =================
def _trip_body(**overrides):
    body = {
        "origin": MADRID, "origin_name": "Madrid",
        "destination": BARCELONA, "destination_name": "Barcelona",
        "distance_km": 620.0, "estimate_s": 27000, "base_estimate_s": 27000,
        "weight_t": 40, "simulated": False,
    }
    body.update(overrides)
    return body


class TestTripsLifecycle:
    def test_create_trip(self, session):
        r = session.post(f"{API}/trips", json=_trip_body())
        assert r.status_code == 201, r.text
        t = r.json()
        assert t["status"] == "in_progress"
        assert t["id"]
        TestTripsLifecycle.id1 = t["id"]

    def test_finish_trip_sets_actual_from_gps(self, session):
        # driven_km >= 0.8 * distance -> actual_s = moving_s, source = gps
        r = session.post(f"{API}/trips/{TestTripsLifecycle.id1}/finish",
                         json={"moving_s": 26000, "elapsed_s": 28000,
                               "driven_km": 620.0, "arrived": True, "simulated": False})
        assert r.status_code == 200, r.text
        data = r.json()
        t = data["trip"]
        assert t["status"] == "arrived"
        assert t["actual_s"] == 26000
        assert t["actual_source"] == "gps"
        assert "pace" in data

    def test_simulated_finish_does_not_set_actual(self, session):
        c = session.post(f"{API}/trips", json=_trip_body(simulated=True)).json()
        r = session.post(f"{API}/trips/{c['id']}/finish",
                         json={"moving_s": 25000, "elapsed_s": 26000,
                               "driven_km": 620.0, "arrived": True, "simulated": False})
        assert r.status_code == 200
        t = r.json()["trip"]
        assert t["actual_s"] is None
        assert t["simulated"] is True
        session.delete(f"{API}/trips/{c['id']}")

    def test_patch_actual_manual(self, session):
        c = session.post(f"{API}/trips", json=_trip_body()).json()
        r = session.patch(f"{API}/trips/{c['id']}/actual", json={"actual_s": 15300})
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["trip"]["actual_s"] == 15300
        assert data["trip"]["actual_source"] == "manual"
        assert "pace" in data
        session.delete(f"{API}/trips/{c['id']}")

    def test_list_trips(self, session):
        r = session.get(f"{API}/trips")
        assert r.status_code == 200
        data = r.json()
        assert "trips" in data and "pace" in data
        assert "factor" in data["pace"] and "trips_used" in data["pace"]
        ids = [t["id"] for t in data["trips"]]
        assert TestTripsLifecycle.id1 in ids

    def test_delete_trip(self, session):
        r = session.delete(f"{API}/trips/{TestTripsLifecycle.id1}")
        assert r.status_code == 204
        # verify gone
        lst = session.get(f"{API}/trips").json()["trips"]
        assert TestTripsLifecycle.id1 not in [t["id"] for t in lst]

    def test_other_user_trip_404(self, session):
        # Register throwaway user, create trip, try to delete with main session
        email = f"TEST_{uuid.uuid4().hex[:8]}@test.com"
        reg = requests.post(f"{API}/auth/register",
                            json={"email": email, "password": "test1234", "name": "T"})
        assert reg.status_code in (200, 201)
        other_tok = reg.json()["access_token"]
        other_s = requests.Session()
        other_s.headers.update({"Content-Type": "application/json",
                                "Authorization": f"Bearer {other_tok}"})
        tc = other_s.post(f"{API}/trips", json=_trip_body()).json()
        # main user tries to delete
        r = session.delete(f"{API}/trips/{tc['id']}")
        assert r.status_code == 404
        r2 = session.post(f"{API}/trips/{tc['id']}/finish",
                          json={"moving_s": 1, "elapsed_s": 1, "driven_km": 0,
                                "arrived": False, "simulated": False})
        assert r2.status_code == 404
        # cleanup
        other_s.delete(f"{API}/trips/{tc['id']}")


# ================= PACE LEARNING =================
class TestPaceLearning:
    created_ids: list = []

    def test_pace_shifts_after_slow_trips(self, session):
        # Baseline
        base = session.post(f"{API}/routes/calculate", json={
            "origin": MADRID, "destination": BARCELONA,
            "weight_t": 40, "use_current_hours": False,
        })
        assert base.status_code == 200, base.text
        base_data = base.json()
        base_truck_s = base_data["base_truck_duration_s"]
        assert base_truck_s > 0

        # Create 3 valid trips that are consistently ~15% slower than base
        for i in range(3):
            c = session.post(f"{API}/trips", json={
                "origin": MADRID, "origin_name": "Madrid",
                "destination": BARCELONA, "destination_name": "Barcelona",
                "distance_km": 620.0,
                "estimate_s": base_truck_s, "base_estimate_s": base_truck_s,
                "weight_t": 40, "simulated": False,
            }).json()
            TestPaceLearning.created_ids.append(c["id"])
            # finish with moving_s = 1.15 * base (ratio 1.15, within 0.5-2.0, >=20km)
            session.post(f"{API}/trips/{c['id']}/finish", json={
                "moving_s": int(base_truck_s * 1.15),
                "elapsed_s": int(base_truck_s * 1.2),
                "driven_km": 620.0, "arrived": True, "simulated": False,
            })

        # Recalculate route — expect pace_factor > 1 (slower) but clamped to <= 1.4
        r = session.post(f"{API}/routes/calculate", json={
            "origin": MADRID, "destination": BARCELONA,
            "weight_t": 40, "use_current_hours": False,
        })
        assert r.status_code == 200
        d = r.json()
        assert d["pace_trips"] >= 3, d
        assert d["pace_factor"] != 1.0
        assert 0.7 <= d["pace_factor"] <= 1.4
        # Should have shrunk toward 1.0: with n=3, weight=3/5=0.6, median=1.15 -> factor=1+0.15*0.6=1.09
        assert 1.03 <= d["pace_factor"] <= 1.20, d["pace_factor"]
        # truck_duration_s ~= base * pace_factor
        expected = int(d["base_truck_duration_s"] * d["pace_factor"])
        assert abs(d["truck_duration_s"] - expected) <= 2

    def teardown_class(cls):
        s = requests.Session()
        r = s.post(f"{API}/auth/login", json={"email": EMAIL, "password": PASSWORD})
        s.headers.update({"Authorization": f"Bearer {r.json()['access_token']}"})
        for tid in cls.created_ids:
            s.delete(f"{API}/trips/{tid}")


# ================= SAME-SIDE REST AREAS =================
class TestRestAreasSameSide:
    def test_no_left_side_areas(self, session):
        r = session.post(f"{API}/routes/calculate", json={
            "origin": MADRID, "destination": BARCELONA,
            "weight_t": 40, "use_current_hours": False,
        })
        assert r.status_code == 200, r.text
        d = r.json()
        assert "stops" in d
        total_areas = 0
        for stop in d["stops"]:
            for area in stop.get("areas", []):
                total_areas += 1
                assert area["side"] in ("right", "unknown"), (
                    f"Area '{area['name']}' has side={area['side']}")
                # No opposite-direction (Zaragoza bound) names for a Madrid->BCN trip
                name_lower = (area.get("name") or "").lower()
                assert "sentido zaragoza" not in name_lower, area
        # Not asserting >0 — depends on Mapbox category coverage
        print(f"Total same-side areas found: {total_areas}")
