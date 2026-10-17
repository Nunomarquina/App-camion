// Spanish voice prompts via backend OpenAI TTS. One module-level player,
// only one prompt plays at a time; audio files are cached per phrase.
import { Platform } from "react-native";
import { createAudioPlayer, setAudioModeAsync, AudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { api, API_BASE } from "./api";

let player: AudioPlayer | null = null;
let modeSet = false;
const uriCache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();
let lastError: string | null = null;

export function voiceError() {
  return lastError;
}

async function ensurePlayer() {
  if (!modeSet) {
    await setAudioModeAsync({
      playsInSilentMode: true,
      allowsRecording: false,
      shouldPlayInBackground: true,
      interruptionMode: "duckOthers",
    });
    modeSet = true;
  }
  if (!player) player = createAudioPlayer(null);
  return player;
}

/** Generate (or reuse) the mp3 for a phrase and return a playable URI. */
export function prepare(text: string): Promise<string> {
  const cached = uriCache.get(text);
  if (cached) return Promise.resolve(cached);
  const running = inflight.get(text);
  if (running) return running;
  const p = (async () => {
    const res = await api<{ key: string; url: string }>("/tts", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    const remote = `${API_BASE}/tts/${res.key}.mp3`;
    let uri = remote;
    if (Platform.OS !== "web") {
      const file = new File(Paths.cache, `tts-${res.key}.mp3`);
      if (!file.exists) await File.downloadFileAsync(remote, file);
      uri = file.uri;
    }
    uriCache.set(text, uri);
    return uri;
  })().finally(() => inflight.delete(text));
  inflight.set(text, p);
  return p;
}

export function prefetch(texts: string[]) {
  texts.forEach((t) => prepare(t).catch(() => {}));
}

/** Speak a phrase, interrupting whatever is playing. Resolves when playback starts. */
export async function speak(text: string): Promise<boolean> {
  try {
    const uri = await Promise.race([
      prepare(text),
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timeout")), 12000)),
    ]);
    const p = await ensurePlayer();
    p.replace({ uri });
    p.play();
    lastError = null;
    return true;
  } catch (e: any) {
    lastError = e?.message || "Error de voz";
    console.warn("[voice] failed:", lastError);
    return false;
  }
}

export function stopVoice() {
  try {
    player?.pause();
  } catch {}
}

export function releaseVoice() {
  try {
    player?.pause();
    player?.remove();
  } catch {}
  player = null;
}
