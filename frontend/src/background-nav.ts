// Background location for turn-by-turn navigation (screen locked / app in background).
// The task must be defined at module top level, so this file is imported from the root layout.
import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";

export const NAV_LOCATION_TASK = "trucknav-location";

type Listener = (l: Location.LocationObject) => void;
let listener: Listener | null = null;

if (Platform.OS !== "web") {
  TaskManager.defineTask(NAV_LOCATION_TASK, async ({ data, error }: any) => {
    if (error || !data?.locations?.length) return;
    const locs: Location.LocationObject[] = data.locations;
    if (listener) locs.forEach((l) => listener?.(l));
  });
}

/** Background updates need a native build (not available in Expo Go) and Always/background permission. */
export function backgroundSupported() {
  return Platform.OS !== "web" && Constants.executionEnvironment !== "storeClient";
}

export async function startBackgroundNav(onLocation: Listener): Promise<boolean> {
  if (!backgroundSupported()) return false;
  const bg = await Location.getBackgroundPermissionsAsync();
  if (bg.status !== "granted") return false;
  listener = onLocation;
  if (await Location.hasStartedLocationUpdatesAsync(NAV_LOCATION_TASK)) return true;
  await Location.startLocationUpdatesAsync(NAV_LOCATION_TASK, {
    accuracy: Location.Accuracy.BestForNavigation,
    timeInterval: 1000,
    distanceInterval: 3,
    activityType: Location.ActivityType.AutomotiveNavigation,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: "TruckNav Pro · navegando",
      notificationBody: "Guía por voz y tiempo de viaje activos",
      notificationColor: "#FF9F0A",
      killServiceOnDestroy: true,
    },
  });
  return true;
}

export async function stopBackgroundNav() {
  listener = null;
  if (!backgroundSupported()) return;
  try {
    if (await Location.hasStartedLocationUpdatesAsync(NAV_LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(NAV_LOCATION_TASK);
    }
  } catch {}
}
