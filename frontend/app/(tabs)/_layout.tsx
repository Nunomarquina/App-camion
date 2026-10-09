import { Tabs, Redirect } from "expo-router";
import { Platform } from "react-native";
import Icon from "@react-native-vector-icons/material-design-icons";
import { useAuth } from "@/src/auth-context";
import { colors } from "@/src/theme";

export default function TabsLayout() {
  const { user, loading } = useAuth();
  if (loading) return null;
  if (!user) return <Redirect href="/auth" />;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.surfaceSecondary,
          borderTopColor: colors.border,
          borderTopWidth: 1,
          ...(Platform.OS === "web" ? { height: 64 } : {}),
        },
        tabBarItemStyle: { alignSelf: "center" },
        tabBarActiveTintColor: colors.brandPrimary,
        tabBarInactiveTintColor: colors.muted,
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: "700",
          letterSpacing: 0.5,
        },
      }}
    >
      <Tabs.Screen
        name="tacho"
        options={{
          title: "Tacógrafo",
          tabBarIcon: ({ color, size }) => (
            <Icon name="timer-outline" size={size} color={color} />
          ),
          tabBarButtonTestID: "tab-tacho",
        }}
      />
      <Tabs.Screen
        name="map"
        options={{
          title: "Ruta",
          tabBarIcon: ({ color, size }) => (
            <Icon name="map-outline" size={size} color={color} />
          ),
          tabBarButtonTestID: "tab-map",
        }}
      />
      <Tabs.Screen
        name="vehicle"
        options={{
          title: "Vehículo",
          tabBarIcon: ({ color, size }) => (
            <Icon name="truck-outline" size={size} color={color} />
          ),
          tabBarButtonTestID: "tab-vehicle",
        }}
      />
      <Tabs.Screen
        name="logbook"
        options={{
          title: "Historial",
          tabBarIcon: ({ color, size }) => (
            <Icon name="notebook-outline" size={size} color={color} />
          ),
          tabBarButtonTestID: "tab-logbook",
        }}
      />
    </Tabs>
  );
}
