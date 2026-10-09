import { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  Pressable,
  TextInput,
  ActivityIndicator,
  ScrollView,
  Platform,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import MapView, { Marker, Polyline, PROVIDER_DEFAULT } from "@/src/components/truck-map";
import Icon from "@react-native-vector-icons/material-design-icons";
import * as Location from "expo-location";
import { api } from "@/src/api";
import { colors, spacing, radius, typography, makeStyles } from "@/src/theme";

type Pt = { lat: number; lng: number };
type Vehicle = {
  id: string;
  name: string;
  is_active: boolean;
  height_m: number;
  weight_t: number;
  length_m: number;
};
type RouteOut = {
  distance_km: number;
  duration_min: number;
  truck_adjusted_duration_min: number;
  polyline: [number, number][];
  warnings: string[];
  violations: string[];
  vehicle_applied: boolean;
  steps: {
    instruction: string;
    distance_km: number;
    duration_min: number;
  }[];
  vehicle_restricted: boolean;
  plan: {
    breaks_45min: number;
    daily_rests: number;
    stop_time_s: number;
    total_with_stops_s: number;
    fits_remaining_today: boolean;
  };
};
type Place = { id: string; name: string; full_address: string; lat: number; lng: number };

function fmtMin(min: number) {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m} min`;
}

const DEFAULT_REGION = {
  latitude: 40.4168,
  longitude: -3.7038,
  latitudeDelta: 2,
  longitudeDelta: 2,
};

export default function MapScreen() {
  const insets = useSafeAreaInsets();
  const mapRef = useRef<MapView>(null);
  const [origin, setOrigin] = useState<Pt | null>(null);
  const [destination, setDestination] = useState<Pt | null>(null);
  const [destQuery, setDestQuery] = useState("");
  const [route, setRoute] = useState<RouteOut | null>(null);
  const [loadingRoute, setLoadingRoute] = useState(false);
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [gpsStatus, setGpsStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [tapMode, setTapMode] = useState<"origin" | "destination">("destination");
  const [results, setResults] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [showSteps, setShowSteps] = useState(false);
  const styles = useStyles();

  const loadVehicle = useCallback(async () => {
    try {
      const list = await api<Vehicle[]>("/vehicles");
      const active = list.find((v) => v.is_active) || list[0] || null;
      setVehicle(active);
    } catch {}
  }, []);

  useEffect(() => {
    loadVehicle();
    (async () => {
      try {
        if (Platform.OS === "web") {
          setGpsStatus("GPS sólo en móvil");
          setOrigin({ lat: 40.4168, lng: -3.7038 });
          return;
        }
        let perm = await Location.getForegroundPermissionsAsync();
        if (perm.status !== "granted" && perm.canAskAgain) {
          perm = await Location.requestForegroundPermissionsAsync();
        }
        if (perm.status !== "granted") {
          setGpsStatus("Permiso GPS denegado");
          setOrigin({ lat: 40.4168, lng: -3.7038 });
          return;
        }
        const pos = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });
        const pt = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setOrigin(pt);
        setGpsStatus("GPS activo");
        mapRef.current?.animateToRegion(
          {
            latitude: pt.lat,
            longitude: pt.lng,
            latitudeDelta: 0.5,
            longitudeDelta: 0.5,
          },
          800,
        );
      } catch {
        setGpsStatus("GPS no disponible");
        setOrigin({ lat: 40.4168, lng: -3.7038 });
      }
    })();
  }, [loadVehicle]);

  async function calculateRoute() {
    if (!origin || !destination) {
      setError("Marca origen y destino");
      return;
    }
    setLoadingRoute(true);
    setError(null);
    try {
      const r = await api<RouteOut>("/routes/calculate", {
        method: "POST",
        body: JSON.stringify({
          origin: { ...origin, speed_kmh: 0 },
          destination: { ...destination, speed_kmh: 0 },
          vehicle_id: vehicle?.id,
          tz_offset_min: -new Date().getTimezoneOffset(),
        }),
      });
      setRoute(r);
      // Fit map to show both points
      mapRef.current?.fitToCoordinates(
        [
          { latitude: origin.lat, longitude: origin.lng },
          { latitude: destination.lat, longitude: destination.lng },
        ],
        { edgePadding: { top: 150, right: 60, bottom: 300, left: 60 }, animated: true },
      );
    } catch (e: any) {
      setError(e.message || "Error");
    } finally {
      setLoadingRoute(false);
    }
  }

  async function searchDestination() {
    if (destQuery.trim().length < 2) return;
    setError(null);
    setSearching(true);
    try {
      const near = origin ? `&lat=${origin.lat}&lng=${origin.lng}` : "";
      const data = await api<{ results: Place[] }>(
        `/geocode?q=${encodeURIComponent(destQuery.trim())}${near}`,
      );
      if (data.results.length === 0) setError("Dirección no encontrada");
      setResults(data.results);
    } catch (e: any) {
      setError(e.message || "Error buscando dirección");
    } finally {
      setSearching(false);
    }
  }

  function pickPlace(p: Place) {
    setResults([]);
    setDestQuery(p.name);
    setRoute(null);
    setDestination({ lat: p.lat, lng: p.lng });
    mapRef.current?.animateToRegion(
      { latitude: p.lat, longitude: p.lng, latitudeDelta: 0.5, longitudeDelta: 0.5 },
      800,
    );
  }

  async function sendGpsSample(lat: number, lng: number, speed: number) {
    try {
      await api("/tacho/gps-sample", {
        method: "POST",
        body: JSON.stringify({ lat, lng, speed_kmh: speed }),
      });
    } catch {}
  }

  async function reportCurrentPosition() {
    if (!origin) return;
    await sendGpsSample(origin.lat, origin.lng, 0);
    setGpsStatus("Posición actual reportada (parado)");
    setTimeout(() => setGpsStatus("GPS activo"), 3000);
  }

  async function simulateDriving() {
    if (!origin) return;
    await sendGpsSample(origin.lat, origin.lng, 70);
    setGpsStatus("Simulado conducción a 70 km/h");
    setTimeout(() => setGpsStatus("GPS activo"), 3000);
  }

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_DEFAULT}
        style={styles.map}
        initialRegion={DEFAULT_REGION}
        showsUserLocation={Platform.OS !== "web"}
        onPress={(e) => {
          const { latitude, longitude } = e.nativeEvent.coordinate;
          if (tapMode === "origin") setOrigin({ lat: latitude, lng: longitude });
          else setDestination({ lat: latitude, lng: longitude });
        }}
      >
        {origin && (
          <Marker
            coordinate={{ latitude: origin.lat, longitude: origin.lng }}
            pinColor={colors.success}
            title="Origen"
          />
        )}
        {destination && (
          <Marker
            coordinate={{ latitude: destination.lat, longitude: destination.lng }}
            pinColor={colors.brandPrimary}
            title="Destino"
          />
        )}
        {route && (
          <Polyline
            coordinates={route.polyline.map(([lat, lng]) => ({
              latitude: lat,
              longitude: lng,
            }))}
            strokeColor={colors.brandPrimary}
            strokeWidth={5}
          />
        )}
      </MapView>

      {/* Top search bar */}
      <View style={[styles.topBar, { top: insets.top + spacing.sm }]}>
        <View style={styles.searchRow}>
          <Icon name="magnify" size={22} color={colors.muted} />
          <TextInput
            testID="dest-input"
            style={styles.searchInput}
            placeholder="Buscar destino (ciudad, dirección)"
            placeholderTextColor={colors.muted}
            value={destQuery}
            onChangeText={setDestQuery}
            onSubmitEditing={searchDestination}
            returnKeyType="search"
          />
          <Pressable
            testID="dest-search-btn"
            onPress={searchDestination}
            style={styles.searchBtn}
          >
            {searching ? (
              <ActivityIndicator size="small" color={colors.onBrandPrimary} />
            ) : (
              <Icon name="arrow-right" size={20} color={colors.onBrandPrimary} />
            )}
          </Pressable>
        </View>
        {results.length > 0 && (
          <View style={styles.results} testID="search-results">
            {results.map((p, i) => (
              <Pressable
                key={p.id}
                testID={`search-result-${i}`}
                onPress={() => pickPlace(p)}
                style={({ pressed }) => [styles.resultRow, pressed && { backgroundColor: colors.surfaceTertiary }]}
              >
                <Icon name="map-marker-outline" size={18} color={colors.brandPrimary} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.resultName} numberOfLines={1}>{p.name}</Text>
                  <Text style={styles.resultAddr} numberOfLines={1}>{p.full_address}</Text>
                </View>
              </Pressable>
            ))}
          </View>
        )}
        <View style={styles.pillRow}>
          <View style={[styles.pill, { backgroundColor: colors.surfaceSecondary }]}>
            <Icon
              name="crosshairs-gps"
              size={14}
              color={gpsStatus === "GPS activo" ? colors.success : colors.warning}
            />
            <Text style={styles.pillText}>{gpsStatus || "GPS..."}</Text>
          </View>
          {vehicle && (
            <View style={[styles.pill, { backgroundColor: colors.brandTertiary }]}>
              <Icon name="truck" size={14} color={colors.onBrandTertiary} />
              <Text style={[styles.pillText, { color: colors.onBrandTertiary }]}>
                {vehicle.name}
              </Text>
            </View>
          )}
          {!vehicle && (
            <View style={[styles.pill, { backgroundColor: colors.error + "33" }]}>
              <Icon name="alert" size={14} color={colors.error} />
              <Text style={[styles.pillText, { color: colors.error }]}>
                Sin vehículo
              </Text>
            </View>
          )}
        </View>
      </View>

      {/* Bottom sheet */}
      <View
        style={[
          styles.bottomSheet,
          { paddingBottom: spacing.md },
        ]}
      >
        <View style={styles.sheetHandle} />
        <View style={styles.sheetTopRow}>
          <Pressable
            testID="tap-mode-origin"
            onPress={() => setTapMode("origin")}
            style={[styles.tapChip, tapMode === "origin" && styles.tapChipActive]}
          >
            <View style={[styles.dot, { backgroundColor: colors.success }]} />
            <Text style={styles.tapChipText}>
              {origin ? "Origen fijado" : "Toca para origen"}
            </Text>
          </Pressable>
          <Pressable
            testID="tap-mode-dest"
            onPress={() => setTapMode("destination")}
            style={[
              styles.tapChip,
              tapMode === "destination" && styles.tapChipActive,
            ]}
          >
            <View style={[styles.dot, { backgroundColor: colors.brandPrimary }]} />
            <Text style={styles.tapChipText}>
              {destination ? "Destino fijado" : "Toca para destino"}
            </Text>
          </Pressable>
        </View>

        <Pressable
          testID="calc-route-btn"
          onPress={calculateRoute}
          style={[
            styles.calcBtn,
            (!origin || !destination) && { opacity: 0.5 },
          ]}
          disabled={!origin || !destination || loadingRoute}
        >
          {loadingRoute ? (
            <ActivityIndicator color={colors.onBrandPrimary} />
          ) : (
            <>
              <Icon name="routes" size={22} color={colors.onBrandPrimary} />
              <Text style={styles.calcBtnText}>CALCULAR RUTA PARA CAMIÓN</Text>
            </>
          )}
        </Pressable>

        {error && (
          <Text style={styles.errorMsg} testID="route-error">
            {error}
          </Text>
        )}

        {route && (
          <ScrollView style={{ maxHeight: 280 }} testID="route-details">
            <View style={styles.statGrid}>
              <View style={styles.statCell}>
                <Text style={styles.statCellLabel}>DISTANCIA</Text>
                <Text style={styles.statCellValue} testID="route-distance">{Math.round(route.distance_km)} km</Text>
              </View>
              <View style={styles.statCell}>
                <Text style={styles.statCellLabel}>CONDUCCIÓN</Text>
                <Text style={[styles.statCellValue, { color: colors.brandPrimary }]} testID="route-truck-time">
                  {fmtMin(route.truck_adjusted_duration_min)}
                </Text>
              </View>
              <View style={styles.statCell}>
                <Text style={styles.statCellLabel}>CON PAUSAS</Text>
                <Text style={styles.statCellValue} testID="route-total-time">
                  {fmtMin(route.plan.total_with_stops_s / 60)}
                </Text>
              </View>
            </View>
            <View style={styles.planRow} testID="route-plan">
              <Icon
                name={route.plan.fits_remaining_today ? "check-circle-outline" : "coffee-outline"}
                size={18}
                color={route.plan.fits_remaining_today ? colors.success : colors.warning}
              />
              <Text style={styles.planText}>
                {route.plan.fits_remaining_today
                  ? "Llegas sin pausa obligatoria con tu tiempo disponible."
                  : `Necesitas ${route.plan.breaks_45min} pausa(s) de 45 min` +
                    (route.plan.daily_rests ? ` y ${route.plan.daily_rests} descanso(s) diario(s)` : "") +
                    ". Coche: " + fmtMin(route.duration_min) + "."}
              </Text>
            </View>
            {route.warnings.length > 0 && (
              <View style={styles.warningsBlock}>
                {route.warnings.map((w, i) => (
                  <View key={i} style={styles.warningRow} testID={`warning-${i}`}>
                    <Icon name="alert-circle" size={16} color={colors.warning} />
                    <Text style={styles.warningText}>{w}</Text>
                  </View>
                ))}
              </View>
            )}
            <Pressable testID="toggle-steps-btn" onPress={() => setShowSteps((s) => !s)} style={styles.stepsToggle}>
              <Text style={styles.stepsToggleText}>
                {showSteps ? "Ocultar indicaciones" : `Ver indicaciones (${route.steps.length})`}
              </Text>
              <Icon name={showSteps ? "chevron-up" : "chevron-down"} size={18} color={colors.brandPrimary} />
            </Pressable>
            {showSteps &&
              route.steps.map((s, i) => (
                <View key={i} style={styles.stepRow} testID={`route-step-${i}`}>
                  <Text style={styles.stepIdx}>{i + 1}</Text>
                  <Text style={styles.stepText}>{s.instruction}</Text>
                  <Text style={styles.stepDist}>{s.distance_km < 1 ? `${Math.round(s.distance_km * 1000)} m` : `${s.distance_km} km`}</Text>
                </View>
              ))}
          </ScrollView>
        )}

        <View style={styles.gpsActions}>
          <Pressable
            testID="gps-stopped-btn"
            onPress={reportCurrentPosition}
            style={styles.gpsActionBtn}
          >
            <Icon name="pause-circle" size={16} color={colors.success} />
            <Text style={styles.gpsActionText}>Reportar parado</Text>
          </Pressable>
          <Pressable
            testID="gps-driving-btn"
            onPress={simulateDriving}
            style={styles.gpsActionBtn}
          >
            <Icon name="play-circle" size={16} color={colors.brandPrimary} />
            <Text style={styles.gpsActionText}>Simular 70 km/h</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  container: { flex: 1, backgroundColor: c.surface },
  results: {
    marginTop: spacing.xs,
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    overflow: "hidden",
  },
  resultRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: c.divider,
    minHeight: 48,
  },
  resultName: { color: c.onSurface, fontSize: typography.base, fontWeight: "700" },
  resultAddr: { color: c.muted, fontSize: typography.sm },
  planRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.md,
    backgroundColor: c.surfaceTertiary,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  planText: { color: c.onSurfaceSecondary, fontSize: typography.sm, flex: 1, fontWeight: "600" },
  stepsToggle: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.md,
    minHeight: 44,
  },
  stepsToggleText: { color: c.brandPrimary, fontSize: typography.sm, fontWeight: "800" },
  stepRow: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: c.divider,
  },
  stepIdx: { color: c.muted, fontSize: typography.sm, width: 22, fontWeight: "700" },
  stepText: { color: c.onSurfaceSecondary, fontSize: typography.sm, flex: 1 },
  stepDist: { color: c.muted, fontSize: typography.sm },
  map: { flex: 1 },
  topBar: {
    position: "absolute",
    left: spacing.md,
    right: spacing.md,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: c.border,
  },
  searchInput: {
    flex: 1,
    color: c.onSurface,
    paddingVertical: spacing.sm,
    fontSize: typography.base,
  },
  searchBtn: {
    width: 36,
    height: 36,
    borderRadius: radius.sm,
    backgroundColor: c.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
  },
  pillRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.sm,
    flexWrap: "wrap",
  },
  pill: {
    flexDirection: "row",
    gap: 4,
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  pillText: {
    color: c.onSurfaceSecondary,
    fontSize: 11,
    fontWeight: "700",
  },
  bottomSheet: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: c.surfaceSecondary,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  sheetHandle: {
    width: 48,
    height: 4,
    backgroundColor: c.borderStrong,
    alignSelf: "center",
    borderRadius: radius.pill,
    marginBottom: spacing.md,
  },
  sheetTopRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginBottom: spacing.md,
  },
  tapChip: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    backgroundColor: c.surfaceTertiary,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: "transparent",
  },
  tapChipActive: { borderColor: c.brandPrimary },
  tapChipText: {
    color: c.onSurfaceSecondary,
    fontSize: typography.sm,
    fontWeight: "600",
    flexShrink: 1,
  },
  dot: { width: 10, height: 10, borderRadius: 5 },
  calcBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: c.brandPrimary,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
  },
  calcBtnText: {
    color: c.onBrandPrimary,
    fontSize: typography.base,
    fontWeight: "800",
    letterSpacing: 1,
  },
  errorMsg: {
    color: c.error,
    textAlign: "center",
    marginTop: spacing.sm,
  },
  statGrid: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  statCell: {
    flex: 1,
    backgroundColor: c.surfaceTertiary,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  statCellLabel: {
    color: c.muted,
    fontSize: 10,
    letterSpacing: 1,
    fontWeight: "700",
  },
  statCellValue: {
    color: c.onSurface,
    fontSize: typography.lg,
    fontWeight: "900",
    marginTop: 2,
  },
  warningsBlock: {
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  warningRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  warningText: {
    color: c.onSurfaceSecondary,
    fontSize: typography.sm,
    flex: 1,
  },
  gpsActions: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  gpsActionBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    backgroundColor: c.surfaceTertiary,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  },
  gpsActionText: {
    color: c.onSurfaceSecondary,
    fontSize: typography.sm,
    fontWeight: "600",
  },
}));
