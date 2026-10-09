import os
import uuid
import time
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://big-rig-maps-1.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="session")
def client():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# unique email per run to avoid collisions
UNIQUE_EMAIL = f"test_user_{uuid.uuid4().hex[:8]}@test.com"
PASSWORD = "test1234"


@pytest.fixture(scope="session")
def auth(client):
    # Register a brand new user (fresh user has no vehicles/events)
    r = client.post(f"{API}/auth/register", json={
        "email": UNIQUE_EMAIL,
        "password": PASSWORD,
        "name": "Tester",
    })
    assert r.status_code == 201, r.text
    data = r.json()
    assert "access_token" in data and data["user"]["email"] == UNIQUE_EMAIL
    token = data["access_token"]
    client.headers.update({"Authorization": f"Bearer {token}"})
    return {"token": token, "user": data["user"]}


# ---------------- AUTH ----------------
class TestAuth:
    def test_root(self, client):
        r = client.get(f"{API}/")
        assert r.status_code == 200 and r.json()["status"] == "ok"

    def test_me_requires_auth(self):
        r = requests.get(f"{API}/auth/me")
        assert r.status_code == 401

    def test_me_bad_token(self):
        r = requests.get(f"{API}/auth/me", headers={"Authorization": "Bearer xxx"})
        assert r.status_code == 401

    def test_register_duplicate(self, client, auth):
        r = client.post(f"{API}/auth/register", json={
            "email": UNIQUE_EMAIL, "password": PASSWORD, "name": "Dup"
        })
        assert r.status_code == 409

    def test_login_success(self, auth):
        r = requests.post(f"{API}/auth/login", json={
            "email": UNIQUE_EMAIL, "password": PASSWORD
        })
        assert r.status_code == 200
        assert "access_token" in r.json()

    def test_login_bad_password(self):
        r = requests.post(f"{API}/auth/login", json={
            "email": UNIQUE_EMAIL, "password": "wrong!"
        })
        assert r.status_code == 401

    def test_me_authenticated(self, client, auth):
        r = client.get(f"{API}/auth/me")
        assert r.status_code == 200
        assert r.json()["email"] == UNIQUE_EMAIL


# ---------------- VEHICLES ----------------
class TestVehicles:
    created_ids = []

    def test_initial_list_empty(self, client, auth):
        r = client.get(f"{API}/vehicles")
        assert r.status_code == 200
        assert r.json() == []

    def test_create_first_auto_active(self, client, auth):
        r = client.post(f"{API}/vehicles", json={
            "name": "TEST_Truck1", "plate": "AB-123-CD", "vehicle_type": "truck",
            "length_m": 16.5, "width_m": 2.5, "height_m": 4.0, "weight_t": 40, "axles": 5,
            "max_speed_kmh": 90, "hazmat": False
        })
        assert r.status_code == 201, r.text
        d = r.json()
        assert d["is_active"] is True
        assert d["name"] == "TEST_Truck1"
        TestVehicles.created_ids.append(d["id"])

    def test_create_second_not_active(self, client, auth):
        r = client.post(f"{API}/vehicles", json={
            "name": "TEST_Bus1", "vehicle_type": "bus",
            "length_m": 12.0, "width_m": 2.55, "height_m": 3.8, "weight_t": 18, "axles": 2,
            "max_speed_kmh": 100, "hazmat": False
        })
        assert r.status_code == 201
        d = r.json()
        assert d["is_active"] is False
        TestVehicles.created_ids.append(d["id"])

    def test_validation_range(self, client, auth):
        # weight 999 > 80 should fail
        r = client.post(f"{API}/vehicles", json={
            "name": "TEST_Bad", "vehicle_type": "truck",
            "length_m": 16.5, "width_m": 2.5, "height_m": 4.0, "weight_t": 999, "axles": 5,
            "max_speed_kmh": 90
        })
        assert r.status_code == 422

    def test_activate_second(self, client, auth):
        vid = TestVehicles.created_ids[1]
        r = client.post(f"{API}/vehicles/{vid}/activate")
        assert r.status_code == 200
        assert r.json()["is_active"] is True
        # list -- only one active
        r2 = client.get(f"{API}/vehicles")
        actives = [v for v in r2.json() if v["is_active"]]
        assert len(actives) == 1 and actives[0]["id"] == vid

    def test_update(self, client, auth):
        vid = TestVehicles.created_ids[0]
        r = client.put(f"{API}/vehicles/{vid}", json={
            "name": "TEST_Truck1_updated", "vehicle_type": "tanker",
            "length_m": 18.0, "width_m": 2.55, "height_m": 4.2, "weight_t": 42, "axles": 5,
            "max_speed_kmh": 80, "hazmat": True
        })
        assert r.status_code == 200
        d = r.json()
        assert d["name"] == "TEST_Truck1_updated" and d["hazmat"] is True

    def test_delete(self, client, auth):
        vid = TestVehicles.created_ids[0]
        r = client.delete(f"{API}/vehicles/{vid}")
        assert r.status_code == 204
        # verify GET list no longer has it
        r2 = client.get(f"{API}/vehicles")
        ids = [v["id"] for v in r2.json()]
        assert vid not in ids


