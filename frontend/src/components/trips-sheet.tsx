import { useCallback, useEffect, useState } from "react";
import { Modal, View, Text, Pressable, ScrollView, TextInput, ActivityIndicator } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "@react-native-vector-icons/material-design-icons";
import { api } from "@/src/api";
import { formatHM } from "@/src/format";
import { colors, spacing, radius, typography, makeStyles } from "@/src/theme";

export type Trip = {
  id: string;
  origin: { lat: number; lng: number };
  origin_name: string;
  destination: { lat: number; lng: number };
  destination_name: string;
  distance_km: number;
  estimate_s: number;
  base_estimate_s: number;
  weight_t: number | null;
  status: "in_progress" | "arrived" | "cancelled";
  actual_s: number | null;
  actual_source: "gps" | "manual" | null;
  simulated: boolean;
  created_at: string;
  valid_for_learning: boolean;
  ratio?: number;
};
export type Pace = { factor: number; trips_used: number };

function parseHM(s: string): number | null {
  const m = s.trim().match(/^(\d{1,2})\s*[:h.,]\s*(\d{1,2})\s*m?$/i) || s.trim().match(/^(\d{1,2})\s*h?$/i);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (min > 59) return null;
  const sec = h * 3600 + min * 60;
  return sec > 0 ? sec : null;
}

export function paceLabel(p: Pace | null) {
  if (!p || p.trips_used === 0) return "Aún sin viajes para aprender tu ritmo";
  const pct = Math.round((p.factor - 1) * 100);
  return `Tu ritmo: ${pct === 0 ? "igual que" : pct > 0 ? `+${pct}% sobre` : `${pct}% bajo`} el estimado (${p.trips_used} viaje${p.trips_used > 1 ? "s" : ""})`;
}

export function TripsSheet({
  visible,
  onClose,
  onRepeat,
}: {
  visible: boolean;
  onClose: () => void;
  onRepeat: (t: Trip) => void;
}) {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [pace, setPace] = useState<Pace | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [actualText, setActualText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{ trips: Trip[]; pace: Pace }>("/trips");
      setTrips(r.trips);
      setPace(r.pace);
    } catch (e: any) {
      setError(e.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (visible) load();
  }, [visible, load]);

  async function saveActual(id: string) {
    const s = parseHM(actualText);
    if (!s) {
      setError("Formato: 4:15 o 4h15");
      return;
    }
    setError(null);
    try {
      const r = await api<{ pace: Pace }>(`/trips/${id}/actual`, {
        method: "PATCH",
        body: JSON.stringify({ actual_s: s }),
      });
      setPace(r.pace);
      setEditing(null);
      setActualText("");
      load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function remove(id: string) {
    await api(`/trips/${id}`, { method: "DELETE" }).catch(() => {});
    load();
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} testID="trips-backdrop" />
      <View style={styles.wrap}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]} testID="trips-sheet">
          <View style={styles.handle} />
          <View style={styles.headRow}>
            <Text style={styles.title}>Rutas anteriores</Text>
            <Pressable onPress={onClose} hitSlop={10} testID="trips-close">
              <Icon name="close" size={24} color={colors.muted} />
            </Pressable>
          </View>
          <Text style={styles.pace} testID="trips-pace">{paceLabel(pace)}</Text>
          {error && <Text style={styles.error} testID="trips-error">{error}</Text>}
          {loading && trips.length === 0 ? (
            <ActivityIndicator color={colors.brandPrimary} style={{ marginVertical: spacing.xl }} />
          ) : trips.length === 0 ? (
            <Text style={styles.empty} testID="trips-empty">Aún no hay rutas. Inicia una ruta para guardarla.</Text>
          ) : (
            <ScrollView style={{ maxHeight: 460 }} keyboardShouldPersistTaps="handled">
              {trips.map((t, i) => (
                <View key={t.id} style={styles.card} testID={`trip-card-${i}`}>
                  <View style={styles.cardHead}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.route} numberOfLines={1}>
                        {t.origin_name} → {t.destination_name}
                      </Text>
                      <Text style={styles.meta}>
                        {new Date(t.created_at.endsWith("Z") || t.created_at.includes("+") ? t.created_at : t.created_at + "Z").toLocaleDateString("es-ES", { day: "2-digit", month: "short" })}
                        {" · "}{Math.round(t.distance_km)} km{t.weight_t ? ` · ${t.weight_t} t` : ""}
                        {t.simulated ? " · simulada" : ""}
                      </Text>
                    </View>
                    <Pressable testID={`trip-delete-${i}`} onPress={() => remove(t.id)} hitSlop={8} style={styles.iconBtn}>
                      <Icon name="trash-can-outline" size={18} color={colors.muted} />
                    </Pressable>
                  </View>
                  <View style={styles.times}>
                    <Text style={styles.timeText}>Estimado {formatHM(t.base_estimate_s)}</Text>
                    <Text style={[styles.timeText, t.actual_s ? { color: colors.success } : null]} testID={`trip-actual-${i}`}>
                      Real {t.actual_s ? formatHM(t.actual_s) : "—"}
                      {t.actual_source === "manual" ? " (manual)" : t.actual_source === "gps" ? " (GPS)" : ""}
                    </Text>
                  </View>
                  {editing === t.id ? (
                    <View style={styles.editRow}>
                      <TextInput
                        testID={`trip-actual-input-${i}`}
                        style={styles.input}
                        value={actualText}
                        onChangeText={setActualText}
                        placeholder="4:15"
                        placeholderTextColor={colors.muted}
                        keyboardType="numbers-and-punctuation"
                        autoFocus
                      />
                      <Pressable testID={`trip-actual-save-${i}`} onPress={() => saveActual(t.id)} style={styles.smallPrimary}>
                        <Text style={styles.smallPrimaryText}>Guardar</Text>
                      </Pressable>
                    </View>
                  ) : (
                    <View style={styles.actions}>
                      <Pressable
                        testID={`trip-edit-actual-${i}`}
                        onPress={() => {
                          setEditing(t.id);
                          setActualText("");
                        }}
                        style={styles.smallBtn}
                      >
                        <Icon name="timer-edit-outline" size={16} color={colors.onSurface} />
                        <Text style={styles.smallText}>{t.actual_s ? "Corregir tiempo" : "Tiempo real"}</Text>
                      </Pressable>
                      <Pressable testID={`trip-repeat-${i}`} onPress={() => onRepeat(t)} style={styles.smallPrimary}>
                        <Icon name="replay" size={16} color={colors.onBrandPrimary} />
                        <Text style={styles.smallPrimaryText}>Repetir ruta</Text>
                      </Pressable>
                    </View>
                  )}
                </View>
              ))}
            </ScrollView>
          )}
        </View>
      </View>
    </Modal>
  );
}

