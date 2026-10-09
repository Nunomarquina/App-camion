import { useState } from "react";
import { Modal, View, Text, TextInput, Pressable, ActivityIndicator, Platform, Switch } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "@react-native-vector-icons/material-design-icons";
import { api } from "@/src/api";
import { colors, spacing, radius, typography, makeStyles } from "@/src/theme";

type TachoState = "DRIVING" | "WORK" | "REST" | "AVAILABLE";
const STATES: { key: TachoState; label: string; color: string }[] = [
  { key: "DRIVING", label: "Conducción", color: colors.brandPrimary },
  { key: "WORK", label: "Trabajo", color: colors.info },
  { key: "AVAILABLE", label: "Disponible", color: colors.warning },
  { key: "REST", label: "Descanso", color: colors.success },
];

export function ManualEntrySheet({
  visible,
  onClose,
  onSaved,
}: {
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const [state, setState] = useState<TachoState>("DRIVING");
  const [hoursAgo, setHoursAgo] = useState("5");
  const [minutes, setMinutes] = useState("120");
  const [saving, setSaving] = useState(false);
  const [asCard, setAsCard] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    const h = parseFloat(hoursAgo.replace(",", "."));
    const m = parseFloat(minutes.replace(",", "."));
    if (isNaN(h) || isNaN(m) || m <= 0 || h <= 0) {
      setError("Introduce valores válidos");
      return;
    }
    if (m / 60 > h) {
      setError("La duración no puede terminar en el futuro");
      return;
    }
    const start = new Date(Date.now() - h * 3600 * 1000);
    const end = new Date(start.getTime() + m * 60 * 1000);
    setSaving(true);
    try {
      if (asCard) {
        await api("/tacho/card-activities", {
          method: "POST",
          body: JSON.stringify({
            activities: [{ state, started_at: start.toISOString(), ended_at: end.toISOString() }],
          }),
        });
      } else {
        await api("/tacho/events/manual", {
          method: "POST",
          body: JSON.stringify({
            state,
            started_at: start.toISOString(),
            ended_at: end.toISOString(),
            note: "Entrada simulada",
          }),
        });
      }
      onSaved();
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} testID="manual-entry-backdrop" />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.kav}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]} testID="manual-entry-sheet">
          <View style={styles.handle} />
          <View style={styles.headRow}>
            <Text style={styles.title}>Simular entrada de tacógrafo</Text>
            <Pressable onPress={onClose} hitSlop={10} testID="manual-entry-close">
              <Icon name="close" size={24} color={colors.muted} />
            </Pressable>
          </View>
          <Text style={styles.label}>Actividad</Text>
          <View style={styles.stateRow}>
            {STATES.map((s) => (
              <Pressable
                key={s.key}
                testID={`manual-state-${s.key}`}
                onPress={() => setState(s.key)}
                style={[styles.stateChip, state === s.key && { borderColor: s.color, backgroundColor: s.color + "22" }]}
              >
                <Text style={[styles.stateText, state === s.key && { color: s.color }]}>{s.label}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.fieldRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Empezó hace (horas)</Text>
              <TextInput
                testID="manual-hours-ago"
                style={styles.input}
                value={hoursAgo}
                onChangeText={setHoursAgo}
                keyboardType="decimal-pad"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Duración (min)</Text>
              <TextInput
                testID="manual-duration"
                style={styles.input}
                value={minutes}
                onChangeText={setMinutes}
                keyboardType="decimal-pad"
              />
            </View>
          </View>
          <View style={styles.presetRow}>
            {[15, 30, 45, 270].map((p) => (
              <Pressable key={p} testID={`manual-preset-${p}`} onPress={() => setMinutes(String(p))} style={styles.preset}>
                <Text style={styles.presetText}>{p >= 60 ? `${p / 60}h` : `${p}m`}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.cardRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardTitle}>Registrar como dato de tarjeta</Text>
              <Text style={styles.cardSub}>
                Referencia para comparar con el GPS al leer la tarjeta (no cambia tu historial)
              </Text>
            </View>
            <Switch
              testID="manual-as-card-switch"
              value={asCard}
              onValueChange={setAsCard}
              trackColor={{ true: colors.brandPrimary, false: colors.surfaceTertiary }}
              thumbColor={colors.onSurface}
            />
          </View>
          {error && <Text style={styles.error} testID="manual-entry-error">{error}</Text>}
          <Pressable testID="manual-entry-save" onPress={save} disabled={saving} style={styles.save}>
            {saving ? <ActivityIndicator color={colors.onBrandPrimary} /> : <Text style={styles.saveText}>AÑADIR ENTRADA</Text>}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const useStyles = makeStyles((c) => ({
  backdrop: { ...({ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 } as const), backgroundColor: "rgba(0,0,0,0.6)" },
  kav: { flex: 1, justifyContent: "flex-end" },
  sheet: {
    backgroundColor: c.surfaceSecondary,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: c.border,
  },
  handle: { width: 48, height: 4, borderRadius: radius.pill, backgroundColor: c.borderStrong, alignSelf: "center", marginBottom: spacing.md },
  headRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.lg },
  title: { color: c.onSurface, fontSize: typography.xl, fontWeight: "800" },
  label: { color: c.onSurfaceTertiary, fontSize: typography.sm, fontWeight: "600", marginBottom: spacing.xs, letterSpacing: 0.5 },
  stateRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginBottom: spacing.lg },
  stateChip: {
    borderWidth: 1.5,
    borderColor: c.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    minHeight: 40,
    justifyContent: "center",
    backgroundColor: c.surfaceTertiary,
  },
  stateText: { color: c.onSurfaceTertiary, fontSize: typography.sm, fontWeight: "700" },
  fieldRow: { flexDirection: "row", gap: spacing.md },
  input: {
    backgroundColor: c.surfaceTertiary,
    borderRadius: radius.md,
    color: c.onSurface,
    fontSize: typography.xl,
    fontWeight: "700",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderWidth: 1,
    borderColor: c.border,
  },
  presetRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  preset: { flex: 1, minHeight: 40, borderRadius: radius.md, backgroundColor: c.surfaceTertiary, alignItems: "center", justifyContent: "center" },
  presetText: { color: c.onSurfaceSecondary, fontWeight: "700", fontSize: typography.sm },
  error: { color: c.error, marginTop: spacing.md, fontSize: typography.sm },
  cardRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, marginTop: spacing.lg },
  cardTitle: { color: c.onSurface, fontSize: typography.base, fontWeight: "700" },
  cardSub: { color: c.muted, fontSize: 11, marginTop: 2 },
  save: { backgroundColor: c.brandPrimary, borderRadius: radius.md, paddingVertical: spacing.lg, alignItems: "center", marginTop: spacing.lg },
  saveText: { color: c.onBrandPrimary, fontWeight: "800", fontSize: typography.lg, letterSpacing: 1 },
}));
