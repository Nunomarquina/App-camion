"""Parser for EU digital tachograph DRIVER CARD downloads (.DDD / .ESM / .C1B / .TGD).

File = sequence of blocks: FID (2 bytes) | type (1 byte) | length (2 bytes BE) | data.
type 0x00/0x01 = Gen1 data/signature, 0x02/0x03 = Gen2 data/signature.
Annex IB / IC of Reg. (EU) 2016/799 (formerly 3821/85).
"""
from datetime import datetime, timedelta, timezone
from typing import Dict, List, Optional

FID_IDENTIFICATION = 0x0520
FID_DRIVER_ACTIVITY = 0x0504
ACTIVITY_STATE = {0: "REST", 1: "AVAILABLE", 2: "WORK", 3: "DRIVING"}


class DDDError(ValueError):
    pass


def _blocks(raw: bytes) -> Dict[int, Dict[int, bytes]]:
    """Return {generation: {fid: data}} keeping only data blocks."""
    out: Dict[int, Dict[int, bytes]] = {1: {}, 2: {}}
    i = 0
    while i + 5 <= len(raw):
        fid = int.from_bytes(raw[i:i + 2], "big")
        btype = raw[i + 2]
        length = int.from_bytes(raw[i + 3:i + 5], "big")
        data = raw[i + 5:i + 5 + length]
        if btype > 3 or len(data) != length:
            break
        if btype in (0, 2):
            out[1 if btype == 0 else 2].setdefault(fid, data)
        i += 5 + length
    return out


def _text(b: bytes) -> str:
    return b[1:].decode("latin-1", errors="ignore").replace("\x00", " ").strip()


def _time(b: bytes) -> Optional[datetime]:
    v = int.from_bytes(b, "big")
    if v in (0, 0xFFFFFFFF):
        return None
    return datetime.fromtimestamp(v, tz=timezone.utc)


def _identification(d: bytes) -> dict:
    if len(d) < 143:
        return {}
    expiry = _time(d[61:65])
    return {
        "card_number": d[1:17].decode("latin-1", errors="ignore").strip("\x00 "),
        "issuing_nation": d[0],
        "expiry_date": expiry.date().isoformat() if expiry else None,
        "holder_surname": _text(d[65:101]),
        "holder_first_names": _text(d[101:137]),
    }


def _daily_records(d: bytes) -> List[tuple]:
    if len(d) < 4 + 12:
        return []
    oldest = int.from_bytes(d[0:2], "big")
    newest = int.from_bytes(d[2:4], "big")
    buf = d[4:]
    size = len(buf)
    if oldest >= size or newest >= size:
        raise DDDError("Puntero de actividad fuera de rango")

    def read(pos: int, n: int) -> bytes:
        pos %= size
        if pos + n <= size:
            return buf[pos:pos + n]
        return buf[pos:] + buf[:n - (size - pos)]

    records = []
    pos = oldest
    for _ in range(400):  # card holds max ~28-56 days; guard against loops
        rec_len = int.from_bytes(read(pos + 2, 2), "big")
        if rec_len < 12 or rec_len > size:
            break
        rec = read(pos, rec_len)
        day = _time(rec[4:8])
        changes = [int.from_bytes(rec[j:j + 2], "big") for j in range(12, rec_len - 1, 2)]
        if day:
            records.append((day, changes))
        if pos == newest:
            break
        pos = (pos + rec_len) % size
    return records


def _timeline(records: List[tuple], now: datetime) -> List[dict]:
    acts: List[dict] = []
    for day, changes in sorted(records, key=lambda r: r[0]):
        day0 = day.replace(hour=0, minute=0, second=0, microsecond=0)
        parsed = []
        for v in changes:
            minute = v & 0x07FF
            if minute >= 1440:
                continue
            parsed.append((minute, (v >> 13) & 1, (v >> 11) & 3))
        parsed.sort(key=lambda p: p[0])
        for i, (minute, not_inserted, act) in enumerate(parsed):
            if not_inserted:
                continue  # card not in the tachograph: unknown period
            start = day0 + timedelta(minutes=minute)
            end = day0 + timedelta(minutes=parsed[i + 1][0] if i + 1 < len(parsed) else 1440)
            end = min(end, now)
            if end <= start:
                continue
            state = ACTIVITY_STATE[act]
            if acts and acts[-1]["state"] == state and acts[-1]["end"] == start:
                acts[-1]["end"] = end
            else:
                acts.append({"state": state, "start": start, "end": end})
    return acts


def parse_driver_card(raw: bytes, now: Optional[datetime] = None) -> dict:
    now = now or datetime.now(timezone.utc)
    if len(raw) < 50:
        raise DDDError("El archivo está vacío o incompleto")
    if raw[0] == 0x76:
        raise DDDError("Es una descarga del tacógrafo del vehículo (VU), no de la tarjeta de conductor")
    gens = _blocks(raw)
    gen = 2 if FID_DRIVER_ACTIVITY in gens[2] else 1
    blocks = gens[gen]
    if FID_DRIVER_ACTIVITY not in blocks:
        raise DDDError("No es un archivo de tarjeta de conductor válido (.DDD)")
    info = _identification(blocks.get(FID_IDENTIFICATION) or gens[1].get(FID_IDENTIFICATION, b""))
    records = _daily_records(blocks[FID_DRIVER_ACTIVITY])
    acts = _timeline(records, now)
    if not acts:
        raise DDDError("La tarjeta no contiene actividades registradas")
    driving_s = sum((a["end"] - a["start"]).total_seconds() for a in acts if a["state"] == "DRIVING")
    return {
        **info,
        "generation": gen,
        "days": len(records),
        "period_start": acts[0]["start"],
        "period_end": acts[-1]["end"],
        "driving_s": int(driving_s),
        "activities": acts,
    }
