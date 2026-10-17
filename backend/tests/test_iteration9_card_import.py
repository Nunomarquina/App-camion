"""Iteration 9: Real driver-card .DDD import tests.

Covers:
- POST /api/tacho/card-import (happy path, Gen1 wrap)
- Invalid files: random, VU download (0x76), empty, too-big, no auth
- Idempotency: re-importing same file does not duplicate card_activities
- GET /api/tacho/card-imports/last
- Regression: POST /api/tacho/card-sim still works
- Unit: ddd_parser.parse_driver_card (gen1, gen2, no-wrap, card-not-inserted)
"""
import os
import sys
import io
from datetime import datetime, timezone

import pytest
import requests

sys.path.insert(0, "/app/backend")
sys.path.insert(0, "/app/backend/tests")

from ddd_parser import parse_driver_card, DDDError  # noqa: E402
from ddd_fixture import build_ddd, sample_days  # noqa: E402

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL") or "https://big-rig-maps-1.preview.emergentagent.com"
BASE_URL = BASE_URL.rstrip("/")

EMAIL = "driver@test.com"
PASSWORD = "test1234"


# ---------- fixtures ----------
@pytest.fixture(scope="module")
def token():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": EMAIL, "password": PASSWORD}, timeout=20)
    assert r.status_code == 200, f"Login failed: {r.status_code} {r.text}"
    j = r.json()
    return j.get("access_token") or j.get("token")


