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
import { CardReportSheet, CardReport } from "@/src/components/card-report-sheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "@react-native-vector-icons/material-design-icons";
import * as Haptics from "expo-haptics";
import { api } from "@/src/api";
import { useAuth } from "@/src/auth-context";
import { colors, spacing, radius, typography, makeStyles } from "@/src/theme";
import { formatHMS, formatHM } from "@/src/format";

type TachoState = "DRIVING" | "WORK" | "REST" | "AVAILABLE";
type Alert = { level: "error" | "warning" | "info"; text: string };
type Status = {
  current_state: TachoState;
  continuous_driving_s: number;
  remaining_continuous_driving_s: number;
  split_break_first_done: boolean;
  break_in_progress: {
    elapsed_s: number;
    target_s: number;
    remaining_s: number;
    is_second_part: boolean;
    first_part_reached: boolean;
  } | null;
  daily_driving_s: number;
  daily_limit_s: number;
  remaining_daily_driving_s: number;
  remaining_daily_with_extension_s: number;
  extensions_used_week: number;
  extension_available: boolean;
  in_extension: boolean;
  weekly_driving_s: number;
  biweekly_driving_s: number;
  remaining_weekly_driving_s: number;
  reduced_daily_rests_used: number;
  daily_rest_split_first_done: boolean;
  required_daily_rest_s: number;
  daily_rest_start_by_s: number | null;
  weekly_rest_due_s: number | null;
  remaining_driving_now_s: number;
  needs_break: boolean;
  needs_daily_rest: boolean;
  violation: boolean;
  alerts: Alert[];
  last_event_at: string | null;
  message: string;
};

