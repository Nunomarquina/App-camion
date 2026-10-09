import { useEffect, useRef, useState } from "react";
import { Platform } from "react-native";
import * as Location from "expo-location";
import { api } from "./api";

// Auto-detect driving/stopped from GPS speed and report to backend.
// Uses the driver's learned profile (speed threshold + hold time) which is
// tuned every time the tachograph card is read. Raw speed samples are
// uploaded in batches so the backend can learn from them.
export function useGpsAutoTracking(enabled: boolean, onUpdate?: () => void) {
  const [speed, setSpeed] = useState(0);
  const [permission, setPermission] = useState<"unknown" | "granted" | "denied" | "blocked">("unknown");
  const [profile, setProfile] = useState<{ speed_threshold_kmh: number; hold_s: number }>({
    speed_threshold_kmh: 5,
    hold_s: 30,
  });
  const lastReported = useRef<"DRIVING" | "REST" | null>(null);
  const candidate = useRef<{ state: "DRIVING" | "REST"; since: number } | null>(null);
  const buffer = useRef<{ lat: number; lng: number; speed_kmh: number; ts: string }[]>([]);
  const profileRef = useRef(profile);
  profileRef.current = profile;

  useEffect(() => {
    if (!enabled) return;
    api<{ speed_threshold_kmh: number; hold_s: number }>("/tacho/detection-profile")
      .then((p) => setProfile({ speed_threshold_kmh: p.speed_threshold_kmh, hold_s: p.hold_s }))
      .catch(() => {});
  }, [enabled]);

  useEffect(() => {
    if (!enabled || Platform.OS === "web") return;
    const flush = async () => {
      const samples = buffer.current.splice(0, 500);
      if (samples.length === 0) return;
      try {
        await api("/tacho/gps-batch", { method: "POST", body: JSON.stringify({ samples }) });
      } catch {
        buffer.current.unshift(...samples.slice(-200));
      }
    };
    const i = setInterval(flush, 60000);
    return () => {
      clearInterval(i);
      flush();
    };
  }, [enabled]);

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
          buffer.current.push({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            speed_kmh: kmh,
            ts: new Date(pos.timestamp).toISOString(),
          });
          const { speed_threshold_kmh, hold_s } = profileRef.current;
          const detected = kmh > speed_threshold_kmh ? "DRIVING" : "REST";
          const now = Date.now();
          if (!candidate.current || candidate.current.state !== detected) {
            candidate.current = { state: detected, since: now };
            return;
          }
          if (now - candidate.current.since >= hold_s * 1000 && lastReported.current !== detected) {
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

  return { speed, permission, profile, setProfile };
}