@pytest.fixture(scope="module")
def auth_headers(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def ddd_bytes():
    now = datetime.now(timezone.utc)
    return build_ddd(sample_days(now, n=3), gen=1, wrap=True)


# ---------- unit tests on parser ----------
class TestDddParser:
    def test_parse_gen1_wrap(self):
        now = datetime.now(timezone.utc)
        raw = build_ddd(sample_days(now, n=3), gen=1, wrap=True)
        res = parse_driver_card(raw, now=now)
        assert res["card_number"] == "E123456789012300"
        assert res["holder_surname"] == "GARCIA LOPEZ"
        assert res["holder_first_names"] == "JUAN"
        assert res["generation"] == 1
        assert res["days"] == 3
        # Driving: 2 x (4h + 3h) per day = 7h/day, 3 days = 21h = 75600s
        assert res["driving_s"] == 75600
        # Activities order ascending
        acts = res["activities"]
        assert len(acts) > 0
        for i in range(1, len(acts)):
            assert acts[i]["start"] >= acts[i - 1]["start"]

    def test_parse_gen2_nowrap(self):
        now = datetime.now(timezone.utc)
        raw = build_ddd(sample_days(now, n=2), gen=2, wrap=False)
        res = parse_driver_card(raw, now=now)
        assert res["generation"] == 2
        assert res["days"] == 2

    def test_parse_card_not_inserted_skipped(self):
        now = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        from datetime import timedelta
        day = now - timedelta(days=1)
        # First change is not_inserted=1 -> that segment must be skipped
        days = [(day, [(0, 0, 1), (120, 3, 0), (240, 0, 0)])]
        raw = build_ddd(days, gen=1, wrap=False)
        res = parse_driver_card(raw, now=now)
        # Only the DRIVING segment (120->240) survives
        states = [a["state"] for a in res["activities"]]
        assert "DRIVING" in states
        # The leading REST segment should NOT be present because card wasn't inserted
        first = res["activities"][0]
        assert first["state"] == "DRIVING"

    def test_parse_empty_raises(self):
        with pytest.raises(DDDError):
            parse_driver_card(b"\x00" * 10)

    def test_parse_vu_download_raises(self):
        with pytest.raises(DDDError) as e:
            parse_driver_card(b"\x76" + b"\x00" * 100)
        assert "tacógrafo del vehículo" in str(e.value)


# ---------- backend API tests ----------
class TestCardImportAPI:
    def test_no_auth_rejected(self, ddd_bytes):
        r = requests.post(
            f"{BASE_URL}/api/tacho/card-import",
            files={"file": ("test.ddd", ddd_bytes, "application/octet-stream")},
            timeout=30,
        )
        assert r.status_code in (401, 403), f"Expected 401/403, got {r.status_code}"

    def test_import_happy_path(self, auth_headers, ddd_bytes):
        r = requests.post(
            f"{BASE_URL}/api/tacho/card-import",
            headers=auth_headers,
            files={"file": ("test.ddd", ddd_bytes, "application/octet-stream")},
            timeout=60,
        )
        assert r.status_code == 200, f"Import failed: {r.status_code} {r.text}"
        data = r.json()
        assert "card" in data
        card = data["card"]
        assert card["card_number"] == "E123456789012300"
        assert card["holder_name"] == "JUAN GARCIA LOPEZ"
        assert card["days"] == 3
        assert card["activities"] > 0
        assert card["driving_s"] == 75600
        assert card["period_start"] and card["period_end"]
        assert "report" in data
        assert data["report"]["card_is_real"] is True
        assert "message" in data

    def test_last_import(self, auth_headers, ddd_bytes):
        # ensure we have at least one import
        requests.post(
            f"{BASE_URL}/api/tacho/card-import",
            headers=auth_headers,
            files={"file": ("test.ddd", ddd_bytes, "application/octet-stream")},
            timeout=60,
        )
        r = requests.get(f"{BASE_URL}/api/tacho/card-imports/last", headers=auth_headers, timeout=20)
        assert r.status_code == 200, r.text
        doc = r.json()
        assert doc is not None
        assert doc["card_number"] == "E123456789012300"
        assert doc["holder_name"] == "JUAN GARCIA LOPEZ"
        assert doc["days"] == 3

    def test_reimport_does_not_duplicate(self, auth_headers, ddd_bytes):
        # first import (replaces whatever was there)
        requests.post(
            f"{BASE_URL}/api/tacho/card-import",
            headers=auth_headers,
            files={"file": ("test.ddd", ddd_bytes, "application/octet-stream")},
            timeout=60,
        )
        a = requests.get(f"{BASE_URL}/api/tacho/card-activities", headers=auth_headers, timeout=20)
        assert a.status_code == 200
        count_before = len(a.json())
        # re-import same file -> should REPLACE, not duplicate
        requests.post(
            f"{BASE_URL}/api/tacho/card-import",
            headers=auth_headers,
            files={"file": ("test.ddd", ddd_bytes, "application/octet-stream")},
            timeout=60,
        )
        b = requests.get(f"{BASE_URL}/api/tacho/card-activities", headers=auth_headers, timeout=20)
        count_after = len(b.json())
        assert count_after == count_before, f"Activities duplicated: {count_before} -> {count_after}"

    def test_invalid_random_bytes(self, auth_headers):
        # 200 random-ish bytes that don't form valid blocks
        bad = bytes(range(200))
        r = requests.post(
            f"{BASE_URL}/api/tacho/card-import",
            headers=auth_headers,
            files={"file": ("bad.ddd", bad, "application/octet-stream")},
            timeout=30,
        )
        assert r.status_code == 400, f"Expected 400, got {r.status_code}: {r.text}"
        detail = r.json().get("detail", "")
        assert detail  # Spanish message

    def test_vu_download_rejected(self, auth_headers):
        vu = b"\x76" + b"\x00" * 200
        r = requests.post(
            f"{BASE_URL}/api/tacho/card-import",
            headers=auth_headers,
            files={"file": ("vu.ddd", vu, "application/octet-stream")},
            timeout=30,
        )
        assert r.status_code == 400
        assert "tacógrafo del vehículo" in r.json().get("detail", "")

    def test_too_small_rejected(self, auth_headers):
        r = requests.post(
            f"{BASE_URL}/api/tacho/card-import",
            headers=auth_headers,
            files={"file": ("tiny.ddd", b"\x00" * 10, "application/octet-stream")},
            timeout=30,
        )
        assert r.status_code == 400
        assert "vacío o incompleto" in r.json().get("detail", "")

    def test_too_big_rejected(self, auth_headers):
        huge = b"\x00" * (2 * 1024 * 1024 + 100)
        r = requests.post(
            f"{BASE_URL}/api/tacho/card-import",
            headers=auth_headers,
            files={"file": ("huge.ddd", huge, "application/octet-stream")},
            timeout=60,
        )
        assert r.status_code == 400
        assert "demasiado grande" in r.json().get("detail", "")


# ---------- regression: card-sim still works ----------
class TestCardSimRegression:
    def test_card_sim_still_works(self, auth_headers):
        r = requests.post(
            f"{BASE_URL}/api/tacho/card-sim",
            headers=auth_headers,
            json={"card_id": "SIM-TEST9"},
            timeout=30,
        )
        assert r.status_code == 200, f"card-sim failed: {r.status_code} {r.text}"
        data = r.json()
        assert "report" in data
        assert "card_id" in data
        assert data["card_id"] == "SIM-TEST9"
        assert "message" in data
