import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  Platform,
  Switch,
  Linking,
} from "react-native";
import { useGpsAutoTracking } from "@/src/gps-tracker";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "@react-native-vector-icons/material-design-icons";
import * as Haptics from "expo-haptics";
import { api } from "@/src/api";
import { useAuth } from "@/src/auth-context";
import { colors, spacing, radius, typography, makeStyles } from "@/src/theme";
import { formatHMS, formatHM } from "@/src/format";

type TachoState = "DRIVING" | "WORK" | "REST" | "AVAILABLE";
type Status = {
  current_state: TachoState;
  continuous_driving_s: number;
  daily_driving_s: number;
  weekly_driving_s: number;
  daily_rest_s: number;
  remaining_continuous_driving_s: number;
  remaining_daily_driving_s: number;
  remaining_weekly_driving_s: number;
  needs_break: boolean;
  needs_daily_rest: boolean;
  violation: boolean;
  last_event_at: string | null;
  message: string;
};

const STATE_INFO: Record<
  TachoState,
  { label: string; color: string; icon: string }
> = {
  DRIVING: { label: "CONDUCCIÓN", color: colors.brandPrimary, icon: "steering" },
  WORK: { label: "TRABAJO", color: colors.info, icon: "wrench" },
  AVAILABLE: { label: "DISPONIBLE", color: colors.warning, icon: "clock-outline" },
  REST: { label: "DESCANSO", color: colors.success, icon: "bed-outline" },
};

