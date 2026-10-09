import { Modal, View, Text, Pressable, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Icon from "@react-native-vector-icons/material-design-icons";
import { colors, spacing, radius, typography, makeStyles } from "@/src/theme";

export type CardReport = {
  card_is_real: boolean;
  card_activities: number;
  gps_events_compared: number;
  accuracy: number | null;
  false_switches: number;
  avg_lag_s: number | null;
  corrections: number;
  verified: number;
  samples_used: number;
  sample_accuracy: number | null;
  threshold_before: number;
  threshold_after: number;
  hold_before: number;
  hold_after: number;
  tips: string[];
};

export function CardReportSheet({
  visible,
  onClose,
  report,
  message,
}: {
  visible: boolean;
  onClose: () => void;
  report: CardReport | null;
  message: string | null;
}) {
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const acc = report?.accuracy;
  const accColor =
    acc == null ? colors.muted : acc >= 0.9 ? colors.success : acc >= 0.7 ? colors.warning : colors.error;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} testID="card-report-backdrop" />
      <View style={styles.wrap}>
        <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]} testID="card-report-sheet">
          <View style={styles.handle} />
          <View style={styles.headRow}>
            <Text style={styles.title}>Tarjeta vs GPS</Text>
            <Pressable onPress={onClose} hitSlop={10} testID="card-report-close">
              <Icon name="close" size={24} color={colors.muted} />
            </Pressable>
          </View>
          {report && (
            <ScrollView style={{ maxHeight: 480 }}>
              <Text style={styles.source} testID="card-report-source">
                {report.card_is_real
                  ? `Datos de tarjeta: ${report.card_activities} actividades`
                  : "Tarjeta simulada (referencia: tus confirmaciones)"}
              </Text>
              <View style={styles.accBox}>
                <Text style={styles.accLabel}>PRECISIÓN DE LA DETECCIÓN GPS</Text>
                <Text style={[styles.accValue, { color: accColor }]} testID="card-report-accuracy">
                  {acc == null ? "—" : `${Math.round(acc * 100)}%`}
                </Text>
                <Text style={styles.accSub}>{report.gps_events_compared} detecciones GPS comparadas</Text>
              </View>
              <View style={styles.grid}>
                <Cell label="Corregidos" value={String(report.corrections)} testID="card-report-corrections" />
                <Cell label="Verificados" value={String(report.verified)} testID="card-report-verified" />
                <Cell label="Cambios falsos" value={String(report.false_switches)} testID="card-report-false" />
                <Cell
                  label="Retraso medio"
                  value={report.avg_lag_s == null ? "—" : `${Math.round(report.avg_lag_s)}s`}
                  testID="card-report-lag"
                />
              </View>
              <Text style={styles.section}>PARÁMETROS APRENDIDOS</Text>
              <ParamRow
                label="Umbral de movimiento"
                before={`${report.threshold_before} km/h`}
                after={`${report.threshold_after} km/h`}
                testID="card-report-threshold"
              />
              <ParamRow
                label="Tiempo de confirmación"
                before={`${report.hold_before}s`}
                after={`${report.hold_after}s`}
                testID="card-report-hold"
              />
              <Text style={styles.samples}>{report.samples_used} lecturas de velocidad usadas</Text>
              {report.tips.map((t, i) => (
                <View key={i} style={styles.tip} testID={`card-report-tip-${i}`}>
                  <Icon name="lightbulb-on-outline" size={16} color={colors.brandPrimary} />
                  <Text style={styles.tipText}>{t}</Text>
                </View>
              ))}
            </ScrollView>
          )}
          {!report && message && <Text style={styles.tipText}>{message}</Text>}
        </View>
      </View>
    </Modal>
  );
}

function Cell({ label, value, testID }: { label: string; value: string; testID: string }) {
  const styles = useStyles();
  return (
    <View style={styles.cell} testID={testID}>
      <Text style={styles.cellLabel}>{label}</Text>
      <Text style={styles.cellValue}>{value}</Text>
    </View>
  );
}

function ParamRow({ label, before, after, testID }: { label: string; before: string; after: string; testID: string }) {
  const styles = useStyles();
  const changed = before !== after;
  return (
    <View style={styles.param} testID={testID}>
      <Text style={styles.paramLabel}>{label}</Text>
      <Text style={styles.paramBefore}>{before}</Text>
      <Icon name="arrow-right" size={14} color={colors.muted} />
      <Text style={[styles.paramAfter, changed && { color: colors.brandPrimary }]}>{after}</Text>
    </View>
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
  headRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: spacing.md },
  title: { color: c.onSurface, fontSize: typography.xl, fontWeight: "800" },
  source: { color: c.muted, fontSize: typography.sm, marginBottom: spacing.md },
  accBox: { backgroundColor: c.surfaceTertiary, borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.md },
  accLabel: { color: c.muted, fontSize: 10, fontWeight: "700", letterSpacing: 1 },
  accValue: { fontSize: 44, fontWeight: "900" },
  accSub: { color: c.onSurfaceTertiary, fontSize: typography.sm },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  cell: { width: "48%", backgroundColor: c.surfaceTertiary, borderRadius: radius.md, padding: spacing.md },
  cellLabel: { color: c.muted, fontSize: 11, fontWeight: "700" },
  cellValue: { color: c.onSurface, fontSize: typography.xl, fontWeight: "800", marginTop: 2 },
  section: { color: c.muted, fontSize: typography.sm, fontWeight: "700", letterSpacing: 1.5, marginTop: spacing.lg, marginBottom: spacing.sm },
  param: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.divider,
  },
  paramLabel: { color: c.onSurfaceSecondary, fontSize: typography.base, flex: 1 },
  paramBefore: { color: c.muted, fontSize: typography.sm },
  paramAfter: { color: c.onSurface, fontSize: typography.base, fontWeight: "800" },
  samples: { color: c.muted, fontSize: 11, marginTop: spacing.sm, marginBottom: spacing.sm },
  tip: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-start", paddingVertical: spacing.xs },
  tipText: { color: c.onSurfaceSecondary, fontSize: typography.sm, flex: 1 },
}));
