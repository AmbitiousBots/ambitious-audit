import type { SendReportPayload } from "./types.ts";

export const REQUEST_BYTE_LIMIT = 128 * 1024;
export const RECEIVER_BYTE_LIMIT = 256 * 1024;
export const MCP_ENVELOPE_BYTES = 1024;

// WHY: The payload is nested under params.arguments. Allow CRLF and up to ten indentation spaces per level.
const PAYLOAD_DEPTH = 2;
const ROW_DEPTH = PAYLOAD_DEPTH + 2;
const lineBreak = (depth: number) => 2 + 10 * depth;
const containerBytes = (items: number, depth: number) =>
  items ? 2 + items * lineBreak(depth + 1) + items - 1 + lineBreak(depth) : 2;

const escapedBytes = (value: unknown, depth: number): number => {
  if (typeof value === "string") return 2 + 6 * value.length;
  if (typeof value === "number") return 24;
  if (value === null) return 4;
  if (typeof value === "boolean") return value ? 4 : 5;
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + escapedBytes(item, depth + 1), containerBytes(value.length, depth));
  if (typeof value !== "object") throw new Error("The report must contain JSON values.");
  const entries = Object.entries(value);
  return entries.reduce((sum, [key, item]) =>
    sum + escapedBytes(key, depth + 1) + 2 + escapedBytes(item, depth + 1), containerBytes(entries.length, depth));
};

const jsonBytes = (value: unknown, depth: number) => ({
  utf8: Buffer.byteLength(JSON.stringify(value), "utf8"),
  escaped: escapedBytes(value, depth),
});

export const fitReportLists = (report: SendReportPayload): SendReportPayload => {
  const utf8Budget = REQUEST_BYTE_LIMIT - MCP_ENVELOPE_BYTES;
  const escapedBudget = RECEIVER_BYTE_LIMIT - MCP_ENVELOPE_BYTES;
  const full = jsonBytes(report, PAYLOAD_DEPTH);
  if (full.utf8 <= utf8Budget && full.escaped <= escapedBudget) return report;
  const base = { ...report, bots: [], connectors: [], truncated: true } as const;
  const used = jsonBytes(base, PAYLOAD_DEPTH);
  if (used.utf8 > utf8Budget || used.escaped > escapedBudget) throw new Error("The report exceeds the byte budget before adding bot or connector rows.");

  // WHY: Take canonical prefixes, alternating the lists so both inventories have space.
  const bots: SendReportPayload["bots"][number][] = [];
  const connectors: SendReportPayload["connectors"][number][] = [];
  const append = <T>(rows: readonly T[], kept: T[], index: number): void => {
    const row = rows[index];
    if (row === undefined || index !== kept.length) return;
    const bytes = jsonBytes(row, ROW_DEPTH);
    const utf8 = used.utf8 + bytes.utf8 + (index ? 1 : 0);
    const escaped = used.escaped + bytes.escaped + lineBreak(ROW_DEPTH) + (index ? 1 : lineBreak(ROW_DEPTH - 1));
    if (utf8 > utf8Budget || escaped > escapedBudget) return;
    used.utf8 = utf8;
    used.escaped = escaped;
    kept.push(row);
  };
  for (let index = 0; index < Math.max(report.bots.length, report.connectors.length); index++) {
    append(report.bots, bots, index);
    append(report.connectors, connectors, index);
  }
  return { ...base, bots, connectors };
};
