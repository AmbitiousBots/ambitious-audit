import type { SendReportPayload } from "./types.ts";

export const REQUEST_BYTE_LIMIT = 128 * 1024;
export const MCP_ENVELOPE_BYTES = 1024;

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

export const fitReportLists = (report: SendReportPayload): SendReportPayload => {
  const budget = REQUEST_BYTE_LIMIT - MCP_ENVELOPE_BYTES;
  if (jsonBytes(report) <= budget) return report;
  const base = { ...report, bots: [], connectors: [], truncated: true } as const;
  let remaining = budget - jsonBytes(base);
  if (remaining < 0) throw new Error("The report exceeds the byte budget before adding bot or connector rows.");

  // WHY: Take canonical prefixes, alternating the lists so both inventories have space.
  const bots: SendReportPayload["bots"][number][] = [];
  const connectors: SendReportPayload["connectors"][number][] = [];
  const append = <T>(rows: readonly T[], kept: T[], index: number): void => {
    const row = rows[index];
    if (row === undefined || index !== kept.length) return;
    const bytes = jsonBytes(row) + Number(index > 0);
    if (bytes > remaining) return;
    remaining -= bytes;
    kept.push(row);
  };
  for (let index = 0; index < Math.max(report.bots.length, report.connectors.length); index++) {
    append(report.bots, bots, index);
    append(report.connectors, connectors, index);
  }
  return { ...base, bots, connectors };
};
