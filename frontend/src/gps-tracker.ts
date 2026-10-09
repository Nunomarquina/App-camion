import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import * as Location from "expo-location";
import { api } from "./api";

// Auto-detect driving/stopped from GPS speed and report to backend.
// Uses hysteresis: state must hold for ~30s before reporting.
export function useGpsAutoTracking(enabled: boolean, onUpdate?: () => void) {
  const [speed, setSpeed] = useState(0);
  const [permission, setPermission] = useState<"unknown" | "granted" | "denied" | "blocked">("unknown");
  const lastReported = useRef<"DRIVING" | "REST" | null>(null);
  const candidate = useRef<{ state: "DRIVING" | "REST"; since: number } | null>(null);

  useEffect(() => {
    if (!enabled || Platform.OS === "web") return;
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    (async () => {
      const current = await Location.getForegroundPermissionsAsync();
      let res = current;
      if (current.status !== "granted" && current.canAskAgain) {
        res = await Location.requestForegroundPermissionsAsync();
      }
      if (res.status !== "granted") {
        setPermission(res.canAskAgain ? "denied" : "blocked");
        return;
      }
      setPermission("granted");
      if (cancelled) return;
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 5000, distanceInterval: 0 },
        async (pos) => {
          const kmh = Math.max(0, (pos.coords.speed ?? 0) * 3.6);
          setSpeed(kmh);
          const detected = kmh > 5 ? "DRIVING" : "REST";
          const now = Date.now();
          if (!candidate.current || candidate.current.state !== detected) {
            candidate.current = { state: detected, since: now };
            return;
          }
          if (now - candidate.current.since >= 30000 && lastReported.current !== detected) {
            lastReported.current = detected;
            try {
              await api("/tacho/gps-sample", {
                method: "POST",
                body: JSON.stringify({
                  lat: pos.coords.latitude,
                  lng: pos.coords.longitude,
                  speed_kmh: kmh,
                }),
              });
              onUpdate?.();
            } catch {}
          }
        },
      );
    })();
    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [enabled, onUpdate]);

  return { speed, permission };
}
