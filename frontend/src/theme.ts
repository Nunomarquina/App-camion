import { useMemo } from "react";
import { Appearance, StyleSheet, useColorScheme } from "react-native";

export type ColorScheme = "light" | "dark";

const dark = {
  surface: "#0C0D10",
  onSurface: "#F4F5F7",
  surfaceSecondary: "#17191E",
  onSurfaceSecondary: "#E0E2E7",
  surfaceTertiary: "#22252C",
  onSurfaceTertiary: "#B8BCC6",
  surfaceInverse: "#FFFFFF",
  onSurfaceInverse: "#0C0D10",
  muted: "#757B8A",

  brand: "#FF9F0A",
  onBrand: "#0C0D10",
  brandPrimary: "#FF9F0A",
  onBrandPrimary: "#0C0D10",
  brandSecondary: "#D48205",
  onBrandSecondary: "#0C0D10",
  brandTertiary: "#4D3003",
  onBrandTertiary: "#FFD38B",

  success: "#32D74B",
  onSuccess: "#0A2F10",
  warning: "#FFD60A",
  onWarning: "#332A02",
  error: "#FF453A",
  onError: "#450907",
  info: "#3EA8FF",
  onInfo: "#051F36",

  border: "#282C35",
  borderStrong: "#3B404D",
  divider: "#1C1F26",
};

export type ThemeColors = typeof dark;

export const defaultScheme = "dark" satisfies ColorScheme;

export const themes: { light?: ThemeColors; dark: ThemeColors } = { dark };

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
};

export const radius = {
  sm: 4,
  md: 8,
  lg: 12,
  pill: 999,
};

export const typography = {
  displayFamily: "Rajdhani",
  textFamily: "IBM Plex Sans",
  sm: 12,
  base: 14,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 48,
};

export function setColorScheme(scheme: ColorScheme | null) {
  Appearance.setColorScheme?.(scheme ?? "unspecified");
}

// Dark-only app: force dark scheme on native surfaces
setColorScheme?.("dark");

export function useTheme(): { scheme: ColorScheme; colors: ThemeColors } {
  const system = useColorScheme();
  const scheme: ColorScheme = "dark";
  return { scheme, colors: themes.dark };
}

export const colors = themes.dark;

export function makeStyles<T extends StyleSheet.NamedStyles<T> | StyleSheet.NamedStyles<any>>(
  factory: (colors: ThemeColors) => T & StyleSheet.NamedStyles<any>,
): () => T {
  return function useStyles(): T {
    const { colors } = useTheme();
    return useMemo(() => StyleSheet.create(factory(colors)), [colors]);
  };
}
