"""Iteration 2 backend tests:
- /api/geocode (Mapbox forward geocoding)
- /api/routes/calculate (real Mapbox truck routing)
- /api/tacho/events/manual CRUD + overlap/future/invalid-range
- /api/tacho/status EU 561/2006 rules (split break, extensions, break-in-progress,
  daily/weekly rest deadlines, alerts/violations)
"""
import os
import uuid
import pytest
import requests
from datetime import datetime, timedelta, timezone

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://big-rig-maps-1.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


def _fresh_user_session():
    """Register a brand-new user and return an authenticated requests session."""
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    email = f"it2_{uuid.uuid4().hex[:10]}@test.com"
    r = s.post(f"{API}/auth/register", json={"email": email, "password": "test1234", "name": "IT2"})
    assert r.status_code == 201, r.text
    s.headers.update({"Authorization": f"Bearer {r.json()['access_token']}"})
    return s, email


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


# ============ GEOCODE ============
class TestGeocode:
    def test_geocode_requires_auth(self):
        r = requests.get(f"{API}/geocode", params={"q": "Zaragoza"})
        assert r.status_code == 401

    def test_geocode_zaragoza(self):
        s, _ = _fresh_user_session()
        r = s.get(f"{API}/geocode", params={"q": "Zaragoza"})
        assert r.status_code == 200, r.text
        results = r.json().get("results", [])
        assert len(results) > 0
        first = results[0]
        for key in ("name", "full_address", "lat", "lng"):
            assert key in first, f"missing {key}"
        assert isinstance(first["lat"], (int, float))
        assert isinstance(first["lng"], (int, float))
        # Zaragoza is around 41.6N, -0.9E
        hit = any("zaragoza" in (r.get("name") or "").lower() or "zaragoza" in (r.get("full_address") or "").lower()
                  for r in results)
        assert hit, f"expected Zaragoza in results, got {results}"

    def test_geocode_short_query_400(self):
        s, _ = _fresh_user_session()
        r = s.get(f"{API}/geocode", params={"q": "a"})
        assert r.status_code == 400


# ============ ROUTES ============
class TestRoutesCalculate:
    def test_madrid_barcelona_no_vehicle(self):
        s, _ = _fresh_user_session()
        r = s.post(f"{API}/routes/calculate", json={
            "origin": {"lat": 40.4168, "lng": -3.7038},
            "destination": {"lat": 41.3851, "lng": 2.1734},
            "tz_offset_min": 60,
        })
        assert r.status_code == 200, r.text
        d = r.json()
        # distance & times
        assert 450 < d["distance_km"] < 800, d["distance_km"]
        assert d["duration_min"] > 0
        assert d["truck_adjusted_duration_min"] >= d["duration_min"]
        # polyline has many points & is [lat,lng]
        assert len(d["polyline"]) > 50
        p0 = d["polyline"][0]
        assert len(p0) == 2 and 35 < p0[0] < 45 and -5 < p0[1] < 5
        # steps include spanish instructions
        assert len(d["steps"]) > 5
        assert any(st.get("instruction") for st in d["steps"])
        # plan computed
        plan = d["plan"]
        for k in ("breaks_45min", "daily_rests", "stop_time_s", "total_with_stops_s", "fits_remaining_today"):
            assert k in plan
        # ~620km of real driving => needs >=1 break
        assert plan["breaks_45min"] >= 1
        assert d["vehicle_applied"] is False
        assert any("Sin veh" in w or "sin veh" in w.lower() for w in d["warnings"])

    def test_with_active_vehicle_adds_dimension_warning(self):
        s, _ = _fresh_user_session()
        v = s.post(f"{API}/vehicles", json={
            "name": "TEST_RouteTruck", "vehicle_type": "tanker",
            "length_m": 18.0, "width_m": 2.6, "height_m": 4.2, "weight_t": 40, "axles": 5,
            "max_speed_kmh": 80, "hazmat": True,
        }).json()
        r = s.post(f"{API}/routes/calculate", json={
            "origin": {"lat": 40.4168, "lng": -3.7038},
            "destination": {"lat": 41.3851, "lng": 2.1734},
            "vehicle_id": v["id"],
        })
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["vehicle_applied"] is True
        # warning mentions dimensions
        joined = " ".join(d["warnings"]).lower()
        assert "4.2m" in joined or "4.2" in joined
        assert "2.6" in joined or "2.55" in joined
        # hazmat / oversize warnings
        assert any("ADR" in w or "hazmat" in w.lower() for w in d["warnings"])
        assert any("16.5" in w for w in d["warnings"])  # length

    def test_requires_auth(self):
        r = requests.post(f"{API}/routes/calculate", json={
            "origin": {"lat": 40.4, "lng": -3.7}, "destination": {"lat": 41.4, "lng": 2.17}
        })
        assert r.status_code == 401


