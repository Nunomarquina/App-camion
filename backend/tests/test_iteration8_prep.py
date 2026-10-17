"""Prep tacho so driver@test.com has ~25 min continuous driving left,
and cleanup after the UI test."""
import os
import sys
from datetime import datetime, timezone, timedelta
import requests

BASE = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://big-rig-maps-1.preview.emergentagent.com").rstrip("/")


def _login():
    r = requests.post(f"{BASE}/api/auth/login", json={"email": "driver@test.com", "password": "test1234"})
    r.raise_for_status()
    return r.json()["access_token"]


def _hdr(tok):
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"}


def _delete_recent(tok, hours=6):
    """Delete every event in the last N hours (test user only)."""
    r = requests.get(f"{BASE}/api/tacho/events", headers=_hdr(tok))
    r.raise_for_status()
    body = r.json()
    events = body if isinstance(body, list) else body.get("events", [])
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    for ev in events:
        s = ev.get("started_at")
        if not s:
            continue
        try:
            sdt = datetime.fromisoformat(s.replace("Z", "+00:00"))
            if sdt.tzinfo is None:
                sdt = sdt.replace(tzinfo=timezone.utc)
        except Exception:
            continue
        if sdt >= cutoff:
            did = ev.get("id") or ev.get("_id")
            if did:
                dr = requests.delete(f"{BASE}/api/tacho/events/{did}", headers=_hdr(tok))
                print("delete", did, dr.status_code)


def prep():
    tok = _login()
    now = datetime.now(timezone.utc)
    started = now - timedelta(hours=4, minutes=5)
    ended = now - timedelta(minutes=1)
    # First attempt
    payload = {
        "state": "DRIVING",
        "started_at": started.isoformat().replace("+00:00", "Z"),
        "ended_at": ended.isoformat().replace("+00:00", "Z"),
    }
    r = requests.post(f"{BASE}/api/tacho/events/manual", headers=_hdr(tok), json=payload)
    print("manual1", r.status_code, r.text[:200])
    if r.status_code == 409:
        _delete_recent(tok, hours=24 * 90)
        r = requests.post(f"{BASE}/api/tacho/events/manual", headers=_hdr(tok), json=payload)
        print("manual2", r.status_code, r.text[:200])
    r.raise_for_status()

    # Now open an active DRIVING event (current state DRIVING, no ended_at)
    r2 = requests.post(
        f"{BASE}/api/tacho/events",
        headers=_hdr(tok),
        json={"state": "DRIVING", "source": "MANUAL", "confirmed": True},
    )
    print("live", r2.status_code, r2.text[:200])

    # Verify
    s = requests.get(f"{BASE}/api/tacho/status?tz_offset_min=0", headers=_hdr(tok))
    print("status", s.status_code, s.text[:300])


def cleanup():
    tok = _login()
    _delete_recent(tok, hours=24 * 365)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "cleanup":
        cleanup()
    else:
        prep()
