"""EU Regulation 561/2006 driving/rest time calculations (pure functions).

Rules implemented:
- Break: after 4h30 of driving, 45 min break. May be split into 15 min followed
  by 30 min (in that order). Only REST periods count as break.
- Daily driving: max 9h, extendable to 10h at most twice per fixed week (Mon-Sun).
- Daily rest: regular 11h, may be split 3h + 9h, or reduced to 9h (max 3 times
  between two weekly rests). Must be completed within 24h of the end of the
  previous daily/weekly rest.
- Weekly: max 56h driving per fixed week, max 90h in two consecutive weeks.
- Weekly rest: regular 45h, reduced 24h. Must start no later than six 24h
  periods after the end of the previous weekly rest.
"""
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Any, Optional

H = 3600
M = 60
CONT_LIMIT = int(4.5 * H)
BREAK_FULL = 45 * M
BREAK_PART1 = 15 * M
BREAK_PART2 = 30 * M
DAILY_LIMIT = 9 * H
DAILY_EXT_LIMIT = 10 * H
MAX_EXTENSIONS = 2
WEEKLY_LIMIT = 56 * H
BIWEEKLY_LIMIT = 90 * H
DAILY_REST_REGULAR = 11 * H
DAILY_REST_REDUCED = 9 * H
DAILY_REST_SPLIT1 = 3 * H
MAX_REDUCED_DAILY = 3
WEEKLY_REST_REDUCED = 24 * H
WEEKLY_REST_REGULAR = 45 * H


def _utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt


def build_segments(events: List[Dict[str, Any]], now: datetime) -> List[Dict[str, Any]]:
    """Sorted, merged (adjacent same-state) segments with start/end/open."""
    segs: List[Dict[str, Any]] = []
    for e in sorted(events, key=lambda x: _utc(x["started_at"])):
        start = _utc(e["started_at"])
        end = _utc(e["ended_at"]) if e.get("ended_at") else now
        if end <= start:
            continue
        if segs and segs[-1]["state"] == e["state"] and abs((start - segs[-1]["end"]).total_seconds()) < 60:
            segs[-1]["end"] = max(segs[-1]["end"], end)
            segs[-1]["open"] = not e.get("ended_at")
        else:
            segs.append({"state": e["state"], "start": start, "end": end, "open": not e.get("ended_at")})
    return segs


