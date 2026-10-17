"""Builds synthetic driver-card .DDD files (Annex IB layout) for testing."""
from datetime import datetime, timedelta, timezone


def _block(fid: int, btype: int, data: bytes) -> bytes:
    return fid.to_bytes(2, "big") + bytes([btype]) + len(data).to_bytes(2, "big") + data


def _name(s: str) -> bytes:
    return b"\x01" + s.encode("latin-1").ljust(35, b" ")[:35]


def _change(minute: int, act: int, not_inserted: int = 0) -> bytes:
    return ((not_inserted << 13) | (act << 11) | minute).to_bytes(2, "big")


def build_ddd(days, gen: int = 1, wrap: bool = True) -> bytes:
    """days: list of (date: datetime UTC midnight, [(minute, act, not_inserted)])"""
    ident = (bytes([0x11]) + b"E1234567890123" + b"00" + _name("DGT Madrid")
             + int(datetime(2022, 1, 1, tzinfo=timezone.utc).timestamp()).to_bytes(4, "big") * 2
             + int(datetime(2030, 1, 1, tzinfo=timezone.utc).timestamp()).to_bytes(4, "big")
             + _name("GARCIA LOPEZ") + _name("JUAN") + b"\x19\x80\x01\x01" + b"es")
    recs = []
    prev = 0
    for day, changes in days:
        body = b"".join(_change(*c) for c in changes)
        length = 12 + len(body)
        rec = (prev.to_bytes(2, "big") + length.to_bytes(2, "big")
               + int(day.timestamp()).to_bytes(4, "big") + b"\x00\x01" + b"\x01\x00" + body)
        recs.append(rec)
        prev = length
    stream = b"".join(recs)
    size = len(stream) + 40
    # Place records so they wrap around the end of the cyclic buffer
    offset = size - len(recs[0]) // 2 if wrap else 0
    buf = bytearray(size)
    for i, b in enumerate(stream):
        buf[(offset + i) % size] = b
    newest = (offset + len(stream) - len(recs[-1])) % size
    activity = offset.to_bytes(2, "big") + newest.to_bytes(2, "big") + bytes(buf)
    dtype = 0 if gen == 1 else 2
    return (_block(0x0002, 0, b"\x01" + b"\x00" * 24) + _block(0x0520, dtype, ident)
            + _block(0x0520, dtype + 1, b"\x00" * 128)
            + _block(0x0504, dtype, activity) + _block(0x0504, dtype + 1, b"\x00" * 128))


def sample_days(now: datetime, n: int = 3):
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    out = []
    for k in range(n, 0, -1):
        d = today - timedelta(days=k)
        # 00:00 rest, 06:00 work, 06:30 drive 4h, 10:30 break, 11:15 drive 3h, 14:15 rest
        out.append((d, [(0, 0, 0), (360, 2, 0), (390, 3, 0), (630, 0, 0), (675, 3, 0), (855, 0, 0)]))
    return out
