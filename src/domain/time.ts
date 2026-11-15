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

export const olderThanDays = (referenceMs: number, earlierMs: number | null, days: number): boolean =>
  earlierMs === null || referenceMs - earlierMs > days * DAY_MS;
