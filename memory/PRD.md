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

## Backlog
- P0: Opposite-direction rest area filtering (motorway side)
- P1: Background GPS tracking (requires native build); ADR tunnel categories
- P2: PDF export of logbook, fleet/company dashboard
