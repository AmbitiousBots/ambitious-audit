import type { SendReportPayload } from "./types.ts";

export const REQUEST_BYTE_LIMIT = 128 * 1024;
export const RECEIVER_BYTE_LIMIT = 256 * 1024;
export const MCP_ENVELOPE_BYTES = 1024;

const jsonBytes = (value: unknown) => {
  const compact = JSON.stringify(value);
  const utf8 = Buffer.byteLength(compact, "utf8");
  // WHY: An ASCII encoder can spend six bytes per non-ASCII UTF-16 code unit and a space after each separator.
  const escaped = compact.length + 5 * (compact.match(/[^\x20-\x7e]/g)?.length ?? 0) + (compact.match(/[,:]/g)?.length ?? 0);
  return { utf8, escaped };
};

export const fitReportLists = (report: SendReportPayload): SendReportPayload => {
  const utf8Budget = REQUEST_BYTE_LIMIT - MCP_ENVELOPE_BYTES;
  const escapedBudget = RECEIVER_BYTE_LIMIT - MCP_ENVELOPE_BYTES;
  const full = jsonBytes(report);
  if (full.utf8 <= utf8Budget && full.escaped <= escapedBudget) return report;
  const base = { ...report, bots: [], connectors: [], truncated: true } as const;
  const used = jsonBytes(base);
  if (used.utf8 > utf8Budget || used.escaped > escapedBudget) throw new Error("The report exceeds the byte budget before adding bot or connector rows.");

  // WHY: Take canonical prefixes, alternating the lists so both inventories have space.
  const bots: SendReportPayload["bots"][number][] = [];
  const connectors: SendReportPayload["connectors"][number][] = [];
  const append = <T>(rows: readonly T[], kept: T[], index: number): void => {
    const row = rows[index];
    if (row === undefined || index !== kept.length) return;
    const bytes = jsonBytes(row);
    const utf8 = used.utf8 + bytes.utf8 + (index ? 1 : 0);
    const escaped = used.escaped + bytes.escaped + (index ? 2 : 0);
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
