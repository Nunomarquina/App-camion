import React, { forwardRef, useImperativeHandle } from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors } from "@/src/theme";

// Web preview fallback: native maps are only available on iOS/Android.
const MapView = forwardRef<any, any>(function MapView({ style, children }, ref) {
  useImperativeHandle(ref, () => ({
    animateToRegion: () => {},
    fitToCoordinates: () => {},
  }));
  return (
    <View style={[style, styles.box]} testID="map-web-placeholder">
      <Text style={styles.text}>Mapa disponible en la app móvil (Expo Go)</Text>
      {children}
    </View>
  );
});

export default MapView;
export const Marker = (_: any) => null;
export const Polyline = (_: any) => null;
export const PROVIDER_DEFAULT = undefined;

const styles = StyleSheet.create({
  box: { backgroundColor: colors.surfaceSecondary, alignItems: "center", justifyContent: "center" },
  text: { color: colors.muted, fontSize: 13 },
});
