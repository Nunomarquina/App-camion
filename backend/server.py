from fastapi import FastAPI, APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import math
import uuid
import bcrypt
import jwt
from pathlib import Path
from pydantic import BaseModel, Field, EmailStr
from typing import List, Optional, Literal
from datetime import datetime, timedelta, timezone

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

JWT_SECRET = os.environ['JWT_SECRET']
JWT_ALGORITHM = "HS256"
JWT_EXPIRE_MINUTES = int(os.environ.get("JWT_EXPIRE_MINUTES", "10080"))

app = FastAPI(title="TruckNav Pro API")
api_router = APIRouter(prefix="/api")
bearer = HTTPBearer(auto_error=False)

logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)


# ============ UTILITIES ============
def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def hash_password(password: str) -> str:
    raw = password.encode("utf-8")
    if len(raw) > 72:
        raise HTTPException(400, "Password too long")
    return bcrypt.hashpw(raw, bcrypt.gensalt(rounds=12)).decode("utf-8")


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), stored_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def make_token(user_id: str, email: str) -> str:
    expires = now_utc() + timedelta(minutes=JWT_EXPIRE_MINUTES)
    payload = {"sub": user_id, "email": email, "exp": expires}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


async def get_current_user(
    credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer),
):
    if not credentials or credentials.scheme.lower() != "bearer":
        raise HTTPException(401, "Not authenticated",
                            headers={"WWW-Authenticate": "Bearer"})
    try:
        payload = jwt.decode(credentials.credentials, JWT_SECRET,
                             algorithms=[JWT_ALGORITHM])
        user_id = payload.get("sub")
        if not user_id:
            raise ValueError()
    except (jwt.ExpiredSignatureError, jwt.InvalidTokenError, ValueError):
        raise HTTPException(401, "Invalid or expired token",
                            headers={"WWW-Authenticate": "Bearer"})
    user = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not user:
        raise HTTPException(401, "User no longer exists")
    return user


# ============ MODELS ============
class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6, max_length=72)
    name: str = Field(min_length=1, max_length=100)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: str
    email: EmailStr
    name: str


class AuthOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


class VehicleIn(BaseModel):
    name: str
    plate: Optional[str] = None
    vehicle_type: Literal["truck", "bus", "trailer", "tanker"] = "truck"
    length_m: float = Field(gt=0, le=30)
    width_m: float = Field(gt=0, le=5)
    height_m: float = Field(gt=0, le=6)
    weight_t: float = Field(gt=0, le=80)
    axles: int = Field(ge=2, le=10)
    max_speed_kmh: int = Field(ge=40, le=130, default=90)
    hazmat: bool = False


class Vehicle(VehicleIn):
    id: str
    user_id: str
    is_active: bool = False
    created_at: datetime


TachoState = Literal["DRIVING", "WORK", "REST", "AVAILABLE"]


class TachoEventIn(BaseModel):
    state: TachoState
    source: Literal["GPS_AUTO", "MANUAL", "CARD"] = "MANUAL"
    confirmed: bool = True
    lat: Optional[float] = None
    lng: Optional[float] = None
    speed_kmh: Optional[float] = None
    note: Optional[str] = None


class TachoEvent(TachoEventIn):
    id: str
    user_id: str
    started_at: datetime
    ended_at: Optional[datetime] = None
    duration_s: Optional[int] = None


class GPSPoint(BaseModel):
    lat: float
    lng: float
    speed_kmh: float = 0
    timestamp: Optional[datetime] = None


class RouteIn(BaseModel):
    origin: GPSPoint
    destination: GPSPoint
    vehicle_id: Optional[str] = None


class RouteStep(BaseModel):
    instruction: str
    distance_km: float
    duration_min: float
    polyline: List[List[float]]  # [[lat, lng], ...]


class RouteOut(BaseModel):
    distance_km: float
    duration_min: float
    truck_adjusted_duration_min: float
    polyline: List[List[float]]
    warnings: List[str]
    steps: List[RouteStep]
    vehicle_restricted: bool


