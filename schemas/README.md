# Schemas

JSON Schema (draft 2020-12) for the documents that cross the module's boundary.

| File | What it describes | Who reads it |
|---|---|---|
| `collector.v1.json` | What a bot gathered about its account, as input to `snapshot`. | This module. |
| `send_report.v3.json` | The report summary sent to the monitoring service, with priorities and service announcements. This is what `report build` produces for new reports. Every text field is bounded and there is no field for a transcript. Validation cannot tell whether short text quotes a conversation. | This module and the service. |
| `send_report.v2.json` | The report summary produced by module versions 0.2.0 through 0.2.2, without priorities or announcements. Kept unchanged for stored version 2 reports. | The service, and this module for reports it stored earlier. |
| `send_report.v1.json` | The report summary as version 0.1.0 of the module produced it. It cannot say that a count was not observed. Kept unchanged so that stored version 1 reports can still be checked. | The service, and this module for reports it stored earlier. |
| `send_feedback.v1.json` | Feedback from a customer or their bot, optionally about one report. | This module and the service. |

The inputs of the other commands are small objects described in `src/domain/command-inputs.ts`; `ambitious-audit schema <command>` prints each one, and `npm run check:schemas` holds them to the same rules about unknown fields and bounded text.

The service takes the `send_*` schemas from a tagged release of this repository, so a change that makes a valid payload invalid, or the reverse, needs a new file with a new version number.

What the schemas hold to, and `npm run check:schemas` checks:

- **Bounded text.** Every string has a maximum length and every list a maximum size. The summary is at most 1200 characters, an evidence text at most 280, a feedback text at most 4000. The check adds up the most free text a payload can carry (28,704 characters for a version 2 report and 30,544 for version 3) and fails if a change raises it past the budget written in `scripts/check-schemas.mjs`.
- **No unknown fields.** Every wire object rejects properties it does not describe. For `report build` input only, the module projects saved service announcements to `id`, `priority` and `title` before validation; other fields of each announcement are ignored.
- **No organisation in the payload.** No schema has a field for the organisation. The service takes it from the caller's credential and rejects a payload that tries to set it.
- **At most three recommendations**, each citing at least one evidence id.
- **Priorities and service announcements.** Version 3 requires `high` or `low` on every finding and recommendation, plus an announcements array with at most ten `{ id, priority, title }` objects. Announcement ids are 1 to 64 lowercase letters, digits or hyphens, starting with a letter or digit; titles are 1 to 120 characters. The module copies these values from the saved service input without writing announcement text.
- **A complete visibility map.** `visibility` has exactly one entry for each signal (nine in the collector document and version 2 and version 3 reports, four in the version 1 report), each saying whether it was seen and why, so something the bot could not see is never left out.
- **Unknown is not zero.** In the collector document and version 2 and version 3 reports, a count that was not observed is `null`. The field is still required, so leaving it out is not a way to say nothing.
- **Report and feedback ids are version 7 UUIDs**, lower case.
- **Times are UTC**, written `YYYY-MM-DDTHH:MM:SSZ` with optional milliseconds.

The version 3 free-text budget is 30,840 characters, up from the unchanged version 2 budget of 29,000. The deliberate increase is 1,840 characters: ten announcement ids of at most 64 characters plus ten titles of at most 120. The checker counts patterned ids toward the budget; enum priorities add no free text. All earlier report limits stay unchanged.

Patterns are used instead of the `format` keyword, because validators are allowed to ignore `format`.

What a schema cannot say, and the module's code must check: every cited evidence id exists in the evidence list, and `period.from` is not after `period.to`. Version 3 announcements must have unique ids; the module validates every input entry, keeps the first occurrence of each id, sorts high before low with input order preserved within each priority, and keeps at most ten. An absent input array becomes an empty array. A same-id rebuild returns the stored payload unchanged. For the collector document the code also checks that ids are not repeated, that every `null` (and an `unknown` role) is matched by its visibility entry with `seen: false`, that a role is named only when `accountRole` was seen, that a percentage is at most 100, that every usage given as a share names the same period, that a period does not start after it ends, and that `usageOther` comes with at least one listed share. The description at the top of `collector.v1.json` lists which signal covers which values.

A bot's usage takes one of two forms, chosen by `unit`. The schema says this with `if`, `then` and `else`: `then` and `else` each name the fields their form requires and set the fields of the other form to `false`, so a value cannot mix the two. `npm run check:schemas` accepts those keywords only in this shape, and writes the two forms as two separate types.

## Examples

`examples/<schema>/valid/` holds documents that must be accepted; `examples/<schema>/invalid/` holds documents that must be rejected. `examples/EXPECTED.json` names, for each invalid example, the schema keyword and the place in the document that must reject it, so an example cannot pass the check by being wrong in some other way.

## Types

`src/domain/wire.generated.ts` is written from the schemas by `npm run generate:wire-types`, and `npm run check:schemas` fails when it is out of date. The hand-written types in `src/domain/types.ts` add distinct id types on top; `sendReportWire` and `sendFeedbackWire` there make the compiler check that they still fit the schemas.
