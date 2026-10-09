"""Iteration 3 backend tests:
- /api/tacho/gps-batch, /api/tacho/detection-profile
- /api/tacho/card-activities (store, overlap 409, future/invalid 400)
- /api/tacho/card-sim (simulated vs real card, learning threshold, corrections,
  verified, profile persistence, note semantics)
- /api/routes/calculate stops with rest areas (Mapbox) and use_current_hours
"""
import os
import uuid
import pytest
import requests
from datetime import datetime, timedelta, timezone

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://big-rig-maps-1.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


def _fresh():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    email = f"it3_{uuid.uuid4().hex[:10]}@test.com"
    r = s.post(f"{API}/auth/register", json={"email": email, "password": "test1234", "name": "IT3"})
    assert r.status_code == 201, r.text
    s.headers.update({"Authorization": f"Bearer {r.json()['access_token']}"})
    return s


def _iso(dt): return dt.astimezone(timezone.utc).isoformat()


# ============ DETECTION PROFILE ============
class TestDetectionProfile:
    def test_default_profile(self):
        s = _fresh()
        r = s.get(f"{API}/tacho/detection-profile")
        assert r.status_code == 200, r.text
        p = r.json()
        assert p["speed_threshold_kmh"] == 5
        assert p["hold_s"] == 30
        assert "accuracy" in p and "history" in p
        assert isinstance(p["history"], list)

    def test_gps_batch_stores(self):
        s = _fresh()
        samples = [{"lat": 40.4, "lng": -3.7, "speed_kmh": 70.0,
                    "ts": _iso(datetime.now(timezone.utc) - timedelta(minutes=i))}
                   for i in range(5)]
        r = s.post(f"{API}/tacho/gps-batch", json={"samples": samples})
        assert r.status_code == 200, r.text
        assert r.json()["stored"] == 5


# ============ CARD ACTIVITIES ============
class TestCardActivities:
    def test_create_and_list(self):
        s = _fresh()
        end = datetime.now(timezone.utc) - timedelta(hours=2)
        start = end - timedelta(hours=1)
        r = s.post(f"{API}/tacho/card-activities", json={"activities": [
            {"state": "DRIVING", "started_at": _iso(start), "ended_at": _iso(end)}
        ]})
        assert r.status_code == 201, r.text
        assert r.json()["stored"] == 1
        acts = s.get(f"{API}/tacho/card-activities").json()
        assert len(acts) == 1
        assert acts[0]["state"] == "DRIVING"

    def test_overlap_409(self):
        s = _fresh()
        end = datetime.now(timezone.utc) - timedelta(hours=1)
        start = end - timedelta(hours=1)
        s.post(f"{API}/tacho/card-activities", json={"activities": [
            {"state": "DRIVING", "started_at": _iso(start), "ended_at": _iso(end)}
        ]})
        r = s.post(f"{API}/tacho/card-activities", json={"activities": [
            {"state": "REST",
             "started_at": _iso(start + timedelta(minutes=15)),
             "ended_at": _iso(end + timedelta(minutes=15))}
        ]})
        assert r.status_code == 409, r.text

    def test_future_400(self):
        s = _fresh()
        start = datetime.now(timezone.utc) + timedelta(hours=1)
        end = start + timedelta(hours=1)
        r = s.post(f"{API}/tacho/card-activities", json={"activities": [
            {"state": "REST", "started_at": _iso(start), "ended_at": _iso(end)}
        ]})
        assert r.status_code == 400

    def test_end_le_start_400(self):
        s = _fresh()
        end = datetime.now(timezone.utc) - timedelta(hours=2)
        start = end + timedelta(hours=1)
        r = s.post(f"{API}/tacho/card-activities", json={"activities": [
            {"state": "REST", "started_at": _iso(start), "ended_at": _iso(end)}
        ]})
        assert r.status_code == 400


# ============ CARD SIM (SIMULATED) ============
class TestCardSimSimulated:
    def test_no_card_activities_simulated(self):
        s = _fresh()
        r = s.post(f"{API}/tacho/card-sim", json={"card_id": "SIM-123"})
        assert r.status_code == 200, r.text
        d = r.json()
        rep = d["report"]
        assert rep["card_is_real"] is False
        for k in ("accuracy", "false_switches", "avg_lag_s", "corrections",
                  "verified", "samples_used", "threshold_before",
                  "threshold_after", "hold_before", "hold_after", "tips"):
            assert k in rep, k
        prof = d["profile"]
        for k in ("speed_threshold_kmh", "hold_s", "accuracy", "history"):
            assert k in prof


