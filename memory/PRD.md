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

## Backlog
- P0: Real truck routing (Mapbox/HERE/GraphHopper truck profile) with real road polylines
- P1: Breaks split 15+30, 10h days 2x/week, biweekly 90h, weekly rest; card vs GPS accuracy stats
- P1: Background GPS tracking (requires native build)
- P2: PDF export of logbook, fleet/company dashboard