# ---------------- TACHO ----------------
class TestTacho:
    def test_initial_status_rest(self, client, auth):
        r = client.get(f"{API}/tacho/status")
        assert r.status_code == 200
        d = r.json()
        assert d["current_state"] == "REST"
        assert d["remaining_continuous_driving_s"] == int(4.5 * 3600)

    def test_push_manual_event(self, client, auth):
        r = client.post(f"{API}/tacho/events", json={
            "state": "DRIVING", "source": "MANUAL", "confirmed": True
        })
        assert r.status_code == 200
        d = r.json()
        assert d["state"] == "DRIVING" and d["confirmed"] is True
        # verify in status
        s = client.get(f"{API}/tacho/status").json()
        assert s["current_state"] == "DRIVING"

    def test_list_events(self, client, auth):
        r = client.get(f"{API}/tacho/events")
        assert r.status_code == 200
        assert len(r.json()) >= 1

    def test_gps_sample_driving_creates_event(self, client, auth):
        # First force state to REST
        client.post(f"{API}/tacho/events", json={"state": "REST", "source": "MANUAL"})
        count_before = len(client.get(f"{API}/tacho/events").json())
        # speed > 5 => DRIVING unconfirmed
        r = client.post(f"{API}/tacho/gps-sample", json={"lat": 40.4, "lng": -3.7, "speed_kmh": 60})
        assert r.status_code == 200
        assert r.json()["current_state"] == "DRIVING"
        evts = client.get(f"{API}/tacho/events").json()
        assert len(evts) == count_before + 1
        latest = evts[0]
        assert latest["source"] == "GPS_AUTO" and latest["confirmed"] is False

    def test_gps_sample_no_change_no_event(self, client, auth):
        # Current is DRIVING; send another DRIVING sample -> no new event
        count_before = len(client.get(f"{API}/tacho/events").json())
        r = client.post(f"{API}/tacho/gps-sample", json={"lat": 40.5, "lng": -3.6, "speed_kmh": 70})
        assert r.status_code == 200
        count_after = len(client.get(f"{API}/tacho/events").json())
        assert count_after == count_before

    def test_confirm_event_with_correction(self, client, auth):
        evts = client.get(f"{API}/tacho/events").json()
        # Find latest unconfirmed GPS event (which should be DRIVING)
        target = next((e for e in evts if not e["confirmed"]), None)
        assert target is not None, "expected an unconfirmed event from previous GPS test"
        r = client.post(f"{API}/tacho/events/{target['id']}/confirm", json={"state": "WORK"})
        assert r.status_code == 200
        d = r.json()
        assert d["confirmed"] is True and d["state"] == "WORK"

    def test_card_sim_confirms(self, client, auth):
        # Create a fresh unconfirmed event via GPS to rest (state change)
        client.post(f"{API}/tacho/events", json={"state": "DRIVING", "source": "MANUAL"})
        r_gps = client.post(f"{API}/tacho/gps-sample", json={"lat": 40.4, "lng": -3.7, "speed_kmh": 0})
        assert r_gps.status_code == 200
        # Should have at least one unconfirmed
        before = client.get(f"{API}/tacho/events").json()
        unconfirmed_before = [e for e in before if not e["confirmed"]]
        assert len(unconfirmed_before) >= 1
        r = client.post(f"{API}/tacho/card-sim", json={"card_id": "ES-12345"})
        assert r.status_code == 200
        d = r.json()
        assert d["confirmed_events"] >= 1
        after = client.get(f"{API}/tacho/events").json()
        assert all(e["confirmed"] for e in after)


# ---------------- ROUTES ----------------
class TestRoutes:
    def test_calculate_requires_auth(self):
        r = requests.post(f"{API}/routes/calculate", json={
            "origin": {"lat": 40.4, "lng": -3.7}, "destination": {"lat": 41.4, "lng": 2.17}
        })
        assert r.status_code == 401

    def test_calculate_basic(self, client, auth):
        # ensure there's an active vehicle (second created above; first deleted). But hazmat was on the deleted one.
        # Add a fresh active vehicle with hazmat + height/weight to produce warnings.
        v = client.post(f"{API}/vehicles", json={
            "name": "TEST_RouteTruck", "vehicle_type": "tanker",
            "length_m": 18.0, "width_m": 2.6, "height_m": 4.2, "weight_t": 40, "axles": 5,
            "max_speed_kmh": 80, "hazmat": True
        }).json()
        client.post(f"{API}/vehicles/{v['id']}/activate")
        # Madrid -> Barcelona approx
        r = client.post(f"{API}/routes/calculate", json={
            "origin": {"lat": 40.4168, "lng": -3.7038},
            "destination": {"lat": 41.3851, "lng": 2.1734},
        })
        assert r.status_code == 200
        d = r.json()
        assert 400 < d["distance_km"] < 800
        assert d["truck_adjusted_duration_min"] >= d["duration_min"]
        # Real Mapbox: vehicle_restricted is True only if route has violations;
        # hazmat alone just adds ADR warning. Assert ADR warning instead.
        assert d["vehicle_applied"] is True
        assert any("ADR" in w for w in d["warnings"])  # hazmat
        assert len(d["steps"]) > 3
        assert len(d["polyline"]) > 50
        assert "plan" in d