# ============ CARD SIM (LEARNING) ============
class TestCardSimLearning:
    def test_threshold_adapts_and_persists(self):
        """Build fresh user with recent card activities + GPS samples inside
        them, then run card-sim; threshold should learn to ~7 km/h."""
        s = _fresh()
        now = datetime.now(timezone.utc)
        # Card DRIVING: last 30-15 min ago, REST: last 15-5 min ago
        drive_start = now - timedelta(minutes=30)
        drive_end = now - timedelta(minutes=15)
        rest_start = drive_end
        rest_end = now - timedelta(minutes=5)
        r = s.post(f"{API}/tacho/card-activities", json={"activities": [
            {"state": "DRIVING", "started_at": _iso(drive_start), "ended_at": _iso(drive_end)},
            {"state": "REST", "started_at": _iso(rest_start), "ended_at": _iso(rest_end)},
        ]})
        assert r.status_code == 201, r.text

        # 12 samples at 60 km/h inside the DRIVING interval
        drive_samples = [{"lat": 40.4, "lng": -3.7, "speed_kmh": 60.0,
                          "ts": _iso(drive_start + timedelta(minutes=1 + i))}
                         for i in range(12)]
        # 12 samples at 7 km/h inside the REST interval (walking) — below threshold target
        rest_samples = [{"lat": 40.4, "lng": -3.7, "speed_kmh": 7.0,
                         "ts": _iso(rest_start + timedelta(seconds=20 * (i + 1)))}
                        for i in range(12)]
        rb = s.post(f"{API}/tacho/gps-batch", json={"samples": drive_samples + rest_samples})
        assert rb.status_code == 200

        r = s.post(f"{API}/tacho/card-sim", json={"card_id": "REAL-1"})
        assert r.status_code == 200, r.text
        d = r.json()
        rep = d["report"]
        assert rep["card_is_real"] is True
        # Threshold should rise above 5 (default) so that 7km/h samples count as REST
        assert rep["threshold_after"] > rep["threshold_before"], rep
        assert rep["samples_used"] >= 20
        # Profile persists via detection-profile
        prof = s.get(f"{API}/tacho/detection-profile").json()
        assert prof["speed_threshold_kmh"] == rep["threshold_after"]

        # gps-sample at speed 6 should be REST when threshold learned >=7
        if prof["speed_threshold_kmh"] >= 7:
            r2 = s.post(f"{API}/tacho/gps-sample",
                        json={"lat": 40.4, "lng": -3.7, "speed_kmh": 6.0})
            assert r2.status_code == 200
            evs = s.get(f"{API}/tacho/events").json()
            latest = evs[0]
            assert latest["state"] == "REST", latest

    def test_correction_sets_card_verified_and_note(self):
        """GPS_AUTO event whose majority-overlap card state differs is corrected."""
        s = _fresh()
        import time
        # Create a GPS_AUTO DRIVING event by pushing a fast sample
        r = s.post(f"{API}/tacho/gps-sample",
                   json={"lat": 40.4, "lng": -3.7, "speed_kmh": 80.0})
        assert r.status_code == 200
        evs = s.get(f"{API}/tacho/events").json()
        gps_evt = next(e for e in evs if e.get("source") == "GPS_AUTO")
        evt_started = datetime.fromisoformat(gps_evt["started_at"].replace("Z", "+00:00"))
        # Wait so that 'now' > evt_started by a few seconds (card activity must
        # extend past the GPS_AUTO event start to produce an overlap window).
        time.sleep(3)

        # Add card activity REST that overlaps the GPS_AUTO (open) event
        card_start = evt_started - timedelta(minutes=5)
        card_end = datetime.now(timezone.utc)
        s.post(f"{API}/tacho/card-activities", json={"activities": [
            {"state": "REST", "started_at": _iso(card_start), "ended_at": _iso(card_end)}
        ]})

        r = s.post(f"{API}/tacho/card-sim", json={"card_id": "REAL-CORR"})
        assert r.status_code == 200, r.text
        rep = r.json()["report"]
        assert rep["card_is_real"] is True

        evs2 = s.get(f"{API}/tacho/events").json()
        updated = next(e for e in evs2 if e["id"] == gps_evt["id"])
        # State corrected to REST, detected_state kept as DRIVING, card_verified true
        assert updated["state"] == "REST", updated
        assert updated["detected_state"] == "DRIVING", updated
        assert updated["card_verified"] is True
        assert "Corregido por tarjeta" in (updated.get("note") or "")


# ============ ROUTES: STOPS + REST AREAS ============
class TestRouteStopsAndAreas:
    def test_madrid_barcelona_stops_with_areas(self):
        s = _fresh()
        r = s.post(f"{API}/routes/calculate", json={
            "origin": {"lat": 40.4168, "lng": -3.7038},
            "destination": {"lat": 41.3851, "lng": 2.1734},
            "use_current_hours": False,
        })
        assert r.status_code == 200, r.text
        d = r.json()
        # No internal fields leaked
        assert "_points" not in d and "_cum" not in d
        # Plan has at least one break
        plan = d["plan"]
        assert plan["breaks_45min"] >= 1
        # First break at ~4h30 since use_current_hours=False
        assert plan["stops"][0]["at_drive_s"] == 16200
        # Stops in response
        stops = d["stops"]
        assert isinstance(stops, list) and len(stops) >= 1
        s0 = stops[0]
        for k in ("at_drive_s", "lat", "lng", "km", "areas"):
            assert k in s0, k
        assert isinstance(s0["areas"], list)
        # Validate area shape and off_route constraint
        for a in s0["areas"]:
            for k in ("name", "type", "lat", "lng", "route_km", "minutes_before_limit", "off_route_km"):
                assert k in a, k
            assert a["off_route_km"] <= 1.5 + 1e-6
            assert 0 <= a["minutes_before_limit"] <= 40

    def test_zaragoza_barcelona_no_stops(self):
        s = _fresh()
        r = s.post(f"{API}/routes/calculate", json={
            "origin": {"lat": 41.6488, "lng": -0.8891},
            "destination": {"lat": 41.3851, "lng": 2.1734},
            "use_current_hours": False,
        })
        assert r.status_code == 200, r.text
        d = r.json()
        # ~300 km < 4h30 drive → no mandatory stop
        assert d["plan"]["breaks_45min"] == 0
        assert d["stops"] == [] or len(d["stops"]) == 0

    def test_use_current_hours_flag(self):
        s = _fresh()
        r = s.post(f"{API}/routes/calculate", json={
            "origin": {"lat": 40.4168, "lng": -3.7038},
            "destination": {"lat": 41.3851, "lng": 2.1734},
            "use_current_hours": True,
        })
        assert r.status_code == 200
        assert r.json()["used_current_hours"] is True
