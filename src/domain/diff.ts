import { isRecord } from "@ambitious/kit/domain/json";
import type { Change, JsonValue } from "./types.ts";

const pointer = (parts: readonly string[]): string => `/${parts.map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;

const isObject = (value: JsonValue): value is { readonly [key: string]: JsonValue } => isRecord(value);

export const diffJson = (before: JsonValue, after: JsonValue): readonly Change[] => {
  const walk = (left: JsonValue, right: JsonValue, path: readonly string[]): readonly Change[] => {
    if (Array.isArray(left) && Array.isArray(right)) {
      const length = Math.max(left.length, right.length);
      const changes: Change[] = [];
      for (let index = 0; index < length; index += 1) {
        const leftItem = left[index];
        const rightItem = right[index];
        const child = [...path, String(index)];
        if (leftItem === undefined) changes.push({ path: pointer(child), before: null, after: rightItem ?? null });
        else if (rightItem === undefined) changes.push({ path: pointer(child), before: leftItem, after: null });
        else changes.push(...walk(leftItem, rightItem, child));
      }
      return changes;
    }
    if (isObject(left) && isObject(right)) {
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
      return keys.flatMap((key) => {
        const leftValue = left[key];
        const rightValue = right[key];
        const child = [...path, key];
        if (leftValue === undefined) return [{ path: pointer(child), before: null, after: rightValue ?? null }];
        if (rightValue === undefined) return [{ path: pointer(child), before: leftValue, after: null }];
        return walk(leftValue, rightValue, child);
      });
    }
    return JSON.stringify(left) === JSON.stringify(right) ? [] : [{ path: pointer(path), before: left, after: right }];
  };
  return walk(before, after, []);
};