class TacoStatus(BaseModel):
    current_state: TachoState
    continuous_driving_s: int
    daily_driving_s: int
    weekly_driving_s: int
    daily_rest_s: int
    remaining_continuous_driving_s: int
    remaining_daily_driving_s: int
    remaining_weekly_driving_s: int
    needs_break: bool
    needs_daily_rest: bool
    violation: bool
    last_event_at: Optional[datetime] = None
    message: str


# ============ AUTH ROUTES ============
@api_router.get("/")
async def root():
    return {"message": "TruckNav Pro API", "status": "ok"}


@api_router.post("/auth/register", response_model=AuthOut, status_code=201)
async def register(body: RegisterIn):
    email = body.email.lower().strip()
    existing = await db.users.find_one({"email": email})
    if existing:
        raise HTTPException(409, "Email already registered")
    user_id = str(uuid.uuid4())
    user_doc = {
        "id": user_id,
        "email": email,
        "name": body.name.strip(),
        "password_hash": hash_password(body.password),
        "created_at": now_utc(),
    }
    await db.users.insert_one(user_doc)
    return AuthOut(
        access_token=make_token(user_id, email),
        user=UserOut(id=user_id, email=email, name=body.name.strip()),
    )


@api_router.post("/auth/login", response_model=AuthOut)
async def login(body: LoginIn):
    email = body.email.lower().strip()
    user = await db.users.find_one({"email": email})
    if not user or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(401, "Invalid email or password")
    return AuthOut(
        access_token=make_token(user["id"], email),
        user=UserOut(id=user["id"], email=email, name=user["name"]),
    )


@api_router.get("/auth/me", response_model=UserOut)
async def me(user=Depends(get_current_user)):
    return UserOut(id=user["id"], email=user["email"], name=user["name"])


# ============ VEHICLE ROUTES ============
@api_router.get("/vehicles", response_model=List[Vehicle])
async def list_vehicles(user=Depends(get_current_user)):
    cursor = db.vehicles.find({"user_id": user["id"]}, {"_id": 0})
    return [Vehicle(**v) async for v in cursor]


@api_router.post("/vehicles", response_model=Vehicle, status_code=201)
async def create_vehicle(body: VehicleIn, user=Depends(get_current_user)):
    v_id = str(uuid.uuid4())
    # count current vehicles
    count = await db.vehicles.count_documents({"user_id": user["id"]})
    doc = {
        **body.model_dump(),
        "id": v_id,
        "user_id": user["id"],
        "is_active": count == 0,
        "created_at": now_utc(),
    }
    await db.vehicles.insert_one(doc)
    doc.pop("_id", None)
    return Vehicle(**doc)


