# Schemas

JSON Schema (draft 2020-12) for the documents that cross the module's boundary.

| File | What it describes | Who reads it |
|---|---|---|
| `collector.v2.json` | Snapshot input with exact and bounded shares, plan usage, activity and partial visibility. Printed by `schema`. | This module. |
| `send_report.v4.json` | New reports from `report build`, with named bots and connectors, plan usage and nullable activity totals. Printed by `schema send report`. | This module and the service. |
| `collector.v1.json` | What a bot gathered about its account, as input to `snapshot`. | This module. |
| `send_report.v3.json` | The report summary sent to the monitoring service, with priorities and service announcements. Module version 0.3.0 produced these reports. Every text field is bounded and there is no field for a transcript. Validation cannot tell whether short text quotes a conversation. | This module and the service. |
| `send_report.v2.json` | The report summary produced by module versions 0.2.0 through 0.2.2, without priorities or announcements. Kept unchanged for stored version 2 reports. | The service, and this module for reports it stored earlier. |
| `send_report.v1.json` | The report summary as version 0.1.0 of the module produced it. It cannot say that a count was not observed. Kept unchanged so that stored version 1 reports can still be checked. | The service, and this module for reports it stored earlier. |
| `send_feedback.v1.json` | Feedback from a customer or their bot, optionally about one report. | This module and the service. |

The inputs of the other commands are small objects described in `src/domain/command-inputs.ts`; `ambitious-audit schema <command>` prints each one, and `npm run check:schemas` holds them to the same rules about unknown fields and bounded text.

The service takes the `send_*` schemas from a tagged release of this repository, so a change that makes a valid payload invalid, or the reverse, needs a new file with a new version number.

What the schemas hold to, and `npm run check:schemas` checks:

- **Bounded text.** Every string has a maximum length and every list a maximum size. The summary is at most 1200 characters, a v4 evidence text at most 200, a feedback text at most 4000. The check adds up the most free text a payload can carry (28,704 characters for a version 2 report, 30,544 for version 3 and 68,728 for version 4) and fails if a change raises it past the budget written in `scripts/check-schemas.mjs`.
- **No unknown fields.** Every wire object rejects properties it does not describe. For `report build` input only, the module projects saved service announcements to `id`, `priority` and `title` before validation; other fields of each announcement are ignored.
- **No organisation in the payload.** No schema has a field for the organisation. The service takes it from the caller's credential and rejects a payload that tries to set it.
- **At most three recommendations**, each citing at least one evidence id.
- **Priorities and service announcements.** Version 3 requires `high` or `low` on every finding and recommendation, plus an announcements array with at most ten `{ id, priority, title }` objects. Announcement ids are 1 to 64 lowercase letters, digits or hyphens, starting with a letter or digit; titles are 1 to 120 characters. The module copies these values from the saved service input without writing announcement text.
- **A complete visibility map.** `visibility` has exactly one entry for each signal (nine in the collector document and reports from version 2 onward, four in the version 1 report), each saying whether it was seen and why, so something the bot could not see is never left out.
- **Observation gaps.** Collector v2 and report v4 accept `"partial"` for a signal with incomplete coverage. Missing task and page counts are nullable from v2 onward. In v4 the three routine state totals and both seven-day run totals can also be null.
- **Report and feedback ids are version 7 UUIDs**, lower case.
- **Times are UTC**, written `YYYY-MM-DDTHH:MM:SSZ` with optional milliseconds.

The version 3 free-text budget is 30,840 characters, up from the unchanged version 2 budget of 29,000. The deliberate increase is 1,840 characters: ten announcement ids of at most 64 characters plus ten titles of at most 120. The checker counts patterned ids toward the budget; enum priorities add no free text. All earlier report limits stay unchanged.

The version 4 budget is 69,024 characters. Each of the 200 bots can carry a 60-character name and three 24-character timestamps. Each of the 200 connectors can carry a 60-character name. The plan adds one 24-character timestamp. Each of the 30 evidence rows allows 200 characters each for source and text, a combined decrease of eight per row from v3. The budget is `30,840 + 200 × (60 + 3 × 24) + 200 × 60 + 24 − 30 × 8 = 69,024`. The computed bound is 68,728, leaving 296 characters. The name flag, period and status enums add zero free text.

Collector v2 `planUsage` is optional. Its four fields are individually nullable. An all-null object is absent for normalization, legacy weekly-limit fallback and coverage. Percentages are bounded at 100. Collector v2 records `extraCreditsLeftUsdCents` as an integer from 0 through 100,000,000,000 or null. Report v4 expresses the same balance in dollars under `extraCreditsLeftUsd`. The v4 JSON Schema checks the numeric range. The producer and verifier also apply `wholeCents` from `src/domain/wire-validator.ts` to every numeric balance. Receivers using the schema on its own must check that rounding to two decimal places preserves the value. The weekly contract example includes 0.29 USD. The plan and bot period enums use the same three periods. The report requires the plan object or null. Run totals allow up to 1,000 routines with up to 1,000,000 runs each.

