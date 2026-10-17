import { Platform } from "react-native";
import { fetch as expoFetch } from "expo/fetch";
import { API_BASE, getToken } from "@/src/api";

export type UploadFile = { uri: string; name: string; mimeType?: string | null };

/** Multipart upload that works on web and on real devices (expo/fetch). */
export async function uploadForm<T = any>(path: string, field: string, file: UploadFile): Promise<T> {
  const form = new FormData();
  if (Platform.OS === "web") {
    const blob = await (await fetch(file.uri)).blob();
    form.append(field, blob, file.name);
  } else {
    const blob = await (await expoFetch(file.uri)).blob();
    form.append(field, blob as any, file.name);
  }
  const token = await getToken();
  const doFetch: any = Platform.OS === "web" ? fetch : expoFetch;
  const res = await doFetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data && (data.detail || data.message)) || `Error al subir (${res.status})`;
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return data as T;
}
