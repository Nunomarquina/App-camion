import { useEffect, useState } from "react";
import { View, Text, Pressable, Switch, ScrollView, Platform, Linking } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Location from "expo-location";
import Icon from "@react-native-vector-icons/material-design-icons";
import { BREAK_WARNING_OPTIONS, useBreakWarnings } from "@/src/settings";
import { backgroundSupported } from "@/src/background-nav";
import { colors, spacing, radius, typography, makeStyles } from "@/src/theme";

export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const styles = useStyles();
  const { value, update } = useBreakWarnings();
  const [bgStatus, setBgStatus] = useState<"granted" | "denied" | "blocked" | "undetermined" | "unsupported">("undetermined");

  useEffect(() => {
    if (!backgroundSupported()) {
      setBgStatus("unsupported");
      return;
    }
    Location.getBackgroundPermissionsAsync().then((p) =>
      setBgStatus(p.status === "granted" ? "granted" : p.canAskAgain ? (p.status === "denied" ? "denied" : "undetermined") : "blocked"),
    );
  }, []);

  async function enableBackground() {
    if (bgStatus === "blocked") {
      Linking.openSettings();
      return;
    }
    let fg = await Location.getForegroundPermissionsAsync();
    if (fg.status !== "granted") fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== "granted") {
      setBgStatus(fg.canAskAgain ? "denied" : "blocked");
      return;
    }
    const bg = await Location.requestBackgroundPermissionsAsync();
    setBgStatus(bg.status === "granted" ? "granted" : bg.canAskAgain ? "denied" : "blocked");
  }

  const bgText = {
    granted: "Activado: la guía sigue con la pantalla bloqueada",
    denied: "Permiso denegado. Pulsa para volver a pedirlo",
    blocked: "Bloqueado. Actívalo como «Permitir siempre» en Ajustes",
    undetermined: "Requiere ubicación «Permitir siempre»",
    unsupported: Platform.OS === "web" ? "Solo en la app móvil" : "Requiere la app instalada (no funciona en Expo Go)",
  }[bgStatus];

  return (
    <View style={styles.container} testID="settings-screen">
      <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
        <Pressable testID="settings-back-btn" onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)/tacho"))} style={styles.backBtn}>
          <Icon name="arrow-left" size={24} color={colors.onSurface} />
        </Pressable>
        <Text style={styles.title}>Ajustes</Text>
      </View>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xl }}>
        <Text style={styles.section}>AVISOS DE PAUSA POR VOZ</Text>
        <Text style={styles.help}>
          Durante la navegación, la voz avisa antes de cada pausa obligatoria y te dice el área de descanso más cercana.
        </Text>
        {BREAK_WARNING_OPTIONS.map((m) => (
          <View key={m} style={styles.row} testID={`break-warning-row-${m}`}>
            <Icon name="coffee-outline" size={22} color={value[m] ? colors.brandPrimary : colors.muted} />
            <Text style={styles.rowText}>Avisar {m} minutos antes</Text>
            <Switch
              testID={`break-warning-switch-${m}`}
              value={value[m]}
              onValueChange={(on) => update(m, on)}
              trackColor={{ true: colors.brandPrimary, false: colors.surfaceTertiary }}
              thumbColor={colors.onSurface}
            />
          </View>
        ))}

        <Text style={[styles.section, { marginTop: spacing.xl }]}>NAVEGACIÓN EN SEGUNDO PLANO</Text>
        <Pressable
          testID="background-location-btn"
          onPress={enableBackground}
          disabled={bgStatus === "granted" || bgStatus === "unsupported"}
          style={styles.row}
        >
          <Icon name="cellphone-lock" size={22} color={bgStatus === "granted" ? colors.success : colors.muted} />
          <View style={{ flex: 1 }}>
            <Text style={styles.rowText}>Guía con pantalla bloqueada</Text>
            <Text style={styles.sub} testID="background-location-status">{bgText}</Text>
          </View>
          {bgStatus !== "granted" && bgStatus !== "unsupported" && (
            <Text style={styles.action}>{bgStatus === "blocked" ? "Ajustes" : "Activar"}</Text>
          )}
        </Pressable>
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  container: { flex: 1, backgroundColor: c.surface },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: c.divider,
  },
  backBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  title: { color: c.onSurface, fontSize: typography.xxl, fontWeight: "800" },
  section: { color: c.muted, fontSize: typography.sm, fontWeight: "700", letterSpacing: 1.5, marginBottom: spacing.sm },
  help: { color: c.onSurfaceTertiary, fontSize: typography.sm, marginBottom: spacing.md },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.sm,
    minHeight: 56,
  },
  rowText: { flex: 1, color: c.onSurface, fontSize: typography.base, fontWeight: "700" },
  sub: { color: c.muted, fontSize: typography.sm, marginTop: 2 },
  action: { color: c.brandPrimary, fontWeight: "800", fontSize: typography.sm },
}));
