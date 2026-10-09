import { useCallback, useState } from "react";
import { View, Text, FlatList, Pressable, RefreshControl, ActivityIndicator } from "react-native";
import { useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "@react-native-vector-icons/material-design-icons";
import { api } from "@/src/api";
import { colors, spacing, radius, typography, makeStyles } from "@/src/theme";
import { formatHM } from "@/src/format";

type TachoState = "DRIVING" | "WORK" | "REST" | "AVAILABLE";
type Evt = {
  id: string;
  state: TachoState;
  source: "GPS_AUTO" | "MANUAL" | "CARD";
  confirmed: boolean;
  started_at: string;
  ended_at: string | null;
  duration_s: number | null;
  speed_kmh?: number | null;
  note?: string | null;
};

const INFO: Record<TachoState, { label: string; color: string; icon: string }> = {
  DRIVING: { label: "Conducción", color: colors.brandPrimary, icon: "steering" },
  WORK: { label: "Trabajo", color: colors.info, icon: "wrench" },
  AVAILABLE: { label: "Disponible", color: colors.warning, icon: "clock-outline" },
  REST: { label: "Descanso", color: colors.success, icon: "bed-outline" },
};

const SOURCE: Record<Evt["source"], string> = {
  GPS_AUTO: "GPS",
  MANUAL: "Manual",
  CARD: "Tarjeta",
};

function toDate(s: string) {
  return new Date(s.endsWith("Z") || s.includes("+") ? s : s + "Z");
}

function fmtTime(s: string) {
  return toDate(s).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

export default function LogbookScreen() {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const [events, setEvents] = useState<Evt[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      setEvents(await api<Evt[]>("/tacho/events?limit=200"));
      setError(false);
    } catch {
      setError(true);
    }
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  async function confirm(id: string, state?: TachoState) {
    await api(`/tacho/events/${id}/confirm`, {
      method: "POST",
      body: JSON.stringify(state ? { state } : {}),
    });
    load();
  }

  const pending = events.filter((e) => !e.confirmed).length;

  const renderItem = ({ item }: { item: Evt }) => {
    const i = INFO[item.state];
    const dur =
      item.duration_s ?? Math.floor((Date.now() - toDate(item.started_at).getTime()) / 1000);
    return (
      <View style={styles.row} testID={`log-row-${item.id}`}>
        <View style={[styles.bar, { backgroundColor: i.color }]} />
        <View style={{ flex: 1 }}>
          <View style={styles.rowHead}>
            <Icon name={i.icon as any} size={18} color={i.color} />
            <Text style={[styles.state, { color: i.color }]}>{i.label}</Text>
            <View style={styles.srcTag}>
              <Text style={styles.srcText}>{SOURCE[item.source]}</Text>
            </View>
            {!item.ended_at && <Text style={styles.live}>EN CURSO</Text>}
          </View>
          <Text style={styles.time}>
            {toDate(item.started_at).toLocaleDateString("es-ES", { day: "2-digit", month: "short" })} ·{" "}
            {fmtTime(item.started_at)} – {item.ended_at ? fmtTime(item.ended_at) : "ahora"} · {formatHM(dur)}
          </Text>
          {item.note && <Text style={styles.note}>{item.note}</Text>}
          {!item.confirmed && (
            <View style={styles.confirmRow}>
              <Text style={styles.pendingText}>Detectado por GPS · ¿Correcto?</Text>
              <View style={styles.confirmBtns}>
                <Pressable
                  testID={`log-confirm-${item.id}`}
                  onPress={() => confirm(item.id)}
                  style={[styles.cBtn, { backgroundColor: colors.success }]}
                >
                  <Icon name="check" size={16} color={colors.onSuccess} />
                  <Text style={[styles.cBtnText, { color: colors.onSuccess }]}>Sí</Text>
                </Pressable>
                {(["WORK", "AVAILABLE", item.state === "DRIVING" ? "REST" : "DRIVING"] as TachoState[]).map((s) => (
                  <Pressable
                    key={s}
                    testID={`log-correct-${item.id}-${s}`}
                    onPress={() => confirm(item.id, s)}
                    style={styles.cBtn}
                  >
                    <Text style={styles.cBtnText}>{INFO[s].label}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          )}
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <Text style={styles.title}>Historial</Text>
        <Text style={styles.subtitle} testID="log-pending-count">
          {pending > 0 ? `${pending} registros GPS pendientes de confirmar` : "Todos los registros confirmados"}
        </Text>
      </View>
      {loading ? (
        <ActivityIndicator style={{ marginTop: spacing.xl }} color={colors.brandPrimary} />
      ) : error ? (
        <View style={styles.empty} testID="log-error">
          <Text style={styles.emptyText}>Error al cargar el historial</Text>
          <Pressable testID="log-retry" onPress={load} style={styles.retry}>
            <Text style={styles.retryText}>Reintentar</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          data={events}
          keyExtractor={(e) => e.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl, flexGrow: 1 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={colors.brandPrimary}
              onRefresh={async () => {
                setRefreshing(true);
                await load();
                setRefreshing(false);
              }}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty} testID="log-empty">
              <Icon name="notebook-outline" size={40} color={colors.muted} />
              <Text style={styles.emptyText}>Sin registros de conducción todavía</Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  container: { flex: 1, backgroundColor: c.surface },
  header: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: c.divider,
  },
  title: { color: c.onSurface, fontSize: typography.xxl, fontWeight: "800" },
  subtitle: { color: c.muted, fontSize: typography.sm, marginTop: 2 },
  row: {
    flexDirection: "row",
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.md,
    marginBottom: spacing.sm,
    overflow: "hidden",
  },
  bar: { width: 4 },
  rowHead: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
  state: { fontSize: typography.base, fontWeight: "800" },
  srcTag: {
    backgroundColor: c.surfaceTertiary,
    borderRadius: radius.sm,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  srcText: { color: c.onSurfaceTertiary, fontSize: 10, fontWeight: "700" },
  live: { color: c.brandPrimary, fontSize: 10, fontWeight: "900", letterSpacing: 1 },
  time: {
    color: c.onSurfaceTertiary,
    fontSize: typography.sm,
    paddingHorizontal: spacing.md,
    paddingTop: 4,
    paddingBottom: spacing.md,
    fontVariant: ["tabular-nums"],
  },
  note: { color: c.muted, fontSize: 11, paddingHorizontal: spacing.md, marginTop: -spacing.sm, paddingBottom: spacing.sm },
  confirmRow: {
    borderTopWidth: 1,
    borderTopColor: c.divider,
    padding: spacing.md,
    gap: spacing.sm,
  },
  pendingText: { color: c.warning, fontSize: typography.sm, fontWeight: "600" },
  confirmBtns: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  cBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    minHeight: 36,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: c.surfaceTertiary,
  },
  cBtnText: { color: c.onSurfaceSecondary, fontSize: typography.sm, fontWeight: "700" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: spacing.sm, padding: spacing.xl },
  emptyText: { color: c.onSurfaceTertiary, fontSize: typography.base },
  retry: { backgroundColor: c.brandPrimary, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: radius.md },
  retryText: { color: c.onBrandPrimary, fontWeight: "800" },
}));
