import { isRecord, type JsonObject } from "@ambitious/kit/domain/json";
import type { JsonValue } from "./types.ts";

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (isRecord(value)) return Object.values(value).every(isJsonValue);
  return false;
};

const isJsonObject = (value: unknown): value is JsonObject => isRecord(value) && isJsonValue(value);

export const asJsonValue = (value: unknown): JsonValue => {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (!isJsonValue(parsed)) throw new Error("The value is not JSON.");
  return parsed;
};

export const asJsonObject = (value: unknown): JsonObject => {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  if (!isJsonObject(parsed)) throw new Error("The value is not a JSON object.");
  return parsed;
};
