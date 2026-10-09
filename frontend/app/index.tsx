import { ActivityIndicator, View } from "react-native";
import { Redirect } from "expo-router";
import { useAuth } from "@/src/auth-context";
import { colors } from "@/src/theme";

export default function Index() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.surface,
          alignItems: "center",
          justifyContent: "center",
        }}
        testID="splash-loader"
      >
        <ActivityIndicator color={colors.brandPrimary} size="large" />
      </View>
    );
  }

  return user ? <Redirect href="/(tabs)/tacho" /> : <Redirect href="/auth" />;
}