def _week_start(now: datetime, tz_offset_min: int) -> datetime:
    local = now + timedelta(minutes=tz_offset_min)
    monday = (local - timedelta(days=local.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    return monday - timedelta(minutes=tz_offset_min)


def _driving_between(segs, a: datetime, b: datetime) -> float:
    total = 0.0
    for s in segs:
        if s["state"] != "DRIVING":
            continue
        lo, hi = max(s["start"], a), min(s["end"], b)
        if hi > lo:
            total += (hi - lo).total_seconds()
    return total


def fmt(sec: float) -> str:
    sec = max(0, int(sec))
    return f"{sec // H}h {(sec % H) // M:02d}m"


def compute_status(events: List[Dict[str, Any]], now: datetime, tz_offset_min: int = 0) -> Dict[str, Any]:
    segs = build_segments(events, now)
    current_state = segs[-1]["state"] if segs else "REST"
    last_event_at = segs[-1]["start"] if segs else None

    cont = 0.0
    split_first = False          # 15-min first part of break done
    split_first_before_cur = False
    day_drive = 0.0
    day_start: Optional[datetime] = segs[0]["start"] if segs else None
    daily_split_first = False    # 3h first part of daily rest done
    days: List[Dict[str, Any]] = []
    reduced_daily = 0
    last_daily_rest_end: Optional[datetime] = None
    last_weekly_rest_end: Optional[datetime] = None
    last_weekly_rest_type: Optional[str] = None

    def close_day(end: datetime):
        nonlocal day_drive, day_start, daily_split_first, cont, split_first
        days.append({"start": day_start, "drive": day_drive})
        day_drive = 0.0
        day_start = end
        daily_split_first = False
        cont = 0.0
        split_first = False

    for i, s in enumerate(segs):
        dur = (s["end"] - s["start"]).total_seconds()
        is_last = i == len(segs) - 1
        if is_last:
            split_first_before_cur = split_first
        if s["state"] == "DRIVING":
            cont += dur
            day_drive += dur
        elif s["state"] == "REST":
            if dur >= WEEKLY_REST_REDUCED:
                close_day(s["end"])
                last_weekly_rest_end = s["end"]
                last_daily_rest_end = s["end"]
                last_weekly_rest_type = "regular" if dur >= WEEKLY_REST_REGULAR else "reducido"
                reduced_daily = 0
            elif dur >= DAILY_REST_REGULAR or (daily_split_first and dur >= DAILY_REST_REDUCED):
                close_day(s["end"])
                last_daily_rest_end = s["end"]
            elif dur >= DAILY_REST_REDUCED:
                close_day(s["end"])
                last_daily_rest_end = s["end"]
                reduced_daily += 1
            else:
                if dur >= DAILY_REST_SPLIT1:
                    daily_split_first = True
                if dur >= BREAK_FULL or (split_first and dur >= BREAK_PART2):
                    cont = 0.0
                    split_first = False
                elif dur >= BREAK_PART1 and not split_first:
                    split_first = True
        # WORK / AVAILABLE: neither driving nor break

    # ---- Daily driving & extensions ----
    week_start = _week_start(now, tz_offset_min)
    ext_used = sum(1 for d in days if d["start"] and d["start"] >= week_start and d["drive"] > DAILY_LIMIT)
    in_extension = day_drive > DAILY_LIMIT
    if in_extension:
        ext_used += 1
    extension_available = in_extension or ext_used < MAX_EXTENSIONS
    daily_limit = DAILY_EXT_LIMIT if in_extension else DAILY_LIMIT
    remaining_daily = max(0, daily_limit - day_drive)
    remaining_daily_ext = max(0, DAILY_EXT_LIMIT - day_drive) if extension_available else remaining_daily

    # ---- Weekly ----
    weekly = _driving_between(segs, week_start, now)
    prev_week = _driving_between(segs, week_start - timedelta(days=7), week_start)
    biweekly = weekly + prev_week
    remaining_weekly = max(0, min(WEEKLY_LIMIT - weekly, BIWEEKLY_LIMIT - biweekly))

    # ---- Continuous / break ----
    remaining_cont = max(0, CONT_LIMIT - cont)
    break_in_progress = None
    if segs and current_state == "REST":
        cur_dur = (segs[-1]["end"] - segs[-1]["start"]).total_seconds()
        if cur_dur < DAILY_REST_REDUCED:
            target = BREAK_PART2 if split_first_before_cur else BREAK_FULL
            if cur_dur < target:
                break_in_progress = {
                    "elapsed_s": int(cur_dur),
                    "target_s": target,
                    "remaining_s": int(target - cur_dur),
                    "is_second_part": split_first_before_cur,
                    "first_part_reached": (not split_first_before_cur) and cur_dur >= BREAK_PART1,
                }
            # Remaining driving shown as it will be after this break completes
    # remaining_driving_now: min of all limits
    remaining_now = min(remaining_cont, remaining_daily, remaining_weekly)

    # ---- Daily rest deadline ----
    ref_daily = last_daily_rest_end or (segs[0]["start"] if segs else None)
    required_daily_rest = DAILY_REST_REDUCED if reduced_daily < MAX_REDUCED_DAILY else DAILY_REST_REGULAR
    daily_rest_start_by_s = None
    if ref_daily:
        daily_rest_start_by_s = int((ref_daily + timedelta(hours=24) - timedelta(seconds=required_daily_rest) - now).total_seconds())

    # ---- Weekly rest deadline ----
    ref_weekly = last_weekly_rest_end or (segs[0]["start"] if segs else None)
    weekly_rest_due_s = None
    if ref_weekly:
        weekly_rest_due_s = int((ref_weekly + timedelta(days=6) - now).total_seconds())

    # ---- Alerts ----
    alerts: List[Dict[str, str]] = []
    violation = False
    if cont > CONT_LIMIT:
        violation = True
        alerts.append({"level": "error", "text": f"Exceso de conducción continua ({fmt(cont)}). Pausa de 45 min obligatoria."})
    elif remaining_cont <= 30 * M and segs:
        alerts.append({"level": "warning", "text": f"Pausa obligatoria en {fmt(remaining_cont)}."})
    if day_drive > DAILY_EXT_LIMIT or (day_drive > DAILY_LIMIT and ext_used > MAX_EXTENSIONS):
        violation = True
        alerts.append({"level": "error", "text": "Límite de conducción diaria superado."})
    elif in_extension:
        alerts.append({"level": "warning", "text": f"Ampliación a 10h en uso ({ext_used}/2 esta semana)."})
    if weekly > WEEKLY_LIMIT or biweekly > BIWEEKLY_LIMIT:
        violation = True
        alerts.append({"level": "error", "text": "Límite semanal (56h) o bisemanal (90h) superado."})
    if daily_rest_start_by_s is not None and current_state != "REST":
        if daily_rest_start_by_s < 0:
            violation = True
            alerts.append({"level": "error", "text": "Descanso diario fuera de plazo (24h)."})
        elif daily_rest_start_by_s < 2 * H:
            alerts.append({"level": "warning", "text": f"Inicia el descanso diario en {fmt(daily_rest_start_by_s)}."})
    if weekly_rest_due_s is not None and weekly_rest_due_s < 24 * H:
        alerts.append({"level": "error" if weekly_rest_due_s < 0 else "warning",
                       "text": "Descanso semanal vencido." if weekly_rest_due_s < 0 else f"Descanso semanal en {fmt(weekly_rest_due_s)}."})
    if split_first and current_state != "REST":
        alerts.append({"level": "info", "text": "1ª parte de pausa (15 min) hecha: la siguiente puede ser de 30 min."})

    if violation:
        msg = "INFRACCIÓN. Descanso obligatorio."
    elif break_in_progress:
        msg = (f"Pausa {'2ª parte' if break_in_progress['is_second_part'] else 'en curso'}: "
               f"faltan {fmt(break_in_progress['remaining_s'])}.")
    elif remaining_now <= 30 * M and segs:
        msg = "Próximo al límite. Planifica la parada."
    elif current_state == "DRIVING":
        msg = "Conduciendo dentro de los límites."
    elif current_state == "REST":
        msg = "En descanso."
    else:
        msg = "Estado activo (no cuenta como pausa)."

    return {
        "current_state": current_state,
        "last_event_at": last_event_at,
        "continuous_driving_s": int(cont),
        "remaining_continuous_driving_s": int(remaining_cont),
        "split_break_first_done": split_first,
        "break_in_progress": break_in_progress,
        "daily_driving_s": int(day_drive),
        "daily_limit_s": daily_limit,
        "remaining_daily_driving_s": int(remaining_daily),
        "remaining_daily_with_extension_s": int(remaining_daily_ext),
        "extensions_used_week": ext_used,
        "extension_available": extension_available,
        "in_extension": in_extension,
        "weekly_driving_s": int(weekly),
        "biweekly_driving_s": int(biweekly),
        "remaining_weekly_driving_s": int(remaining_weekly),
        "reduced_daily_rests_used": reduced_daily,
        "daily_rest_split_first_done": daily_split_first,
        "required_daily_rest_s": required_daily_rest,
        "daily_rest_start_by_s": daily_rest_start_by_s,
        "weekly_rest_due_s": weekly_rest_due_s,
        "last_weekly_rest_type": last_weekly_rest_type,
        "remaining_driving_now_s": int(remaining_now),
        "needs_break": cont >= CONT_LIMIT,
        "needs_daily_rest": day_drive >= daily_limit,
        "violation": violation,
        "alerts": alerts,
        "message": msg,
    }


def plan_breaks(drive_s: float, status: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Estimate breaks/daily rests needed to drive `drive_s` seconds from now."""
    rem_cont = status["remaining_continuous_driving_s"] if status else CONT_LIMIT
    rem_day = status["remaining_daily_driving_s"] if status else DAILY_LIMIT
    left = drive_s
    breaks = 0
    daily_rests = 0
    total_stop = 0
    while left > 0:
        chunk = min(left, rem_cont, rem_day)
        left -= chunk
        rem_cont -= chunk
        rem_day -= chunk
        if left <= 0:
            break
        if rem_day <= 0:
            daily_rests += 1
            total_stop += DAILY_REST_REGULAR
            rem_day = DAILY_LIMIT
            rem_cont = CONT_LIMIT
        elif rem_cont <= 0:
            breaks += 1
            total_stop += BREAK_FULL
            rem_cont = CONT_LIMIT
    return {
        "breaks_45min": breaks,
        "daily_rests": daily_rests,
        "stop_time_s": int(total_stop),
        "total_with_stops_s": int(drive_s + total_stop),
        "fits_remaining_today": drive_s <= (status["remaining_driving_now_s"] if status else CONT_LIMIT),
    }