const TZ = -new Date().getTimezoneOffset();

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
  const [cardReport, setCardReport] = useState<CardReport | null>(null);
  const [showReport, setShowReport] = useState(false);
  const styles = useStyles();

  const load = useCallback(async () => {
    try {
      const s = await api<Status>(`/tacho/status?tz_offset_min=${TZ}`);
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
      setCardReport(res.report);
      gps.setProfile({ speed_threshold_kmh: res.profile.speed_threshold_kmh, hold_s: res.profile.hold_s });
      setShowReport(true);
      await load();
    } catch (e: any) {
      setCardMsg(e.message);
      setTimeout(() => setCardMsg(null), 5000);
    } finally {
      setCardReading(false);
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
  const dailyPct = Math.min(100, (status.daily_driving_s / status.daily_limit_s) * 100);
  const weeklyPct = Math.min(100, (status.weekly_driving_s / (56 * 3600)) * 100);
  const biweeklyPct = Math.min(100, (status.biweekly_driving_s / (90 * 3600)) * 100);
  const bip = status.break_in_progress;
  const alertColor = (l: Alert["level"]) =>
    l === "error" ? colors.error : l === "warning" ? colors.warning : colors.info;
  const deadline = (s: number | null) =>
    s === null ? "—" : s < 0 ? `Vencido hace ${formatHM(-s)}` : `en ${formatHM(s)}`;

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

        {/* Break in progress */}
        {bip && (
          <View style={styles.breakCard} testID="break-progress-card">
            <View style={styles.breakHead}>
              <Icon name="coffee-outline" size={22} color={colors.success} />
              <Text style={styles.breakTitle}>
                {bip.is_second_part ? "PAUSA · 2ª PARTE (30 MIN)" : "PAUSA EN CURSO (45 MIN)"}
              </Text>
            </View>
            <Text style={styles.breakValue} testID="break-remaining">
              {formatHMS(bip.remaining_s)}
            </Text>
            <View style={styles.progressBar}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.min(100, (bip.elapsed_s / bip.target_s) * 100)}%`, backgroundColor: colors.success },
                ]}
              />
            </View>
            <Text style={styles.breakHint}>
              {bip.is_second_part
                ? "Ya hiciste 15 min antes. Con 30 min completas la pausa."
                : bip.first_part_reached
                  ? "15 min alcanzados: si paras ahora cuenta como 1ª parte (luego 30 min)."
                  : "Mínimo 15 min para que cuente como 1ª parte de una pausa dividida."}
            </Text>
          </View>
        )}

        {/* Alerts */}
        {status.alerts.length > 0 && (
          <View style={styles.alertsBlock} testID="alerts-block">
            {status.alerts.map((a, i) => (
              <View
                key={i}
                style={[styles.alertRow, { borderLeftColor: alertColor(a.level) }]}
                testID={`alert-${i}`}
              >
                <Icon
                  name={a.level === "info" ? "information-outline" : "alert-outline"}
                  size={18}
                  color={alertColor(a.level)}
                />
                <Text style={styles.alertText}>{a.text}</Text>
              </View>
            ))}
          </View>
        )}

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
            <Text style={styles.gpsProfile} testID="gps-learned-profile">
              Aprendido: &gt;{gps.profile.speed_threshold_kmh} km/h · {gps.profile.hold_s}s de confirmación
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
        <View style={styles.chipRow}>
          <View style={[styles.ruleChip, status.split_break_first_done && { borderColor: colors.success }]} testID="chip-split-break">
            <Text style={[styles.ruleChipText, status.split_break_first_done && { color: colors.success }]}>
              Pausa 15+30: {status.split_break_first_done ? "1ª parte hecha" : "pendiente"}
            </Text>
          </View>
          <View style={styles.ruleChip} testID="chip-extensions">
            <Text style={styles.ruleChipText}>Ampliación 10h: {status.extensions_used_week}/2</Text>
          </View>
        </View>
        <StatRow
          label={status.in_extension ? "Conducción diaria (ampliada 10h)" : "Conducción diaria (9h)"}
          value={formatHM(status.daily_driving_s)}
          remaining={
            `${formatHM(status.remaining_daily_driving_s)} rest.` +
            (!status.in_extension && status.extension_available
              ? ` · ${formatHM(status.remaining_daily_with_extension_s)} con ampliación`
              : !status.extension_available
                ? " · sin ampliaciones esta semana"
                : "")
          }
          pct={dailyPct}
          testID="stat-daily"
        />
        <StatRow
          label="Conducción semanal (56h)"
          value={formatHM(status.weekly_driving_s)}
          remaining={`${formatHM(status.remaining_weekly_driving_s)} disponibles`}
          pct={weeklyPct}
          testID="stat-weekly"
        />
        <StatRow
          label="Dos semanas (90h)"
          value={formatHM(status.biweekly_driving_s)}
          remaining={`${formatHM(Math.max(0, 90 * 3600 - status.biweekly_driving_s))} rest.`}
          pct={biweeklyPct}
          testID="stat-biweekly"
        />

        <Text style={styles.sectionTitle}>DESCANSOS</Text>
        <View style={styles.restGrid}>
          <View style={styles.restCell} testID="rest-daily-deadline">
            <Text style={styles.restLabel}>DESCANSO DIARIO</Text>
            <Text style={[styles.restValue, (status.daily_rest_start_by_s ?? 1) < 0 && { color: colors.error }]}>
              {status.current_state === "REST" ? "En descanso" : deadline(status.daily_rest_start_by_s)}
            </Text>
            <Text style={styles.restSub}>
              Mín. {formatHM(status.required_daily_rest_s)} · reducidos {status.reduced_daily_rests_used}/3
              {status.daily_rest_split_first_done ? " · 3h hechas (faltan 9h)" : ""}
            </Text>
          </View>
          <View style={styles.restCell} testID="rest-weekly-deadline">
            <Text style={styles.restLabel}>DESCANSO SEMANAL</Text>
            <Text style={[styles.restValue, (status.weekly_rest_due_s ?? 1) < 0 && { color: colors.error }]}>
              {deadline(status.weekly_rest_due_s)}
            </Text>
            <Text style={styles.restSub}>45h normal · 24h reducido</Text>
          </View>
        </View>

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
      <CardReportSheet
        visible={showReport}
        onClose={() => setShowReport(false)}
        report={cardReport}
        message={cardMsg}
      />
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
  breakCard: {
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: c.success,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  breakHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  breakTitle: { color: c.success, fontSize: typography.sm, fontWeight: "800", letterSpacing: 1 },
  breakValue: { color: c.onSurface, fontSize: 36, fontWeight: "900", marginVertical: spacing.xs },
  breakHint: { color: c.onSurfaceTertiary, fontSize: typography.sm, marginTop: spacing.sm },
  alertsBlock: { gap: spacing.sm, marginBottom: spacing.lg },
  alertRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.md,
    borderLeftWidth: 4,
    padding: spacing.md,
  },
  alertText: { color: c.onSurfaceSecondary, fontSize: typography.sm, flex: 1, fontWeight: "600" },
  chipRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.sm, flexWrap: "wrap" },
  ruleChip: {
    borderWidth: 1,
    borderColor: c.borderStrong,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
  },
  ruleChipText: { color: c.onSurfaceTertiary, fontSize: 11, fontWeight: "700" },
  restGrid: { flexDirection: "row", gap: spacing.sm },
  restCell: {
    flex: 1,
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  restLabel: { color: c.muted, fontSize: 10, fontWeight: "700", letterSpacing: 1 },
  restValue: { color: c.onSurface, fontSize: typography.lg, fontWeight: "800", marginTop: 4 },
  restSub: { color: c.muted, fontSize: 11, marginTop: 4 },
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
  gpsProfile: { color: c.brandPrimary, fontSize: 11, marginTop: 4, fontWeight: "700" },
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
