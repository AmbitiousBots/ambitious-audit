import { isTimestamp, type Timestamp } from "./types.ts";

const DAY_MS = 86_400_000;

export const parseTimestamp = (value: string): number | null => {
  if (!isTimestamp(value)) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

export const formatTimestamp = (instantMs: number): Timestamp => {
  const text = new Date(instantMs).toISOString();
  if (!isTimestamp(text)) throw new Error("The formatted instant is not a UTC timestamp.");
  return text;
};

export const addDays = (instantMs: number, days: number): number => instantMs + days * DAY_MS;

export type Observed = { readonly known: false } | { readonly known: true; readonly at: number | "never" };

export const observedInstant = (value: string | null): Observed => {
  if (value === null) return { known: false };
  if (value === "never") return { known: true, at: "never" };
  const at = parseTimestamp(value);
  return at === null ? { known: false } : { known: true, at };
};

export const olderThanDays = (referenceMs: number, earlier: Observed, days: number): boolean =>
  earlier.known && (earlier.at === "never" || referenceMs - earlier.at > days * DAY_MS);
