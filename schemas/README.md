# Schemas

JSON Schema (draft 2020-12) for the three documents that cross the module's boundary.

| File | What it describes | Who reads it |
|---|---|---|
| `collector.v1.json` | What a bot gathered about its account, as input to `snapshot`. | This module. |
| `send_report.v1.json` | The report summary sent to the monitoring service. | This module and the service. |
| `send_feedback.v1.json` | Feedback from a customer or their bot, optionally about one report. | This module and the service. |

The service takes the two `send_*` schemas from a tagged release of this repository, so a change that makes a valid payload invalid, or the reverse, needs a new file with a new version number.

What the schemas hold to, and `npm run check:schemas` checks:

- **No transcripts.** Every string has a maximum length and every list a maximum size. The summary is at most 1200 characters, an evidence text at most 280, a feedback text at most 4000. The check adds up the most free text a payload can carry (about 23,500 characters for a report) and fails if a change raises it past the budget written in `scripts/check-schemas.mjs`.
- **No unknown fields.** Every object rejects properties it does not describe.
- **No organisation in the payload.** No schema has a field for the organisation. The service takes it from the caller's credential and rejects a payload that tries to set it.
- **At most three recommendations**, each citing at least one evidence id.
- **A complete visibility map.** `visibility` has exactly one entry for each of the four signals, each saying whether it was seen and why, so something the bot could not see is never left out.
- **Report and feedback ids are version 7 UUIDs**, lower case.
- **Times are UTC**, written `YYYY-MM-DDTHH:MM:SSZ` with optional milliseconds.

Patterns are used instead of the `format` keyword, because validators are allowed to ignore `format`.

What a schema cannot say, and the module's code must check: every cited evidence id exists in the evidence list, and `period.from` is not after `period.to`.

## Examples

`examples/<schema>/valid/` holds documents that must be accepted; `examples/<schema>/invalid/` holds documents that must be rejected. `examples/EXPECTED.json` names, for each invalid example, the schema keyword and the place in the document that must reject it, so an example cannot pass the check by being wrong in some other way.

## Types

`src/domain/wire.generated.ts` is written from the schemas by `npm run generate:wire-types`, and `npm run check:schemas` fails when it is out of date. The hand-written types in `src/domain/types.ts` add distinct id types on top; `sendReportWire` and `sendFeedbackWire` there make the compiler check that they still fit the schemas.
