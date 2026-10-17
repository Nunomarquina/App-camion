import { useEffect, useState } from "react";
import { storage } from "@/src/utils/storage";

export const BREAK_WARNING_OPTIONS = [30, 15, 10, 5] as const;
export type BreakWarnings = Record<(typeof BREAK_WARNING_OPTIONS)[number], boolean>;

const KEY = "break_warnings";
export const DEFAULT_BREAK_WARNINGS: BreakWarnings = { 30: true, 15: false, 10: true, 5: false };

export async function getBreakWarnings(): Promise<BreakWarnings> {
  const v = await storage.getItem<BreakWarnings | null>(KEY, null);
  return { ...DEFAULT_BREAK_WARNINGS, ...(v || {}) };
}

export async function setBreakWarnings(v: BreakWarnings) {
  await storage.setItem(KEY, v);
}

export function useBreakWarnings() {
  const [value, setValue] = useState<BreakWarnings>(DEFAULT_BREAK_WARNINGS);
  useEffect(() => {
    getBreakWarnings().then(setValue);
  }, []);
  const update = (minutes: keyof BreakWarnings, on: boolean) => {
    const next = { ...value, [minutes]: on };
    setValue(next);
    setBreakWarnings(next);
  };
  return { value, update };
}