# ============ MANUAL ENTRIES ============
class TestManualEntries:
    def test_create_closed_past_entry(self):
        s, _ = _fresh_user_session()
        end = datetime.now(timezone.utc) - timedelta(hours=1)
        start = end - timedelta(hours=2)
        r = s.post(f"{API}/tacho/events/manual", json={
            "state": "DRIVING", "started_at": _iso(start), "ended_at": _iso(end)
        })
        assert r.status_code == 201, r.text
        d = r.json()
        assert d["state"] == "DRIVING"
        assert d["source"] == "MANUAL"
        assert d["duration_s"] == 7200
        assert d["ended_at"] is not None

    def test_overlap_409(self):
        s, _ = _fresh_user_session()
        end = datetime.now(timezone.utc) - timedelta(hours=1)
        start = end - timedelta(hours=2)
        r1 = s.post(f"{API}/tacho/events/manual", json={
            "state": "DRIVING", "started_at": _iso(start), "ended_at": _iso(end)
        })
        assert r1.status_code == 201
        # overlapping (half-inside)
        r2 = s.post(f"{API}/tacho/events/manual", json={
            "state": "REST",
            "started_at": _iso(start + timedelta(minutes=30)),
            "ended_at": _iso(end + timedelta(minutes=30)),
        })
        assert r2.status_code == 409

    def test_future_400(self):
        s, _ = _fresh_user_session()
        start = datetime.now(timezone.utc) + timedelta(hours=1)
        end = start + timedelta(hours=1)
        r = s.post(f"{API}/tacho/events/manual", json={
            "state": "REST", "started_at": _iso(start), "ended_at": _iso(end)
        })
        assert r.status_code == 400

    def test_end_before_start_400(self):
        s, _ = _fresh_user_session()
        end = datetime.now(timezone.utc) - timedelta(hours=2)
        start = end + timedelta(hours=1)
        r = s.post(f"{API}/tacho/events/manual", json={
            "state": "REST", "started_at": _iso(start), "ended_at": _iso(end)
        })
        assert r.status_code == 400

    def test_delete_event(self):
        s, _ = _fresh_user_session()
        end = datetime.now(timezone.utc) - timedelta(hours=1)
        start = end - timedelta(hours=1)
        r = s.post(f"{API}/tacho/events/manual", json={
            "state": "REST", "started_at": _iso(start), "ended_at": _iso(end)
        })
        eid = r.json()["id"]
        r2 = s.delete(f"{API}/tacho/events/{eid}")
        assert r2.status_code == 204
        evts = s.get(f"{API}/tacho/events").json()
        assert all(e["id"] != eid for e in evts)


# ============ EU RULES (compute_status via /tacho/status) ============
def _push_sequence(s, segments):
    """segments: list of (state, duration_min). Written contiguously ending now-1min."""
    now = datetime.now(timezone.utc) - timedelta(minutes=1)
    cursor = now
    # Build backwards then insert in order
    entries = []
    for state, mins in reversed(segments):
        start = cursor - timedelta(minutes=mins)
        entries.append((state, start, cursor))
        cursor = start
    for state, start, end in reversed(entries):
        r = s.post(f"{API}/tacho/events/manual", json={
            "state": state, "started_at": _iso(start), "ended_at": _iso(end)
        })
        assert r.status_code == 201, (state, r.text)


