from fastapi import FastAPI, APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
import uuid
from tacho_rules import compute_status, plan_breaks
import mapbox_routing
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



async def _compute_status(user_id: str, tz_offset_min: int = 0) -> dict:
    since = now_utc() - timedelta(days=21)
    cursor = db.tacho_events.find(
        {"user_id": user_id, "$or": [{"ended_at": None}, {"ended_at": {"$gte": since}}]},
        {"_id": 0},
    ).sort("started_at", 1)
    events = [e async for e in cursor]
    return compute_status(events, now_utc(), tz_offset_min)


@api_router.get("/tacho/status")
async def tacho_status(tz_offset_min: int = 0, user=Depends(get_current_user)):
    return await _compute_status(user["id"], tz_offset_min)


class ManualEntryIn(BaseModel):
    state: TachoState
    started_at: datetime
    ended_at: datetime
    note: Optional[str] = None


@api_router.post("/tacho/events/manual", response_model=TachoEvent, status_code=201)
async def manual_entry(body: ManualEntryIn, user=Depends(get_current_user)):
    """Simulate/enter a past tachograph activity (closed period)."""
    start = body.started_at if body.started_at.tzinfo else body.started_at.replace(tzinfo=timezone.utc)
    end = body.ended_at if body.ended_at.tzinfo else body.ended_at.replace(tzinfo=timezone.utc)
    now = now_utc()
    if end <= start:
        raise HTTPException(400, "El fin debe ser posterior al inicio")
    if end > now + timedelta(minutes=1):
        raise HTTPException(400, "No se pueden registrar actividades futuras")
    s_naive, e_naive = start.replace(tzinfo=None), end.replace(tzinfo=None)
    overlap = await db.tacho_events.find_one({
        "user_id": user["id"],
        "started_at": {"$lt": e_naive},
        "$or": [{"ended_at": None}, {"ended_at": {"$gt": s_naive}}],
    }, {"_id": 0})
    if overlap:
        raise HTTPException(409, "Se solapa con otra actividad registrada")
    doc = {
        "id": str(uuid.uuid4()),
        "user_id": user["id"],
        "state": body.state,
        "source": "MANUAL",
        "confirmed": True,
        "lat": None, "lng": None, "speed_kmh": None,
        "note": body.note or "Entrada manual",
        "started_at": start,
        "ended_at": end,
        "duration_s": int((end - start).total_seconds()),
    }
    await db.tacho_events.insert_one(doc)
    doc.pop("_id", None)
    return TachoEvent(**doc)


@api_router.delete("/tacho/events/{event_id}", status_code=204)
async def delete_event(event_id: str, user=Depends(get_current_user)):
    res = await db.tacho_events.delete_one({"id": event_id, "user_id": user["id"]})
    if res.deleted_count == 0:
        raise HTTPException(404, "Event not found")
    return None


class GPSSampleIn(BaseModel):
    lat: float
    lng: float
    speed_kmh: float


@api_router.post("/tacho/gps-sample")
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



# ============ ROUTING (Mapbox truck restrictions) ============
class LatLng(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)


class RouteIn(BaseModel):
    origin: LatLng
    destination: LatLng
    vehicle_id: Optional[str] = None
    tz_offset_min: int = 0


@api_router.get("/geocode")
async def geocode(q: str, lat: Optional[float] = None, lng: Optional[float] = None,
                  user=Depends(get_current_user)):
    if len(q.strip()) < 2:
        raise HTTPException(400, "Búsqueda demasiado corta")
    proximity = f"{lng},{lat}" if lat is not None and lng is not None else None
    return {"results": await mapbox_routing.geocode(q.strip(), proximity)}


@api_router.post("/routes/calculate")
async def calculate_route(body: RouteIn, user=Depends(get_current_user)):
    vehicle = None
    if body.vehicle_id:
        vehicle = await db.vehicles.find_one({"id": body.vehicle_id, "user_id": user["id"]}, {"_id": 0})
    if not vehicle:
        vehicle = await db.vehicles.find_one({"user_id": user["id"], "is_active": True}, {"_id": 0})

    route = await mapbox_routing.truck_route(body.origin.model_dump(), body.destination.model_dump(), vehicle)

    warnings: List[str] = []
    if not vehicle:
        warnings.append("Sin vehículo activo: la ruta no tiene en cuenta dimensiones.")
    else:
        warnings.append(
            f"Ruta evitando restricciones < {vehicle['height_m']}m alto, "
            f"{vehicle['width_m']}m ancho, {vehicle['weight_t']}t."
        )
        if vehicle.get("hazmat"):
            warnings.append("ADR: Mapbox no filtra túneles por categoría ADR. Verifica túneles en la ruta.")
        if vehicle.get("length_m", 0) > 16.5:
            warnings.append(f"Longitud {vehicle['length_m']}m (>16.5m): requiere autorización especial.")
        if vehicle.get("width_m", 0) > 2.55:
            warnings.append("Ancho >2.55m: transporte especial, requiere permiso.")
    warnings.extend(route["violations"])

    status = await _compute_status(user["id"], body.tz_offset_min)
    plan = plan_breaks(route["truck_duration_s"], status)

    return {
        **route,
        "truck_adjusted_duration_min": round(route["truck_duration_s"] / 60, 1),
        "warnings": warnings,
        "vehicle_restricted": bool(route["violations"]),
        "vehicle_applied": bool(vehicle),
        "plan": plan,
    }


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