Patterns are used instead of the `format` keyword, because validators are allowed to ignore `format`.

What a schema cannot say, and the module's code must check: every cited evidence id exists in the evidence list, and `period.from` is not after `period.to`. Version 3 announcements must have unique ids; the module validates every input entry, keeps the first occurrence of each id, sorts high before low with input order preserved within each priority, and keeps at most ten. An absent input array becomes an empty array. A same-id rebuild returns the stored payload unchanged. For the collector document the code also checks that ids are not repeated, that every `null` (and an `unknown` role) is matched by its visibility entry with `seen: false` (or `"partial"` in v2), that a role is named only when `accountRole` was seen, that reported failures fit within the routine’s seven-day run total, that a percentage is at most 100, that every usage given as a share names the same period, that a period does not start after it ends, and that `usageOther` comes with at least one listed share. The collection table in the [module README](../README.md#what-the-bot-could-not-observe) maps values to signals.

Collector v1 uses `if`, `then` and `else` to distinguish seven-day amounts from period shares. Collector v2 uses `oneOf` to distinguish a seven-day amount, an exact share, a strict upper bound and null. The v4 bot schema pairs each exact share or bound with a period and accepts the optional UTC boundaries `usagePeriodStart` and `usagePeriodEnd` on those rows. Its two share fields and period are null together when there is no share reading. The schema checker generates the corresponding TypeScript unions from these branches.

## Collector text in reports

The producer applies NFKC to each display name, then converts a typographic apostrophe (’) to a straight apostrophe. A name must contain a letter. It may contain Unicode letters, combining marks attached to letters, ASCII spaces, ampersands, apostrophes, hyphens, commas and up to two ASCII digits. The limit is 40 Unicode code points, five words and 16 letters per word. Punctuation separates words. Credential words such as `token`, `secret`, `password`, `bearer`, `otp`, `pin`, `key` and `code` withhold the name, including words within camel-case labels. Uppercase-only words containing digits and encoded credentials following `Basic` or `Digest` also withhold the name. The 60-character wire limit accommodates previously stored v4 payloads.

A withheld name becomes `Bot N` or `Connector N` with `nameWithheld: true`. Positions start at one, after sorting bots by original ID and connectors by original name and before trimming the lists.

A v2 evidence row uses `sourceKind` to identify a bot, routine, connector or task reading. The local `source` identifies the subject within that kind. Bot IDs match case-sensitively. Untyped v2 rows stay local. V1 reserves the source `tasks` for task counts and resolves other sources against a single matching subject. The snapshot retains its original evidence IDs and prose. For both versions the producer generates report evidence labels and text from the matched inventory row or task counts. It numbers the retained rows from `ev-1` and uses those IDs in both findings and recommendations.

V2 visibility entries can record `scope: "all"` for account-wide access, `"shared_only"` for shared folders or `"limited"` for another access restriction. Omit scope when unknown. The report describes measurements and scope in fixed language. Evidence `text` and visibility `why` are optional local notes in v2.

## Serialized report size

The kit serializes the CLI result as compact UTF-8 JSON. The snapshot routine passes the parsed `data.payload` object to the platform’s `send_report` MCP tool. The platform encodes the HTTP request. [Snapshot routine](../skills/snapshot-routine/SKILL.md)

The producer sizes the JSON-RPC `tools/call` body in two encodings and reserves 1,024 bytes in each for the envelope.

| Encoding | Request limit | Space for arguments |
|---|---:|---:|
| Compact UTF-8 JSON | 131,072 bytes | 130,048 bytes |
| JSON with ASCII Unicode escapes | 262,144 bytes (receiver limit) | 261,120 bytes |

The escaped bound reserves six bytes for every UTF-16 code unit in strings and keys, including twelve for a surrogate pair. It allows 24 bytes per number for shortest round-trip formatting. The layout budget covers compact separators and pretty printing with CRLF and up to ten spaces of indentation per level, including the two levels surrounding the payload. The envelope reserve applies to its encoded size. Shares and weekly percentages have at most four decimal places. Strict upper bounds round upward. Positive shares below 0.0001 use the bound 0.0001. Credit balances have cent precision and counts are integers. If either budget is exceeded, the producer adds `truncated: true` and retains prefixes of both lists, alternating bots sorted by id and connectors sorted by name. Counts cover every row in the snapshot. Findings, recommendations and their evidence retain their space. The evidence budget is 30 rows. Each item with evidence gets one citation before the producer fills the remaining rows in rank order and removes citations to omitted rows.

## Examples

`examples/<schema>/valid/` holds documents that must be accepted; `examples/<schema>/invalid/` holds documents that must be rejected. `examples/EXPECTED.json` names, for each invalid example, the schema keyword and the place in the document that must reject it, so an example cannot pass the check by being wrong in some other way.

## Types

`src/domain/wire.generated.ts` is written from the schemas by `npm run generate:wire-types`, and `npm run check:schemas` fails when it is out of date. The hand-written types in `src/domain/types.ts` add distinct id types on top; `sendReportWire` and `sendFeedbackWire` there make the compiler check that they still fit the schemas.
