"""Compare tachograph card activities with GPS auto-detections and learn
per-driver detection parameters (speed threshold + hold time)."""
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

DEFAULT_THRESHOLD = 5.0
DEFAULT_HOLD_S = 30
MIN_HOLD_S, MAX_HOLD_S = 15, 120
SHORT_EVENT_S = 10 * 60
MIN_SAMPLES_PER_CLASS = 10


def _utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def moving(state: str) -> bool:
    return state == "DRIVING"


def default_profile() -> Dict[str, Any]:
    return {
        "speed_threshold_kmh": DEFAULT_THRESHOLD,
        "hold_s": DEFAULT_HOLD_S,
        "accuracy": None,
        "avg_lag_s": None,
        "false_switches": 0,
        "samples_used": 0,
        "card_reads": 0,
        "last_card_read": None,
        "history": [],
    }


def _overlaps(a_s, a_e, acts):
    """Yield (activity, overlap_seconds) for card activities overlapping [a_s, a_e]."""
    for c in acts:
        lo, hi = max(a_s, c["start"]), min(a_e, c["end"])
        if hi > lo:
            yield c, (hi - lo).total_seconds()


def _learn_threshold(samples: List[Dict[str, Any]], acts: List[Dict[str, Any]], current: float):
    labeled = []
    for s in samples:
        ts = _utc(s["ts"])
        for c in acts:
            if c["start"] <= ts < c["end"]:
                labeled.append((s["speed_kmh"], moving(c["state"])))
                break
    n_move = sum(1 for _, m in labeled if m)
    n_stop = len(labeled) - n_move
    if n_move < MIN_SAMPLES_PER_CLASS or n_stop < MIN_SAMPLES_PER_CLASS:
        return current, len(labeled), None
    best_t, best_err = current, None
    t = 1.0
    while t <= 20.0:
        err = sum(1 for sp, m in labeled if (sp > t) != m)
        if best_err is None or err < best_err or (err == best_err and abs(t - current) < abs(best_t - current)):
            best_t, best_err = t, err
        t += 0.5
    sample_acc = 1 - best_err / len(labeled)
    return best_t, len(labeled), sample_acc


def analyze(gps_events: List[Dict[str, Any]], card_acts: List[Dict[str, Any]],
            samples: List[Dict[str, Any]], profile: Dict[str, Any], now: datetime,
            card_is_real: bool) -> Dict[str, Any]:
    """gps_events: tacho events with source GPS_AUTO.
    card_acts: [{state, start, end}] reference activities (UTC datetimes)."""
    matched_s = mismatched_s = 0.0
    false_switches = 0
    corrections: List[Dict[str, Any]] = []
    verified_ids: List[str] = []
    lags: List[float] = []
    compared = 0

    for e in gps_events:
        s = _utc(e["started_at"])
        en = _utc(e["ended_at"]) if e.get("ended_at") else now
        detected = e.get("detected_state") or e["state"]
        per_state: Dict[str, float] = {}
        ev_match = ev_mis = 0.0
        for c, ov in _overlaps(s, en, card_acts):
            per_state[c["state"]] = per_state.get(c["state"], 0) + ov
            if moving(c["state"]) == moving(detected):
                ev_match += ov
            else:
                ev_mis += ov
        if not per_state:
            continue
        compared += 1
        matched_s += ev_match
        mismatched_s += ev_mis
        dur = (en - s).total_seconds()
        if ev_mis > ev_match and dur < SHORT_EVENT_S:
            false_switches += 1
        majority = max(per_state.items(), key=lambda kv: kv[1])[0]
        if card_is_real and majority != e["state"]:
            corrections.append({"id": e["id"], "from": e["state"], "to": majority})
        else:
            verified_ids.append(e["id"])
        # Detection lag vs nearest card change to the same movement class
        if card_is_real:
            near = [c for c in card_acts
                    if moving(c["state"]) == moving(detected) and abs((s - c["start"]).total_seconds()) <= 600]
            if near:
                c = min(near, key=lambda c: abs((s - c["start"]).total_seconds()))
                lags.append((s - c["start"]).total_seconds())

    total = matched_s + mismatched_s
    accuracy = round(matched_s / total, 3) if total > 0 else None
    avg_lag = round(sum(lags) / len(lags), 1) if lags else None

    old_t = profile.get("speed_threshold_kmh", DEFAULT_THRESHOLD)
    old_h = profile.get("hold_s", DEFAULT_HOLD_S)
    new_t, samples_used, sample_acc = _learn_threshold(samples, card_acts, old_t)

    new_h = old_h
    if false_switches > 0:
        new_h = min(MAX_HOLD_S, int(old_h * 1.5))
    elif avg_lag is not None and avg_lag > old_h + 20:
        new_h = max(MIN_HOLD_S, int(old_h * 0.75))

    tips: List[str] = []
    if accuracy is None:
        tips.append("Sin detecciones GPS que comparar todavía. Activa la detección automática y conduce.")
    if false_switches:
        tips.append(f"{false_switches} cambios falsos cortos: se aumenta el tiempo de confirmación a {new_h}s.")
    if new_t != old_t:
        tips.append(f"Umbral de movimiento ajustado de {old_t:g} a {new_t:g} km/h según {samples_used} lecturas GPS.")
    elif samples_used and sample_acc is None:
        tips.append("Faltan lecturas GPS de conducción o de parada para ajustar el umbral.")
    if avg_lag is not None:
        tips.append(f"El GPS detecta los cambios con {abs(avg_lag):.0f}s de {'retraso' if avg_lag >= 0 else 'adelanto'} respecto a la tarjeta.")
    if not card_is_real:
        tips.append("Tarjeta simulada: se usan tus confirmaciones y correcciones como referencia.")

    new_profile = {
        **profile,
        "speed_threshold_kmh": new_t,
        "hold_s": new_h,
        "accuracy": accuracy,
        "avg_lag_s": avg_lag,
        "false_switches": false_switches,
        "samples_used": samples_used,
        "card_reads": profile.get("card_reads", 0) + 1,
        "last_card_read": now,
    }
    hist = list(profile.get("history", []))[-19:]
    hist.append({"ts": now, "accuracy": accuracy, "speed_threshold_kmh": new_t, "hold_s": new_h})
    new_profile["history"] = hist

    report = {
        "card_is_real": card_is_real,
        "card_activities": len(card_acts),
        "gps_events_compared": compared,
        "accuracy": accuracy,
        "matched_s": int(matched_s),
        "mismatched_s": int(mismatched_s),
        "false_switches": false_switches,
        "avg_lag_s": avg_lag,
        "corrections": len(corrections),
        "verified": len(verified_ids),
        "samples_used": samples_used,
        "sample_accuracy": round(sample_acc, 3) if sample_acc is not None else None,
        "threshold_before": old_t,
        "threshold_after": new_t,
        "hold_before": old_h,
        "hold_after": new_h,
        "tips": tips,
    }
    return {"report": report, "profile": new_profile, "corrections": corrections, "verified_ids": verified_ids}