const useStyles = makeStyles((c) => ({
  backdrop: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: "rgba(0,0,0,0.6)" },
  wrap: { flex: 1, justifyContent: "flex-end" },
  sheet: {
    backgroundColor: c.surfaceSecondary,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  handle: { width: 48, height: 4, borderRadius: radius.pill, backgroundColor: c.borderStrong, alignSelf: "center", marginBottom: spacing.md },
  headRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { color: c.onSurface, fontSize: typography.xl, fontWeight: "800" },
  pace: { color: c.brandPrimary, fontSize: typography.sm, fontWeight: "700", marginVertical: spacing.sm },
  error: { color: c.error, fontSize: typography.sm, marginBottom: spacing.sm },
  empty: { color: c.muted, fontSize: typography.base, marginVertical: spacing.xl, textAlign: "center" },
  card: { backgroundColor: c.surfaceTertiary, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm, gap: spacing.sm },
  cardHead: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  route: { color: c.onSurface, fontSize: typography.base, fontWeight: "800" },
  meta: { color: c.muted, fontSize: 11, marginTop: 2 },
  iconBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  times: { flexDirection: "row", justifyContent: "space-between" },
  timeText: { color: c.onSurfaceSecondary, fontSize: typography.sm, fontWeight: "700" },
  actions: { flexDirection: "row", gap: spacing.sm },
  editRow: { flexDirection: "row", gap: spacing.sm, alignItems: "center" },
  input: {
    flex: 1,
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    color: c.onSurface,
    fontSize: typography.lg,
    fontWeight: "700",
    paddingHorizontal: spacing.md,
    minHeight: 40,
  },
  smallBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    minHeight: 40,
    borderRadius: radius.sm,
    backgroundColor: c.surfaceSecondary,
  },
  smallText: { color: c.onSurface, fontSize: typography.sm, fontWeight: "700" },
  smallPrimary: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: c.brandPrimary,
  },
  smallPrimaryText: { color: c.onBrandPrimary, fontSize: typography.sm, fontWeight: "800" },
}));