@api_router.put("/vehicles/{vehicle_id}", response_model=Vehicle)
async def update_vehicle(vehicle_id: str, body: VehicleIn, user=Depends(get_current_user)):
    existing = await db.vehicles.find_one({"id": vehicle_id, "user_id": user["id"]}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Vehicle not found")
    update = body.model_dump()
    await db.vehicles.update_one({"id": vehicle_id}, {"$set": update})
    existing.update(update)
    return Vehicle(**existing)


@api_router.post("/vehicles/{vehicle_id}/activate", response_model=Vehicle)
async def activate_vehicle(vehicle_id: str, user=Depends(get_current_user)):
    existing = await db.vehicles.find_one({"id": vehicle_id, "user_id": user["id"]}, {"_id": 0})
    if not existing:
        raise HTTPException(404, "Vehicle not found")
    await db.vehicles.update_many({"user_id": user["id"]}, {"$set": {"is_active": False}})
    await db.vehicles.update_one({"id": vehicle_id}, {"$set": {"is_active": True}})
    existing["is_active"] = True
    return Vehicle(**existing)


@api_router.delete("/vehicles/{vehicle_id}", status_code=204)
async def delete_vehicle(vehicle_id: str, user=Depends(get_current_user)):
    res = await db.vehicles.delete_one({"id": vehicle_id, "user_id": user["id"]})
    if res.deleted_count == 0:
        raise HTTPException(404, "Vehicle not found")
    return None


# ============ TACHOGRAPH ROUTES ============
# EU 561/2006 limits
CONTINUOUS_DRIVING_LIMIT_S = 4.5 * 3600   # 4h30
DAILY_DRIVING_LIMIT_S = 9 * 3600          # 9h (can be 10h max 2x/week)
WEEKLY_DRIVING_LIMIT_S = 56 * 3600        # 56h/week (45h average)
BREAK_DURATION_S = 45 * 60                # 45min
DAILY_REST_S = 11 * 3600                  # 11h daily rest


async def close_open_event(user_id: str, now: datetime):
    open_evt = await db.tacho_events.find_one(
        {"user_id": user_id, "ended_at": None}, {"_id": 0}
    )
    if open_evt:
        duration = int((now - open_evt["started_at"].replace(tzinfo=timezone.utc)).total_seconds())
        await db.tacho_events.update_one(
            {"id": open_evt["id"]},
            {"$set": {"ended_at": now, "duration_s": duration}},
        )
        return open_evt
    return None


@api_router.post("/tacho/events", response_model=TachoEvent)
async def push_tacho_event(body: TachoEventIn, user=Depends(get_current_user)):
    now = now_utc()
    # Close any currently-open event
    await close_open_event(user["id"], now)
    evt_id = str(uuid.uuid4())
    doc = {
        **body.model_dump(),
        "id": evt_id,
        "user_id": user["id"],
        "started_at": now,
        "ended_at": None,
        "duration_s": None,
    }
    await db.tacho_events.insert_one(doc)
    doc.pop("_id", None)
    return TachoEvent(**doc)


@api_router.get("/tacho/events", response_model=List[TachoEvent])
async def list_tacho_events(limit: int = 100, user=Depends(get_current_user)):
    cursor = db.tacho_events.find(
        {"user_id": user["id"]}, {"_id": 0}
    ).sort("started_at", -1).limit(limit)
    return [TachoEvent(**e) async for e in cursor]


def _ensure_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


async def _compute_status(user_id: str) -> TacoStatus:
    now = now_utc()
    one_day_ago = now - timedelta(days=1)
    one_week_ago = now - timedelta(days=7)

    cursor = db.tacho_events.find(
        {"user_id": user_id}, {"_id": 0}
    ).sort("started_at", 1)
    events = [e async for e in cursor]

    # Find current state (most recent event)
    current_state: TachoState = "REST"
    last_event_at = None
    if events:
        last = events[-1]
        current_state = last["state"]
        last_event_at = _ensure_utc(last["started_at"])

    # Compute continuous driving: sum of consecutive DRIVING blocks ending at current time
    continuous_driving = 0
    # walk from latest backwards: as long as state DRIVING or short break <45min
    for e in reversed(events):
        state = e["state"]
        start = _ensure_utc(e["started_at"])
        end = _ensure_utc(e["ended_at"]) if e.get("ended_at") else now
        dur = (end - start).total_seconds()
        if state == "DRIVING":
            continuous_driving += dur
        elif state == "REST":
            # If this rest is >= 45 min, break the chain
            if dur >= BREAK_DURATION_S:
                break
        else:
            # WORK or AVAILABLE: doesn't count as driving but doesn't reset continuous either
            continue

    # Daily driving (last 24h) & daily rest
    daily_driving = 0
    daily_rest = 0
    for e in events:
        start = _ensure_utc(e["started_at"])
        end = _ensure_utc(e["ended_at"]) if e.get("ended_at") else now
        if end < one_day_ago:
            continue
        clipped_start = max(start, one_day_ago)
        dur = (end - clipped_start).total_seconds()
        if dur <= 0:
            continue
        if e["state"] == "DRIVING":
            daily_driving += dur
        elif e["state"] == "REST":
            daily_rest += dur

    # Weekly driving
    weekly_driving = 0
    for e in events:
        start = _ensure_utc(e["started_at"])
        end = _ensure_utc(e["ended_at"]) if e.get("ended_at") else now
        if end < one_week_ago:
            continue
        clipped_start = max(start, one_week_ago)
        dur = (end - clipped_start).total_seconds()
        if dur <= 0:
            continue
        if e["state"] == "DRIVING":
            weekly_driving += dur

    remaining_continuous = max(0, CONTINUOUS_DRIVING_LIMIT_S - continuous_driving)
    remaining_daily = max(0, DAILY_DRIVING_LIMIT_S - daily_driving)
    remaining_weekly = max(0, WEEKLY_DRIVING_LIMIT_S - weekly_driving)

    needs_break = continuous_driving >= CONTINUOUS_DRIVING_LIMIT_S
    needs_daily_rest = daily_driving >= DAILY_DRIVING_LIMIT_S
    violation = needs_break or needs_daily_rest or weekly_driving > WEEKLY_DRIVING_LIMIT_S

    if violation:
        msg = "LÍMITE ALCANZADO. Descanso obligatorio."
    elif remaining_continuous < 30 * 60:
        msg = "Próximo al límite. Descanso en breve."
    elif current_state == "DRIVING":
        msg = "Conduciendo dentro del límite."
    elif current_state == "REST":
        msg = "En descanso."
    else:
        msg = "Estado activo."

    return TacoStatus(
        current_state=current_state,
        continuous_driving_s=int(continuous_driving),
        daily_driving_s=int(daily_driving),
        weekly_driving_s=int(weekly_driving),
        daily_rest_s=int(daily_rest),
        remaining_continuous_driving_s=int(remaining_continuous),
        remaining_daily_driving_s=int(remaining_daily),
        remaining_weekly_driving_s=int(remaining_weekly),
        needs_break=needs_break,
        needs_daily_rest=needs_daily_rest,
        violation=violation,
        last_event_at=last_event_at,
        message=msg,
    )


@api_router.get("/tacho/status", response_model=TacoStatus)
async def tacho_status(user=Depends(get_current_user)):
    return await _compute_status(user["id"])


class GPSSampleIn(BaseModel):
    lat: float
    lng: float
    speed_kmh: float


@api_router.post("/tacho/gps-sample", response_model=TacoStatus)
async def gps_sample(body: GPSSampleIn, user=Depends(get_current_user)):
    """GPS auto-detect driving/rest. Creates an unconfirmed event if state changes."""
    now = now_utc()
    # Threshold: moving >5 km/h = DRIVING, else REST
    detected: TachoState = "DRIVING" if body.speed_kmh > 5 else "REST"
    latest = await db.tacho_events.find_one(
        {"user_id": user["id"]}, {"_id": 0}, sort=[("started_at", -1)]
    )
    if not latest or latest["state"] != detected:
        await close_open_event(user["id"], now)
        doc = {
            "id": str(uuid.uuid4()),
            "user_id": user["id"],
            "state": detected,
            "source": "GPS_AUTO",
            "confirmed": False,
            "lat": body.lat,
            "lng": body.lng,
            "speed_kmh": body.speed_kmh,
            "note": None,
            "started_at": now,
            "ended_at": None,
            "duration_s": None,
        }
        await db.tacho_events.insert_one(doc)
    return await _compute_status(user["id"])


class ConfirmIn(BaseModel):
    state: Optional[TachoState] = None


@api_router.post("/tacho/events/{event_id}/confirm", response_model=TachoEvent)
async def confirm_event(event_id: str, body: ConfirmIn, user=Depends(get_current_user)):
    evt = await db.tacho_events.find_one({"id": event_id, "user_id": user["id"]}, {"_id": 0})
    if not evt:
        raise HTTPException(404, "Event not found")
    update = {"confirmed": True}
    if body.state and body.state != evt["state"]:
        update["state"] = body.state
        update["note"] = f"Corregido manualmente (GPS detectó {evt['state']})"
    await db.tacho_events.update_one({"id": event_id}, {"$set": update})
    evt.update(update)
    return TachoEvent(**evt)


class CardSimIn(BaseModel):
    card_id: str
    pin: Optional[str] = None


@api_router.post("/tacho/card-sim")
async def card_sim(body: CardSimIn, user=Depends(get_current_user)):
    """Simulate tachograph card insertion. Confirms all unconfirmed events in the last 24h."""
    now = now_utc()
    one_day_ago = now - timedelta(days=1)
    result = await db.tacho_events.update_many(
        {
            "user_id": user["id"],
            "confirmed": False,
            "started_at": {"$gte": one_day_ago},
        },
        {"$set": {"confirmed": True, "source": "CARD"}},
    )
    return {
        "card_id": body.card_id,
        "confirmed_events": result.modified_count,
        "message": f"Tarjeta {body.card_id} leída. {result.modified_count} eventos confirmados.",
    }


# ============ ROUTING (truck-aware simulated) ============
def haversine_km(lat1, lng1, lat2, lng2):
    R = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlmb / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


@api_router.post("/routes/calculate", response_model=RouteOut)
async def calculate_route(body: RouteIn, user=Depends(get_current_user)):
    """
    Simulated truck-aware routing.
    - Builds a straight-line polyline between origin and destination (simplified)
    - Adjusts average speed based on vehicle size/weight
    - Produces truck warnings based on vehicle dimensions
    """
    vehicle = None
    if body.vehicle_id:
        vehicle = await db.vehicles.find_one(
            {"id": body.vehicle_id, "user_id": user["id"]}, {"_id": 0}
        )
    if not vehicle:
        vehicle = await db.vehicles.find_one(
            {"user_id": user["id"], "is_active": True}, {"_id": 0}
        )

    o = body.origin
    d = body.destination
    distance = haversine_km(o.lat, o.lng, d.lat, d.lng)

    # Interpolate 20 points
    N = 20
    poly = []
    for i in range(N + 1):
        t = i / N
        poly.append([o.lat + (d.lat - o.lat) * t, o.lng + (d.lng - o.lng) * t])

    # Baseline car speed estimate
    avg_car_speed = 85  # km/h on mixed highway/urban

    truck_speed_cap = 90
    warnings: List[str] = []
    truck_adjustment = 1.0
    vehicle_restricted = False

    if vehicle:
        truck_speed_cap = min(vehicle.get("max_speed_kmh", 90), 90)
        # Big penalties for very heavy / long / tall vehicles
        if vehicle.get("weight_t", 0) > 20:
            truck_adjustment *= 1.15
            warnings.append("Vehículo >20t: evitar pendientes pronunciadas y zonas urbanas con restricción de peso.")
        if vehicle.get("height_m", 0) > 4.0:
            truck_adjustment *= 1.08
            warnings.append(f"Altura {vehicle['height_m']}m: comprobar puentes bajos y túneles.")
        if vehicle.get("length_m", 0) > 16:
            truck_adjustment *= 1.1
            warnings.append(f"Longitud {vehicle['length_m']}m: evitar curvas cerradas y rotondas pequeñas.")
        if vehicle.get("hazmat"):
            truck_adjustment *= 1.2
            warnings.append("Mercancía peligrosa (HAZMAT): se desvían túneles y zonas urbanas.")
            vehicle_restricted = True
        if vehicle.get("width_m", 0) > 2.55:
            warnings.append("Vehículo especial de ancho >2.55m: requiere permiso.")

    effective_speed = min(avg_car_speed, truck_speed_cap)
    duration_min = (distance / effective_speed) * 60
    truck_adjusted = duration_min * truck_adjustment

    # Simple 3-step breakdown
    steps = []
    thirds = [0, N // 3, (2 * N) // 3, N]
    labels = ["Sal hacia la autovía principal", "Continúa por carretera nacional", "Aproximación al destino"]
    for idx in range(3):
        a, b = thirds[idx], thirds[idx + 1]
        seg_dist = haversine_km(poly[a][0], poly[a][1], poly[b][0], poly[b][1])
        seg_dur = (seg_dist / effective_speed) * 60 * truck_adjustment
        steps.append(RouteStep(
            instruction=labels[idx],
            distance_km=round(seg_dist, 2),
            duration_min=round(seg_dur, 1),
            polyline=poly[a : b + 1],
        ))

    return RouteOut(
        distance_km=round(distance, 2),
        duration_min=round(duration_min, 1),
        truck_adjusted_duration_min=round(truck_adjusted, 1),
        polyline=poly,
        warnings=warnings,
        steps=steps,
        vehicle_restricted=vehicle_restricted,
    )


# ============ APP SETUP ============
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup_db():
    await db.users.create_index("email", unique=True)
    await db.vehicles.create_index("user_id")
    await db.tacho_events.create_index([("user_id", 1), ("started_at", -1)])
    logger.info("Database indexes ready.")


@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