class TestStatusEURules:
    def test_split_break_valid_resets(self):
        """drive 2h, REST 15m, drive 2h, REST 30m => continuous resets to 0."""
        s, _ = _fresh_user_session()
        _push_sequence(s, [("DRIVING", 120), ("REST", 15), ("DRIVING", 120), ("REST", 30)])
        d = s.get(f"{API}/tacho/status", params={"tz_offset_min": 120}).json()
        assert d["continuous_driving_s"] == 0, d
        assert d["split_break_first_done"] is False
        assert d["daily_limit_s"] == 9 * 3600
        assert d["in_extension"] is False

    def test_wrong_order_split_does_not_reset(self):
        """drive 2h, REST 30m, drive 1.5h, REST 15m, drive 0.5h => continuous NOT reset (4h), split_first True."""
        s, _ = _fresh_user_session()
        _push_sequence(s, [
            ("DRIVING", 120), ("REST", 30), ("DRIVING", 90), ("REST", 15), ("DRIVING", 30)
        ])
        d = s.get(f"{API}/tacho/status", params={"tz_offset_min": 120}).json()
        # continuous should include the 0.5h after wrong-order 30 (doesn't reset without prior 15)
        # Actually after REST 30 alone it may count as full break if dur>=45? no 30<45 and split_first was false
        # => 30 does nothing. then drive 1.5h continuous = 2+1.5=3.5h, REST 15 marks split_first.
        # then drive 0.5h continuous = 4h. Not reset.
        assert d["continuous_driving_s"] >= int(3.9 * 3600), d
        assert d["split_break_first_done"] is True

    def test_full_45_rest_resets(self):
        s, _ = _fresh_user_session()
        _push_sequence(s, [("DRIVING", 180), ("REST", 45)])
        d = s.get(f"{API}/tacho/status", params={"tz_offset_min": 120}).json()
        assert d["continuous_driving_s"] == 0
        assert d["current_state"] == "REST"

    def test_extension_over_9h(self):
        """drive >9h in a day => in_extension true & daily_limit=10h."""
        s, _ = _fresh_user_session()
        # 4h drive + 45m rest + 4h drive + 45m rest + 1.5h drive = 9.5h (needs resets to be legal)
        _push_sequence(s, [
            ("DRIVING", 240), ("REST", 45), ("DRIVING", 240), ("REST", 45), ("DRIVING", 90)
        ])
        d = s.get(f"{API}/tacho/status", params={"tz_offset_min": 120}).json()
        assert d["in_extension"] is True, d
        assert d["daily_limit_s"] == 10 * 3600
        assert d["extensions_used_week"] >= 1

    def test_continuous_violation(self):
        """Drive 5h straight => alert + violation."""
        s, _ = _fresh_user_session()
        _push_sequence(s, [("DRIVING", 300)])
        d = s.get(f"{API}/tacho/status", params={"tz_offset_min": 120}).json()
        assert d["violation"] is True
        assert d["continuous_driving_s"] >= int(4.5 * 3600)
        assert any(a["level"] == "error" for a in d["alerts"])

    def test_deadlines_present(self):
        s, _ = _fresh_user_session()
        _push_sequence(s, [("DRIVING", 60)])
        d = s.get(f"{API}/tacho/status", params={"tz_offset_min": 120}).json()
        assert "daily_rest_start_by_s" in d and d["daily_rest_start_by_s"] is not None
        assert "weekly_rest_due_s" in d and d["weekly_rest_due_s"] is not None
        assert "alerts" in d and isinstance(d["alerts"], list)

    def test_break_in_progress_30_target_after_15(self):
        """After drive + 15m rest (split first) + drive, start open REST => target 1800."""
        s, _ = _fresh_user_session()
        _push_sequence(s, [("DRIVING", 60), ("REST", 15), ("DRIVING", 60)])
        # Open live REST event (current)
        r = s.post(f"{API}/tacho/events", json={"state": "REST", "source": "MANUAL"})
        assert r.status_code == 200
        d = s.get(f"{API}/tacho/status", params={"tz_offset_min": 120}).json()
        bip = d.get("break_in_progress")
        assert bip is not None, d
        assert bip["target_s"] == 1800, bip
        assert bip["is_second_part"] is True

    def test_break_in_progress_45_target_fresh(self):
        s, _ = _fresh_user_session()
        _push_sequence(s, [("DRIVING", 60)])
        r = s.post(f"{API}/tacho/events", json={"state": "REST", "source": "MANUAL"})
        assert r.status_code == 200
        d = s.get(f"{API}/tacho/status", params={"tz_offset_min": 120}).json()
        bip = d.get("break_in_progress")
        assert bip is not None, d
        assert bip["target_s"] == 2700
        assert bip["is_second_part"] is False
