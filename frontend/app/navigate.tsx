import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Pressable, ActivityIndicator, Platform, Linking } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Location from "expo-location";
import { useKeepAwake } from "expo-keep-awake";
import Icon from "@react-native-vector-icons/material-design-icons";
import MapView, { Marker, Polyline, PROVIDER_DEFAULT } from "@/src/components/truck-map";
import { api } from "@/src/api";
import { getNavigation, setNavigation, clearNavigation, NavRoute } from "@/src/nav-store";
import { cumulative, fmtDist, locate, maneuverIcon, pointAt, valueAt, LatLng } from "@/src/nav-geo";
import { colors, spacing, radius, typography, makeStyles } from "@/src/theme";
import { formatHM } from "@/src/format";

const OFF_ROUTE_M = 60;
const DEMO_SPEED_KMH = 90;
const DEMO_FACTOR = 10; // simulated time acceleration

type Pos = { p: LatLng; heading: number; speedKmh: number };

export default function NavigateScreen() {
  useKeepAwake();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const mapRef = useRef<any>(null);
  const nav = getNavigation();

  const [route, setRoute] = useState<NavRoute | null>(nav?.route ?? null);
  const [pos, setPos] = useState<Pos | null>(null);
  const [follow, setFollow] = useState(true);
  const [demo, setDemo] = useState(Platform.OS === "web");
  const [perm, setPerm] = useState<"unknown" | "granted" | "denied" | "blocked">("unknown");
  const [rerouting, setRerouting] = useState(false);
  const [arrived, setArrived] = useState(false);
  const [tachoLeft, setTachoLeft] = useState<number | null>(null);
  const hint = useRef(0);
  const offCount = useRef(0);
  const lastReroute = useRef(0);
  const demoAlong = useRef(0);

  const poly = useMemo(() => (route?.polyline ?? []) as LatLng[], [route]);
  const cumM = useMemo(() => (route?.cum_m && route.cum_m.length === poly.length ? route.cum_m : cumulative(poly)), [route, poly]);
  const totalM = cumM[cumM.length - 1] ?? 0;
  const cumS = useMemo(() => {
    if (route?.cum_s && route.cum_s.length === poly.length) return route.cum_s;
    return cumM.map((m) => (totalM ? (m / totalM) * (route?.truck_duration_s ?? 0) : 0));
  }, [route, poly, cumM, totalM]);

  const progress = useMemo(() => {
    if (!pos || poly.length === 0) return null;
    const pr = locate(poly, cumM, pos.p, hint.current);
    hint.current = pr.idx;
    return pr;
  }, [pos, poly, cumM]);

  // ---- Tacho remaining driving (poll) ----
  useEffect(() => {
    const load = () =>
      api<{ remaining_driving_now_s: number }>(`/tacho/status?tz_offset_min=${-new Date().getTimezoneOffset()}`)
        .then((s) => setTachoLeft(s.remaining_driving_now_s))
        .catch(() => {});
    load();
    const i = setInterval(load, 60000);
    return () => clearInterval(i);
  }, []);

  // ---- Real GPS ----
  useEffect(() => {
    if (demo || Platform.OS === "web" || !route) return;
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    (async () => {
      let res = await Location.getForegroundPermissionsAsync();
      if (res.status !== "granted" && res.canAskAgain) res = await Location.requestForegroundPermissionsAsync();
      if (res.status !== "granted") {
        setPerm(res.canAskAgain ? "denied" : "blocked");
        return;
      }
      setPerm("granted");
      if (cancelled) return;
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 3 },
        (l) =>
          setPos({
            p: [l.coords.latitude, l.coords.longitude],
            heading: l.coords.heading && l.coords.heading >= 0 ? l.coords.heading : 0,
            speedKmh: Math.max(0, (l.coords.speed ?? 0) * 3.6),
          }),
      );
    })();
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [demo, route]);

  // ---- Demo / simulation along the route ----
  useEffect(() => {
    if (!demo || poly.length === 0) return;
    const step = () => {
      demoAlong.current = Math.min(totalM, demoAlong.current + (DEMO_SPEED_KMH / 3.6) * DEMO_FACTOR);
      const { p, heading } = pointAt(poly, cumM, demoAlong.current);
      setPos({ p, heading, speedKmh: DEMO_SPEED_KMH });
    };
    step();
    const i = setInterval(step, 1000);
    return () => clearInterval(i);
  }, [demo, poly, cumM, totalM]);

  // ---- Camera follow ----
  useEffect(() => {
    if (!pos || !follow) return;
    mapRef.current?.animateCamera?.(
      { center: { latitude: pos.p[0], longitude: pos.p[1] }, heading: pos.heading, pitch: 50, zoom: 17 },
      { duration: 900 },
    );
  }, [pos, follow]);

  // ---- Reroute when off route ----
  const reroute = useCallback(
    async (from: LatLng) => {
      if (!nav) return;
      setRerouting(true);
      lastReroute.current = Date.now();
      try {
        const r = await api<NavRoute>("/routes/calculate", {
          method: "POST",
          body: JSON.stringify({
            origin: { lat: from[0], lng: from[1] },
            destination: nav.request.destination,
            vehicle_id: nav.request.vehicleId,
            tz_offset_min: -new Date().getTimezoneOffset(),
            use_current_hours: nav.request.useCurrentHours,
            ...(nav.request.weightT ? { weight_t: nav.request.weightT } : {}),
          }),
        });
        hint.current = 0;
        demoAlong.current = 0;
        setNavigation(r, nav.request);
        setRoute(r);
      } catch {
        // keep current route; will retry on next fixes
      } finally {
        setRerouting(false);
        offCount.current = 0;
      }
    },
    [nav],
  );

  useEffect(() => {
    if (!progress || !pos || rerouting || arrived) return;
    if (totalM - progress.alongM < 30) {
      setArrived(true);
      return;
    }
    if (progress.offM > OFF_ROUTE_M) {
      offCount.current += 1;
      if (offCount.current >= 3 && Date.now() - lastReroute.current > 15000) reroute(pos.p);
    } else {
      offCount.current = 0;
    }
  }, [progress, pos, rerouting, arrived, totalM, reroute]);

  if (!route || !nav) {
    return (
      <View style={[styles.center, { paddingTop: insets.top }]} testID="nav-no-route">
        <Text style={styles.centerText}>No hay ruta activa</Text>
        <Pressable testID="nav-back-btn" onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)/map"))} style={styles.primaryBtn}>
          <Text style={styles.primaryText}>Volver</Text>
        </Pressable>
      </View>
    );
  }

  const along = progress?.alongM ?? 0;
  const steps = route.steps;
  const nextIdx = steps.findIndex((s) => s.along_m > along + 5);
  const next = nextIdx >= 0 ? steps[nextIdx] : steps[steps.length - 1];
  const after = nextIdx >= 0 ? steps[nextIdx + 1] : undefined;
  const toNext = next ? Math.max(0, next.along_m - along) : 0;
  const remainingM = Math.max(0, totalM - along);
  const drivenS = valueAt(cumM, cumS, along);
  const remainingS = Math.max(0, (cumS[cumS.length - 1] ?? 0) - drivenS);
  const eta = new Date(Date.now() + remainingS * 1000);
  const nextStop = route.stops.find((s) => s.at_drive_s > drivenS);
  const nextStopIn = nextStop ? nextStop.at_drive_s - drivenS : null;
  const nextArea = nextStop?.areas[0];
  const overSpeed = pos ? pos.speedKmh > nav.request.vehicleMaxSpeed + 2 : false;
  const tachoWarn = tachoLeft !== null && tachoLeft < remainingS && tachoLeft < 30 * 60;

  function exit() {
    clearNavigation();
    if (router.canGoBack()) router.back();
    else router.replace("/(tabs)/map");
  }

  return (
    <View style={styles.container} testID="navigate-screen">
      <MapView
        ref={mapRef}
        provider={PROVIDER_DEFAULT}
        style={styles.map}
        initialRegion={{ latitude: poly[0][0], longitude: poly[0][1], latitudeDelta: 0.02, longitudeDelta: 0.02 }}
        showsUserLocation={!demo && Platform.OS !== "web"}
        showsCompass={false}
        onPanDrag={() => setFollow(false)}
      >
        <Polyline
          coordinates={poly.map(([lat, lng]) => ({ latitude: lat, longitude: lng }))}
          strokeColor={colors.brandPrimary}
          strokeWidth={8}
        />
        <Marker coordinate={{ latitude: nav.request.destination.lat, longitude: nav.request.destination.lng }} pinColor={colors.brandPrimary} />
        {route.stops.flatMap((s) => s.areas.slice(0, 2)).map((a) => (
          <Marker key={a.id} coordinate={{ latitude: a.lat, longitude: a.lng }} pinColor={colors.info} title={a.name} />
        ))}
        {demo && pos && (
          <Marker coordinate={{ latitude: pos.p[0], longitude: pos.p[1] }} anchor={{ x: 0.5, y: 0.5 }} flat rotation={pos.heading}>
            <View style={styles.truckDot}>
              <Icon name="navigation" size={22} color={colors.onBrandPrimary} />
            </View>
          </Marker>
        )}
      </MapView>

      {/* Maneuver banner */}
      <View style={[styles.banner, { paddingTop: insets.top + spacing.sm }]} testID="nav-banner">
        {arrived ? (
          <View style={styles.bannerRow}>
            <Icon name="flag-checkered" size={44} color={colors.onBrandPrimary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.bannerDist} testID="nav-arrived">Has llegado</Text>
              <Text style={styles.bannerText} numberOfLines={2}>{nav.request.destinationName}</Text>
            </View>
          </View>
        ) : (
          <View style={styles.bannerRow}>
            <Icon name={maneuverIcon(next?.type ?? "", next?.modifier ?? "") as any} size={48} color={colors.onBrandPrimary} />
            <View style={{ flex: 1 }}>
              <Text style={styles.bannerDist} testID="nav-next-distance">{pos ? fmtDist(toNext) : "—"}</Text>
              <Text style={styles.bannerText} numberOfLines={2} testID="nav-next-instruction">
                {next?.instruction ?? ""}
              </Text>
            </View>
          </View>
        )}
        {!arrived && after && (
          <Text style={styles.thenText} numberOfLines={1} testID="nav-then">
            Luego: {after.instruction}
          </Text>
        )}
        {rerouting && (
          <View style={styles.rerouteRow} testID="nav-rerouting">
            <ActivityIndicator size="small" color={colors.onBrandPrimary} />
            <Text style={styles.thenText}>Recalculando ruta para camión…</Text>
          </View>
        )}
      </View>

      {/* Permission problem */}
      {perm === "denied" || perm === "blocked" ? (
        <View style={[styles.permCard, { top: insets.top + 150 }]} testID="nav-permission-card">
          <Text style={styles.permText}>Necesitamos tu ubicación para guiarte por la ruta.</Text>
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            {perm === "blocked" && (
              <Pressable testID="nav-open-settings" onPress={() => Linking.openSettings()} style={styles.smallBtn}>
                <Text style={styles.smallBtnText}>Abrir Ajustes</Text>
              </Pressable>
            )}
            <Pressable testID="nav-use-demo" onPress={() => setDemo(true)} style={styles.smallBtn}>
              <Text style={styles.smallBtnText}>Simular recorrido</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* Floating controls */}
      <View style={[styles.speedBubble, overSpeed && { borderColor: colors.error }, { bottom: insets.bottom + 200 }]} testID="nav-speed">
        <Text style={[styles.speedValue, overSpeed && { color: colors.error }]}>{pos ? Math.round(pos.speedKmh) : 0}</Text>
        <Text style={styles.speedUnit}>km/h</Text>
        <Text style={styles.speedLimit}>máx {nav.request.vehicleMaxSpeed}</Text>
      </View>
      <View style={[styles.fabCol, { bottom: insets.bottom + 200 }]}>
        {!follow && (
          <Pressable testID="nav-recenter-btn" onPress={() => setFollow(true)} style={styles.fab}>
            <Icon name="crosshairs-gps" size={24} color={colors.onSurface} />
          </Pressable>
        )}
        <Pressable
          testID="nav-demo-toggle"
          onPress={() => setDemo((d) => !d)}
          style={[styles.fab, demo && { backgroundColor: colors.brandTertiary }]}
        >
          <Icon name={demo ? "pause" : "play-speed"} size={24} color={demo ? colors.onBrandTertiary : colors.onSurface} />
        </Pressable>
      </View>

      {/* Bottom panel */}
      <View style={[styles.panel, { paddingBottom: insets.bottom + spacing.md }]} testID="nav-panel">
        <View style={styles.panelRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.eta} testID="nav-eta">
              {eta.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}
            </Text>
            <Text style={styles.panelSub} testID="nav-remaining">
              {formatHM(remainingS)} · {fmtDist(remainingM)}
              {demo ? " · simulación" : ""}
            </Text>
          </View>
          <Pressable testID="nav-exit-btn" onPress={exit} style={styles.exitBtn}>
            <Icon name="close" size={22} color={colors.onError} />
            <Text style={styles.exitText}>Salir</Text>
          </Pressable>
        </View>
        <View style={styles.infoRow}>
          <View style={[styles.infoCell, tachoWarn && { borderColor: colors.warning }]} testID="nav-tacho-left">
            <Icon name="timer-outline" size={16} color={tachoWarn ? colors.warning : colors.onSurfaceTertiary} />
            <Text style={styles.infoText}>
              Tacógrafo: {tachoLeft === null ? "—" : formatHM(tachoLeft)}
            </Text>
          </View>
          <View style={styles.infoCell} testID="nav-next-stop">
            <Icon name="coffee-outline" size={16} color={colors.onSurfaceTertiary} />
            <Text style={styles.infoText} numberOfLines={1}>
              {nextStop && nextStopIn !== null
                ? `${nextStop.type === "daily_rest" ? "Descanso" : "Pausa"} en ${formatHM(nextStopIn)}`
                : "Sin pausas"}
            </Text>
          </View>
        </View>
        {nextArea && (
          <Text style={styles.areaText} numberOfLines={1} testID="nav-next-area">
            Área sugerida: {nextArea.name} · km {Math.round(nextArea.route_km)}
            {progress ? ` (a ${fmtDist(nextArea.route_km * 1000 - along)})` : ""}
          </Text>
        )}
        {progress && progress.offM > OFF_ROUTE_M && !rerouting && (
          <Text style={styles.offText} testID="nav-off-route">Fuera de ruta ({Math.round(progress.offM)} m)</Text>
        )}
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  container: { flex: 1, backgroundColor: c.surface },
  map: { flex: 1 },
  center: { flex: 1, backgroundColor: c.surface, alignItems: "center", justifyContent: "center", gap: spacing.lg },
  centerText: { color: c.onSurface, fontSize: typography.lg },
  primaryBtn: { backgroundColor: c.brandPrimary, paddingHorizontal: spacing.xl, minHeight: 48, justifyContent: "center", borderRadius: radius.md },
  primaryText: { color: c.onBrandPrimary, fontWeight: "800" },
  banner: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: c.brandSecondary,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomLeftRadius: radius.lg,
    borderBottomRightRadius: radius.lg,
  },
  bannerRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  bannerDist: { color: c.onBrandPrimary, fontSize: 32, fontWeight: "900" },
  bannerText: { color: c.onBrandPrimary, fontSize: typography.lg, fontWeight: "700" },
  thenText: { color: c.onBrandPrimary, fontSize: typography.sm, marginTop: spacing.xs, opacity: 0.85 },
  rerouteRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.xs },
  truckDot: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: c.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 3,
    borderColor: c.onSurface,
  },
  permCard: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.md,
  },
  permText: { color: c.onSurface, fontSize: typography.base },
  smallBtn: { backgroundColor: c.brandPrimary, paddingHorizontal: spacing.md, minHeight: 40, justifyContent: "center", borderRadius: radius.sm },
  smallBtnText: { color: c.onBrandPrimary, fontWeight: "800", fontSize: typography.sm },
  speedBubble: {
    position: "absolute",
    left: spacing.lg,
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: c.surfaceSecondary,
    borderWidth: 3,
    borderColor: c.borderStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  speedValue: { color: c.onSurface, fontSize: 24, fontWeight: "900" },
  speedUnit: { color: c.muted, fontSize: 10, marginTop: -2 },
  speedLimit: { color: c.muted, fontSize: 9 },
  fabCol: { position: "absolute", right: spacing.lg, gap: spacing.sm },
  fab: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: c.surfaceSecondary,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: c.border,
  },
  panel: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: c.surfaceSecondary,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: c.border,
    gap: spacing.sm,
  },
  panelRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  eta: { color: c.success, fontSize: 30, fontWeight: "900" },
  panelSub: { color: c.onSurfaceSecondary, fontSize: typography.base, fontWeight: "600" },
  exitBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: c.error,
    paddingHorizontal: spacing.lg,
    minHeight: 48,
    borderRadius: radius.md,
  },
  exitText: { color: c.onError, fontWeight: "800" },
  infoRow: { flexDirection: "row", gap: spacing.sm },
  infoCell: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: c.surfaceTertiary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    minHeight: 40,
    borderWidth: 1,
    borderColor: "transparent",
  },
  infoText: { color: c.onSurfaceSecondary, fontSize: typography.sm, fontWeight: "700", flexShrink: 1 },
  areaText: { color: c.info, fontSize: typography.sm },
  offText: { color: c.warning, fontSize: typography.sm, fontWeight: "700" },
}));
