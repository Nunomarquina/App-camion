# TruckNav Pro — PRD

## Original problem statement
App Android tipo Google Maps para vehículos grandes (camiones, autobuses, tráilers) que tenga en cuenta dimensiones y velocidades máximas para elegir carreteras y calcular mejor los tiempos. Registrar con GPS (con confirmación) y lecturas de tarjeta los tiempos de conducción y descanso, o simular entradas de tacógrafo para calcular los tiempos restantes.

## User choices
Mapbox (pendiente: build nativo) · Todas las funciones · UE 561/2006 · Email/contraseña · Cambio automático por GPS + confirmación manual o por tarjeta.

## Architecture
- Expo Router (tabs: Tacógrafo, Ruta, Vehículo, Historial) + auth screen; dark theme
- FastAPI + MongoDB; JWT auth (bcrypt); token in secure storage
- react-native-maps (web placeholder), expo-location, Nominatim geocoding

## Implemented (2026-10-09)
- Auth register/login/me
- Vehicle profiles CRUD (dims, weight, axles, max speed, ADR), active vehicle
- Tachograph: manual states, EU 561 status (4.5h continuous, 9h daily, 56h weekly, 11h rest)
- GPS auto-detection (hysteresis 30s) creates unconfirmed events; confirm/correct in Historial
- Simulated card read confirms pending events
- Truck route calc (SIMULATED straight-line, speed cap + dimension penalties + warnings)

## Iteration 2 (2026-10-09)
- Real truck routing via Mapbox Directions (max_height/width/weight from active vehicle), Mapbox geocoding search, truck time capped at vehicle max speed, Spanish turn-by-turn steps, break plan for trip
- Full EU 561 rules (backend/tacho_rules.py): split break 15→30 (order enforced), 10h extension max 2/week, daily rest 11h/9h reduced (max 3)/split 3+9 within 24h, weekly rest due 6×24h, 56h week, 90h two weeks, alerts
- Simulated past tachograph entries (Historial → Simular), delete entries

## Iteration 3 (2026-10-09)
- Card vs GPS learning (backend/detection_learning.py): compares GPS_AUTO detections with card activities (or driver-confirmed timeline when simulated), corrects mismatches, learns per-driver speed threshold & hold time from raw GPS samples; report sheet in Tacógrafo; card reference entries via Historial → Simular
- Rest areas (Mapbox Search Box rest_area/service_area) within 40 min before each mandatory break/daily rest, ≤1.5 km off route, shown on map and list
- Custom origin (search or tap) + "Usar mis horas disponibles" toggle for future routes

## Iteration 4 (2026-10-17)
- Truck time model per segment: min(Mapbox car speed, legal truck limit by posted speed — 90 motorway / 80 conventional / posted below —, vehicle max); avg speed shown
- Weight removed from vehicle profile; per-route "Peso total" input (max_weight to Mapbox), persisted locally
- Fixed: search results hidden behind bottom sheet after a route; editing origin/destination now clears route; "Cambiar" button
- Turn-by-turn navigator (/navigate): maneuver banner, ETA, remaining, speed vs vehicle max, tacho remaining, next mandatory stop & suggested area, off-route auto reroute, keep-awake, demo simulation (default on web)

## Iteration 5 (2026-10-17)
- Truck time recalibrated with real trip Burgos → Misson FR (real 4h15-4h20): motorway 90×0.97, conventional min(car×0.92, 80×0.92/posted), +0.15%/t over 20t, +60s/toll, +10s/maneuver → 4h18 at 40t. Tolls count shown.

## Iteration 6 (2026-10-17)
- Trips history (Ruta → Rutas anteriores): repeat route, enter/correct real time manually, delete
- Personal pace learning: median(actual moving / base estimate) of last 10 valid trips, shrunk n/(n+2), clamped 0.7-1.4, applied to new routes
- Spanish voice guidance (OpenAI tts-1-hd, fallback tts-1, universal key, Mongo cache) with mute toggle; announces at 1 km/300 m and at maneuver, reroute, arrival
- Rest areas filtered to same side of travel (right-hand traffic)

## Backlog
- P0: Voice guidance (expo-speech blocked; would need TTS integration)
- P0: Opposite-direction rest area filtering (motorway side)
- P1: Background GPS tracking (requires native build); ADR tunnel categories
- P2: PDF export of logbook, fleet/company dashboard