export default function TachoScreen() {
  const insets = useSafeAreaInsets();
  const { user, logout } = useAuth();
  const [status, setStatus] = useState<Status | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [cardReading, setCardReading] = useState(false);
  const [cardMsg, setCardMsg] = useState<string | null>(null);
  const [autoGps, setAutoGps] = useState(false);
  const styles = useStyles();

  const load = useCallback(async () => {
    try {
      const s = await api<Status>("/tacho/status");
      setStatus(s);
    } catch (e) {
      // silent
    }
  }, []);

  const gps = useGpsAutoTracking(autoGps, load);

  useEffect(() => {
    (async () => {
      await load();
      setLoading(false);
    })();
    const i = setInterval(load, 15000);
    return () => clearInterval(i);
  }, [load]);

  async function pushState(state: TachoState) {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    }
    try {
      await api("/tacho/events", {
        method: "POST",
        body: JSON.stringify({ state, source: "MANUAL", confirmed: true }),
      });
      await load();
    } catch {}
  }

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  async function simulateCard() {
    setCardReading(true);
    setCardMsg(null);
    try {
      const res: any = await api("/tacho/card-sim", {
        method: "POST",
        body: JSON.stringify({ card_id: "SIM-" + (user?.id?.slice(0, 6) || "001") }),
      });
      setCardMsg(res.message);
      await load();
    } catch (e: any) {
      setCardMsg(e.message);
    } finally {
      setCardReading(false);
      setTimeout(() => setCardMsg(null), 5000);
    }
  }

  if (loading || !status) {
    return (
      <View style={[styles.loader, { paddingTop: insets.top }]}>
        <ActivityIndicator color={colors.brandPrimary} size="large" />
      </View>
    );
  }

  const info = STATE_INFO[status.current_state];
  const continuousPct = Math.min(
    100,
    (status.continuous_driving_s / (4.5 * 3600)) * 100,
  );
  const dailyPct = Math.min(100, (status.daily_driving_s / (9 * 3600)) * 100);
  const weeklyPct = Math.min(100, (status.weekly_driving_s / (56 * 3600)) * 100);

  return (
    <View style={styles.container}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + spacing.lg,
          paddingBottom: spacing.xl,
          paddingHorizontal: spacing.lg,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.brandPrimary}
          />
        }
      >
        {/* Header */}
        <View style={styles.header}>
          <View>
            <Text style={styles.hello}>Hola, {user?.name?.split(" ")[0]}</Text>
            <Text style={styles.date}>
              {new Date().toLocaleDateString("es-ES", {
                weekday: "long",
                day: "numeric",
                month: "long",
              })}
            </Text>
          </View>
          <Pressable testID="logout-btn" onPress={logout} hitSlop={10} style={styles.logout}>
            <Icon name="logout" size={22} color={colors.muted} />
          </Pressable>
        </View>

        {/* Big remaining continuous driving */}
        <View
          style={[
            styles.heroCard,
            status.violation && { borderColor: colors.error },
            !status.violation &&
              status.remaining_continuous_driving_s < 30 * 60 && {
                borderColor: colors.warning,
              },
          ]}
          testID="hero-card"
        >
          <Text style={styles.heroLabel}>TIEMPO RESTANTE CONDUCCIÓN CONTINUA</Text>
          <Text
            style={[
              styles.heroValue,
              {
                color: status.violation
                  ? colors.error
                  : status.remaining_continuous_driving_s < 30 * 60
                    ? colors.warning
                    : colors.brandPrimary,
              },
            ]}
            testID="remaining-continuous"
          >
            {formatHMS(status.remaining_continuous_driving_s)}
          </Text>
          <View style={styles.progressBar}>
            <View
              style={[
                styles.progressFill,
                {
                  width: `${continuousPct}%`,
                  backgroundColor: status.violation
                    ? colors.error
                    : continuousPct > 80
                      ? colors.warning
                      : colors.brandPrimary,
                },
              ]}
            />
          </View>
          <Text style={styles.heroMsg}>{status.message}</Text>
        </View>

        {/* Current state */}
        <View style={styles.currentStateCard} testID="current-state-card">
          <View style={[styles.stateDot, { backgroundColor: info.color }]} />
          <View style={{ flex: 1 }}>
            <Text style={styles.currentStateLabel}>Estado actual</Text>
            <Text style={[styles.currentStateValue, { color: info.color }]}>
              {info.label}
            </Text>
          </View>
          <Icon name={info.icon as any} size={32} color={info.color} />
        </View>

        {/* GPS auto detection */}
        <View style={styles.gpsCard} testID="gps-auto-card">
          <Icon name="crosshairs-gps" size={24} color={autoGps ? colors.success : colors.muted} />
          <View style={{ flex: 1 }}>
            <Text style={styles.gpsTitle}>Detección automática GPS</Text>
            <Text style={styles.gpsSub} testID="gps-auto-status">
              {Platform.OS === "web"
                ? "Disponible en la app móvil"
                : gps.permission === "blocked"
                  ? "Permiso de ubicación bloqueado"
                  : gps.permission === "denied"
                    ? "Permiso denegado. Actívalo para detectar movimiento"
                    : autoGps
                      ? `${Math.round(gps.speed)} km/h · cambia a conducción/descanso solo`
                      : "Cambia de estado al moverte o detenerte. Confirma en Historial."}
            </Text>
            {gps.permission === "blocked" && (
              <Pressable testID="gps-open-settings" onPress={() => Linking.openSettings()} style={styles.settingsBtn}>
                <Text style={styles.settingsText}>Abrir Ajustes</Text>
              </Pressable>
            )}
          </View>
          <Switch
            testID="gps-auto-switch"
            value={autoGps}
            onValueChange={setAutoGps}
            disabled={Platform.OS === "web"}
            trackColor={{ true: colors.success, false: colors.surfaceTertiary }}
            thumbColor={colors.onSurface}
          />
        </View>

        {/* State selector */}
        <Text style={styles.sectionTitle}>CAMBIAR ESTADO</Text>
        <View style={styles.stateGrid}>
          {(Object.keys(STATE_INFO) as TachoState[]).map((s) => {
            const si = STATE_INFO[s];
            const active = status.current_state === s;
            return (
              <Pressable
                key={s}
                testID={`state-btn-${s}`}
                onPress={() => pushState(s)}
                style={[
                  styles.stateBtn,
                  active && { borderColor: si.color, backgroundColor: si.color + "22" },
                ]}
              >
                <Icon
                  name={si.icon as any}
                  size={26}
                  color={active ? si.color : colors.onSurfaceTertiary}
                />
                <Text
                  style={[
                    styles.stateBtnLabel,
                    { color: active ? si.color : colors.onSurfaceTertiary },
                  ]}
                >
                  {si.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        {/* Stats */}
        <Text style={styles.sectionTitle}>LÍMITES EU 561/2006</Text>
        <StatRow
          label="Conducción diaria"
          value={formatHM(status.daily_driving_s)}
          remaining={`${formatHM(status.remaining_daily_driving_s)} rest.`}
          pct={dailyPct}
          testID="stat-daily"
        />
        <StatRow
          label="Conducción semanal"
          value={formatHM(status.weekly_driving_s)}
          remaining={`${formatHM(status.remaining_weekly_driving_s)} rest.`}
          pct={weeklyPct}
          testID="stat-weekly"
        />
        <StatRow
          label="Descanso diario"
          value={formatHM(status.daily_rest_s)}
          remaining={status.daily_rest_s >= 11 * 3600 ? "✓ Suficiente" : "11h recom."}
          pct={Math.min(100, (status.daily_rest_s / (11 * 3600)) * 100)}
          barColor={colors.success}
          testID="stat-rest"
        />

        {/* Card sim */}
        <Pressable
          testID="card-sim-btn"
          onPress={simulateCard}
          style={({ pressed }) => [
            styles.cardSimBtn,
            pressed && { opacity: 0.85 },
          ]}
          disabled={cardReading}
        >
          <Icon name="card-account-details-outline" size={22} color={colors.onBrandSecondary} />
          <Text style={styles.cardSimText}>
            {cardReading ? "LEYENDO..." : "SIMULAR LECTURA DE TARJETA"}
          </Text>
        </Pressable>
        {cardMsg && (
          <Text style={styles.cardMsg} testID="card-msg">
            {cardMsg}
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

function StatRow({
  label,
  value,
  remaining,
  pct,
  barColor,
  testID,
}: {
  label: string;
  value: string;
  remaining: string;
  pct: number;
  barColor?: string;
  testID?: string;
}) {
  const styles = useStyles();
  const fillColor =
    barColor ?? (pct > 90 ? colors.error : pct > 70 ? colors.warning : colors.brandPrimary);
  return (
    <View style={styles.statRow} testID={testID}>
      <View style={styles.statRowHead}>
        <Text style={styles.statLabel}>{label}</Text>
        <Text style={styles.statValue}>{value}</Text>
      </View>
      <View style={styles.statBar}>
        <View
          style={[styles.statFill, { width: `${pct}%`, backgroundColor: fillColor }]}
        />
      </View>
      <Text style={styles.statRemaining}>{remaining}</Text>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  container: { flex: 1, backgroundColor: c.surface },
  loader: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: c.surface,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.lg,
  },
  hello: {
    color: c.onSurface,
    fontSize: typography.xl,
    fontWeight: "800",
  },
  date: {
    color: c.muted,
    fontSize: typography.sm,
    marginTop: 2,
    textTransform: "capitalize",
  },
  logout: {
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: c.surfaceSecondary,
  },
  heroCard: {
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.lg,
    padding: spacing.xl,
    borderWidth: 1.5,
    borderColor: c.border,
    marginBottom: spacing.lg,
  },
  heroLabel: {
    color: c.muted,
    fontSize: typography.sm,
    letterSpacing: 1,
    fontWeight: "700",
  },
  heroValue: {
    fontSize: 56,
    fontWeight: "900",
    letterSpacing: 1,
    marginVertical: spacing.sm,
  },
  heroMsg: {
    color: c.onSurfaceSecondary,
    fontSize: typography.base,
    marginTop: spacing.sm,
  },
  progressBar: {
    height: 6,
    backgroundColor: c.surfaceTertiary,
    borderRadius: radius.pill,
    overflow: "hidden",
    marginTop: spacing.sm,
  },
  progressFill: { height: "100%", borderRadius: radius.pill },
  currentStateCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginBottom: spacing.xl,
    gap: spacing.md,
  },
  stateDot: { width: 10, height: 10, borderRadius: 5 },
  gpsCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.lg,
    padding: spacing.lg,
    marginTop: -spacing.md,
    marginBottom: spacing.xl,
  },
  gpsTitle: { color: c.onSurface, fontSize: typography.base, fontWeight: "700" },
  gpsSub: { color: c.muted, fontSize: typography.sm, marginTop: 2 },
  settingsBtn: {
    alignSelf: "flex-start",
    marginTop: spacing.sm,
    backgroundColor: c.brandPrimary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
  },
  settingsText: { color: c.onBrandPrimary, fontWeight: "800", fontSize: typography.sm },
  currentStateLabel: {
    color: c.muted,
    fontSize: typography.sm,
    letterSpacing: 1,
  },
  currentStateValue: {
    fontSize: typography.xl,
    fontWeight: "900",
    marginTop: 2,
  },
  sectionTitle: {
    color: c.muted,
    fontSize: typography.sm,
    letterSpacing: 1.5,
    fontWeight: "700",
    marginBottom: spacing.md,
    marginTop: spacing.sm,
  },
  stateGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginBottom: spacing.xl,
  },
  stateBtn: {
    width: "48%",
    aspectRatio: 2.1,
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: c.border,
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  stateBtnLabel: {
    fontSize: typography.sm,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  statRow: {
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.sm,
  },
  statRowHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },
  statLabel: {
    color: c.onSurfaceSecondary,
    fontSize: typography.base,
    fontWeight: "600",
  },
  statValue: {
    color: c.onSurface,
    fontSize: typography.base,
    fontWeight: "800",
  },
  statBar: {
    height: 4,
    backgroundColor: c.surfaceTertiary,
    borderRadius: radius.pill,
    overflow: "hidden",
  },
  statFill: { height: "100%", borderRadius: radius.pill },
  statRemaining: {
    color: c.muted,
    fontSize: typography.sm,
    marginTop: spacing.xs,
  },
  cardSimBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    backgroundColor: c.brandSecondary,
    paddingVertical: spacing.lg,
    borderRadius: radius.md,
    marginTop: spacing.lg,
  },
  cardSimText: {
    color: c.onBrandSecondary,
    fontSize: typography.base,
    fontWeight: "800",
    letterSpacing: 1,
  },
  cardMsg: {
    color: c.success,
    textAlign: "center",
    marginTop: spacing.sm,
    fontSize: typography.base,
  },
}));
