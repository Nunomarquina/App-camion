import { useState } from "react";
import {
  View,
  Text,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "@/src/auth-context";
import { colors, spacing, radius, typography, makeStyles } from "@/src/theme";

export default function AuthScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { login, register } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const styles = useStyles();

  async function submit() {
    setError("");
    if (!email.trim() || !password) {
      setError("Email y contraseña son obligatorios");
      return;
    }
    if (mode === "register" && !name.trim()) {
      setError("Introduce tu nombre");
      return;
    }
    setSubmitting(true);
    try {
      if (mode === "login") {
        await login(email.trim(), password);
      } else {
        await register(email.trim(), password, name.trim());
      }
      router.replace("/(tabs)/tacho");
    } catch (e: any) {
      setError(e.message || "Error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={{ flex: 1, backgroundColor: colors.surface }}
    >
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + spacing.xxl, paddingBottom: insets.bottom + spacing.xxl },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.header}>
          <View style={styles.logoBadge}>
            <Text style={styles.logoText}>TNP</Text>
          </View>
          <Text style={styles.title}>TruckNav Pro</Text>
          <Text style={styles.subtitle}>
            Navegación y tacógrafo digital para vehículos pesados
          </Text>
        </View>

        <View style={styles.tabRow}>
          <Pressable
            testID="auth-tab-login"
            style={[styles.tab, mode === "login" && styles.tabActive]}
            onPress={() => {
              setMode("login");
              setError("");
            }}
          >
            <Text style={[styles.tabText, mode === "login" && styles.tabTextActive]}>
              Entrar
            </Text>
          </Pressable>
          <Pressable
            testID="auth-tab-register"
            style={[styles.tab, mode === "register" && styles.tabActive]}
            onPress={() => {
              setMode("register");
              setError("");
            }}
          >
            <Text style={[styles.tabText, mode === "register" && styles.tabTextActive]}>
              Registro
            </Text>
          </Pressable>
        </View>

        {mode === "register" && (
          <View style={styles.field}>
            <Text style={styles.label}>Nombre del conductor</Text>
            <TextInput
              testID="auth-name"
              value={name}
              onChangeText={setName}
              placeholder="Juan Pérez"
              placeholderTextColor={colors.muted}
              style={styles.input}
            />
          </View>
        )}

        <View style={styles.field}>
          <Text style={styles.label}>Email</Text>
          <TextInput
            testID="auth-email"
            value={email}
            onChangeText={setEmail}
            placeholder="conductor@empresa.es"
            placeholderTextColor={colors.muted}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Contraseña</Text>
          <TextInput
            testID="auth-password"
            value={password}
            onChangeText={setPassword}
            placeholder="Mínimo 6 caracteres"
            placeholderTextColor={colors.muted}
            secureTextEntry
            style={styles.input}
          />
        </View>

        {!!error && (
          <Text testID="auth-error" style={styles.errorText}>
            {error}
          </Text>
        )}

        <Pressable
          testID="auth-submit"
          style={({ pressed }) => [
            styles.submit,
            pressed && { opacity: 0.85 },
            submitting && { opacity: 0.6 },
          ]}
          disabled={submitting}
          onPress={submit}
        >
          {submitting ? (
            <ActivityIndicator color={colors.onBrandPrimary} />
          ) : (
            <Text style={styles.submitText}>
              {mode === "login" ? "ENTRAR" : "CREAR CUENTA"}
            </Text>
          )}
        </Pressable>

        <Text style={styles.hint}>
          Reglamento UE 561/2006 · Datos cifrados · Sólo tu equipo
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const useStyles = makeStyles((c) => ({
  scroll: {
    paddingHorizontal: spacing.xl,
    flexGrow: 1,
  },
  header: {
    alignItems: "flex-start",
    marginBottom: spacing.xxl,
  },
  logoBadge: {
    width: 56,
    height: 56,
    borderRadius: radius.md,
    backgroundColor: c.brandPrimary,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: spacing.lg,
  },
  logoText: {
    color: c.onBrandPrimary,
    fontSize: 18,
    fontWeight: "900",
    letterSpacing: 2,
  },
  title: {
    color: c.onSurface,
    fontSize: typography.xxl + 4,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  subtitle: {
    color: c.onSurfaceTertiary,
    fontSize: typography.base,
    marginTop: spacing.xs,
  },
  tabRow: {
    flexDirection: "row",
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.md,
    padding: 4,
    marginBottom: spacing.xl,
  },
  tab: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.sm,
    alignItems: "center",
  },
  tabActive: {
    backgroundColor: c.brandPrimary,
  },
  tabText: {
    color: c.onSurfaceTertiary,
    fontWeight: "700",
    letterSpacing: 0.5,
  },
  tabTextActive: {
    color: c.onBrandPrimary,
  },
  field: {
    marginBottom: spacing.lg,
  },
  label: {
    color: c.onSurfaceTertiary,
    fontSize: typography.sm,
    letterSpacing: 1,
    textTransform: "uppercase",
    marginBottom: spacing.xs,
    fontWeight: "600",
  },
  input: {
    backgroundColor: c.surfaceSecondary,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.lg,
    color: c.onSurface,
    fontSize: typography.lg,
    borderWidth: 1,
    borderColor: c.border,
  },
  errorText: {
    color: c.error,
    marginBottom: spacing.md,
    fontSize: typography.base,
  },
  submit: {
    backgroundColor: c.brandPrimary,
    paddingVertical: spacing.lg,
    borderRadius: radius.md,
    alignItems: "center",
    marginTop: spacing.sm,
  },
  submitText: {
    color: c.onBrandPrimary,
    fontSize: typography.lg,
    fontWeight: "800",
    letterSpacing: 1,
  },
  hint: {
    textAlign: "center",
    color: c.muted,
    fontSize: typography.sm,
    marginTop: spacing.xxl,
  },
}));
