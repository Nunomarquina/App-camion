import { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  ActivityIndicator,
  Switch,
} from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "@react-native-vector-icons/material-design-icons";
import { api } from "@/src/api";
import { colors, spacing, radius, typography, makeStyles } from "@/src/theme";

type VType = "truck" | "bus" | "trailer" | "tanker";
type Vehicle = {
  id: string;
  name: string;
  plate?: string;
  vehicle_type: VType;
  length_m: number;
  width_m: number;
  height_m: number;
  weight_t: number;
  axles: number;
  max_speed_kmh: number;
  hazmat: boolean;
  is_active: boolean;
};

const TYPES: { key: VType; label: string; icon: string }[] = [
  { key: "truck", label: "Camión", icon: "truck" },
  { key: "trailer", label: "Tráiler", icon: "truck-trailer" },
  { key: "bus", label: "Autobús", icon: "bus" },
  { key: "tanker", label: "Cisterna", icon: "tanker-truck" },
];

const EMPTY = {
  name: "",
  plate: "",
  vehicle_type: "truck" as VType,
  length_m: "16.5",
  width_m: "2.55",
  height_m: "4.0",
  weight_t: "40",
  axles: "5",
  max_speed_kmh: "90",
  hazmat: false,
};

export default function VehicleScreen() {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      setVehicles(await api<Vehicle[]>("/vehicles"));
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function edit(v: Vehicle) {
    setEditingId(v.id);
    setForm({
      name: v.name,
      plate: v.plate || "",
      vehicle_type: v.vehicle_type,
      length_m: String(v.length_m),
      width_m: String(v.width_m),
      height_m: String(v.height_m),
      weight_t: String(v.weight_t),
      axles: String(v.axles),
      max_speed_kmh: String(v.max_speed_kmh),
      hazmat: v.hazmat,
    });
  }

  function reset() {
    setEditingId(null);
    setForm({ ...EMPTY });
  }

  async function save() {
    setMsg(null);
    if (!form.name.trim()) {
      setMsg({ text: "Introduce un nombre para el vehículo", ok: false });
      return;
    }
    const num = (s: string) => parseFloat(s.replace(",", "."));
    const body = {
      name: form.name.trim(),
      plate: form.plate.trim() || null,
      vehicle_type: form.vehicle_type,
      length_m: num(form.length_m),
      width_m: num(form.width_m),
      height_m: num(form.height_m),
      weight_t: num(form.weight_t),
      axles: parseInt(form.axles, 10),
      max_speed_kmh: parseInt(form.max_speed_kmh, 10),
      hazmat: form.hazmat,
    };
    if ([body.length_m, body.width_m, body.height_m, body.weight_t, body.axles, body.max_speed_kmh].some((n) => isNaN(n))) {
      setMsg({ text: "Revisa los valores numéricos", ok: false });
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        await api(`/vehicles/${editingId}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await api("/vehicles", { method: "POST", body: JSON.stringify(body) });
      }
      setMsg({ text: "Vehículo guardado", ok: true });
      reset();
      await load();
    } catch (e: any) {
      setMsg({ text: "Valores fuera de rango (máx. 30m largo, 5m ancho, 6m alto, 80t)", ok: false });
    } finally {
      setSaving(false);
    }
  }

  async function activate(id: string) {
    await api(`/vehicles/${id}/activate`, { method: "POST" });
    load();
  }

  async function remove(id: string) {
    await api(`/vehicles/${id}`, { method: "DELETE" });
    if (editingId === id) reset();
    load();
  }

  const field = (key: keyof typeof EMPTY, label: string, unit: string) => (
    <View style={styles.numField}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.numInputRow}>
        <TextInput
          testID={`vehicle-${key}`}
          style={styles.numInput}
          value={String(form[key])}
          onChangeText={(t) => setForm((f) => ({ ...f, [key]: t }))}
          keyboardType="decimal-pad"
          placeholderTextColor={colors.muted}
        />
        <Text style={styles.unit}>{unit}</Text>
      </View>
    </View>
  );

  return (
    <View style={styles.container}>
      <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
        <Text style={styles.title}>Vehículos</Text>
        <Text style={styles.subtitle}>Dimensiones para rutas seguras</Text>
      </View>
      <KeyboardAwareScrollView
        bottomOffset={24}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xl }}
        keyboardShouldPersistTaps="handled"
      >
        {loading ? (
          <ActivityIndicator color={colors.brandPrimary} />
        ) : vehicles.length === 0 ? (
          <View style={styles.empty} testID="vehicles-empty">
            <Icon name="truck-alert-outline" size={40} color={colors.muted} />
            <Text style={styles.emptyText}>Sin vehículo activo. Crea uno abajo.</Text>
          </View>
        ) : (
          vehicles.map((v) => (
            <View
              key={v.id}
              style={[styles.vCard, v.is_active && { borderColor: colors.brandPrimary }]}
              testID={`vehicle-card-${v.id}`}
            >
              <Pressable style={styles.vMain} onPress={() => edit(v)} testID={`vehicle-edit-${v.id}`}>
                <Icon
                  name={(TYPES.find((t) => t.key === v.vehicle_type)?.icon || "truck") as any}
                  size={28}
                  color={v.is_active ? colors.brandPrimary : colors.onSurfaceTertiary}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.vName}>{v.name}{v.plate ? ` · ${v.plate}` : ""}</Text>
                  <Text style={styles.vDims}>
                    {v.length_m}m × {v.width_m}m × {v.height_m}m · {v.weight_t}t · {v.axles} ejes
                    {v.hazmat ? " · ADR" : ""}
                  </Text>
                </View>
              </Pressable>
              <View style={styles.vActions}>
                {v.is_active ? (
                  <Text style={styles.activeTag}>ACTIVO</Text>
                ) : (
                  <Pressable testID={`vehicle-activate-${v.id}`} onPress={() => activate(v.id)} style={styles.smallBtn}>
                    <Text style={styles.smallBtnText}>Activar</Text>
                  </Pressable>
                )}
                <Pressable testID={`vehicle-delete-${v.id}`} onPress={() => remove(v.id)} hitSlop={8} style={styles.iconBtn}>
                  <Icon name="trash-can-outline" size={20} color={colors.error} />
                </Pressable>
              </View>
            </View>
          ))
        )}

        <Text style={styles.section}>{editingId ? "EDITAR VEHÍCULO" : "NUEVO VEHÍCULO"}</Text>

        <View style={styles.typeRow}>
          {TYPES.map((t) => {
            const active = form.vehicle_type === t.key;
            return (
              <Pressable
                key={t.key}
                testID={`vehicle-type-${t.key}`}
                onPress={() => setForm((f) => ({ ...f, vehicle_type: t.key }))}
                style={[styles.typeBtn, active && styles.typeBtnActive]}
              >
                <Icon name={t.icon as any} size={22} color={active ? colors.brandPrimary : colors.onSurfaceTertiary} />
                <Text style={[styles.typeText, active && { color: colors.brandPrimary }]}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.label}>Nombre</Text>
        <TextInput
          testID="vehicle-name"
          style={styles.input}
          value={form.name}
          onChangeText={(t) => setForm((f) => ({ ...f, name: t }))}
          placeholder="Volvo FH 500"
          placeholderTextColor={colors.muted}
        />
        <Text style={styles.label}>Matrícula</Text>
        <TextInput
          testID="vehicle-plate"
          style={styles.input}
          value={form.plate}
          onChangeText={(t) => setForm((f) => ({ ...f, plate: t }))}
          placeholder="1234 ABC"
          placeholderTextColor={colors.muted}
          autoCapitalize="characters"
        />

        <View style={styles.grid}>
          {field("length_m", "Longitud", "m")}
          {field("width_m", "Anchura", "m")}
          {field("height_m", "Altura", "m")}
          {field("weight_t", "Peso total", "t")}
          {field("axles", "Ejes", "")}
          {field("max_speed_kmh", "Vel. máx.", "km/h")}
        </View>

        <View style={styles.hazRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.hazTitle}>Mercancías peligrosas (ADR)</Text>
            <Text style={styles.hazSub}>Evita túneles restringidos y centros urbanos</Text>
          </View>
          <Switch
            testID="vehicle-hazmat"
            value={form.hazmat}
            onValueChange={(v) => setForm((f) => ({ ...f, hazmat: v }))}
            trackColor={{ true: colors.brandPrimary, false: colors.surfaceTertiary }}
            thumbColor={colors.onSurface}
          />
        </View>

        {msg && (
          <Text testID="vehicle-msg" style={[styles.msg, { color: msg.ok ? colors.success : colors.error }]}>
            {msg.text}
          </Text>
        )}

        <Pressable
          testID="vehicle-save-btn"
          onPress={save}
          disabled={saving}
          style={({ pressed }) => [styles.saveBtn, pressed && { opacity: 0.85 }]}
        >
          {saving ? (
            <ActivityIndicator color={colors.onBrandPrimary} />
          ) : (
            <Text style={styles.saveText}>{editingId ? "GUARDAR CAMBIOS" : "GUARDAR VEHÍCULO"}</Text>
          )}
        </Pressable>
        {editingId && (
          <Pressable testID="vehicle-cancel-edit" onPress={reset} style={styles.cancelBtn}>
            <Text style={styles.cancelText}>Cancelar edición</Text>
          </Pressable>
        )}
      </KeyboardAwareScrollView>
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
    backgroundColor: c.surface,
  },
  title: { color: c.onSurface, fontSize: typography.xxl, fontWeight: "800" },
  subtitle: { color: c.muted, fontSize: typography.sm, marginTop: 2 },
  empty: {
    alignItems: "center",
    padding: spacing.xl,
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.lg,
    gap: spacing.sm,
  },
  emptyText: { color: c.onSurfaceTertiary, fontSize: typography.base },
  vCard: {
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: c.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
  },
  vMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: spacing.md },
  vName: { color: c.onSurface, fontSize: typography.lg, fontWeight: "700" },
  vDims: { color: c.onSurfaceTertiary, fontSize: typography.sm, marginTop: 2 },
  vActions: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  activeTag: { color: c.brandPrimary, fontSize: 11, fontWeight: "900", letterSpacing: 1 },
  smallBtn: {
    backgroundColor: c.surfaceTertiary,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    minHeight: 36,
    justifyContent: "center",
  },
  smallBtnText: { color: c.onSurfaceSecondary, fontSize: typography.sm, fontWeight: "700" },
  iconBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  section: {
    color: c.muted,
    fontSize: typography.sm,
    letterSpacing: 1.5,
    fontWeight: "700",
    marginTop: spacing.xl,
    marginBottom: spacing.md,
  },
  typeRow: { flexDirection: "row", gap: spacing.sm, marginBottom: spacing.lg },
  typeBtn: {
    flex: 1,
    alignItems: "center",
    paddingVertical: spacing.md,
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: c.border,
    gap: 4,
  },
  typeBtnActive: { borderColor: c.brandPrimary },
  typeText: { color: c.onSurfaceTertiary, fontSize: 11, fontWeight: "700" },
  label: {
    color: c.onSurfaceTertiary,
    fontSize: typography.sm,
    letterSpacing: 1,
    textTransform: "uppercase",
    fontWeight: "600",
    marginBottom: spacing.xs,
  },
  input: {
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    color: c.onSurface,
    fontSize: typography.lg,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    marginBottom: spacing.lg,
  },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between" },
  numField: { width: "48%", marginBottom: spacing.lg },
  numInputRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: spacing.md,
  },
  numInput: {
    flex: 1,
    color: c.onSurface,
    fontSize: typography.xl,
    fontWeight: "700",
    paddingVertical: spacing.md,
  },
  unit: { color: c.muted, fontSize: typography.sm, fontWeight: "700" },
  hazRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.md,
    padding: spacing.lg,
    gap: spacing.md,
  },
  hazTitle: { color: c.onSurface, fontSize: typography.base, fontWeight: "700" },
  hazSub: { color: c.muted, fontSize: typography.sm, marginTop: 2 },
  msg: { textAlign: "center", marginTop: spacing.md, fontSize: typography.base },
  saveBtn: {
    backgroundColor: c.brandPrimary,
    borderRadius: radius.md,
    paddingVertical: spacing.lg,
    alignItems: "center",
    marginTop: spacing.lg,
  },
  saveText: { color: c.onBrandPrimary, fontSize: typography.lg, fontWeight: "800", letterSpacing: 1 },
  cancelBtn: { alignItems: "center", paddingVertical: spacing.md },
  cancelText: { color: c.muted, fontSize: typography.base },
}));
