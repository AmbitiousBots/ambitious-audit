---
name: snapshot-routine
description: "Run ambitious-audit daily, show findings, recommendations and service announcements by priority, and send only when the platform confirms the owner's approval covers the call."
---

# Snapshot routine

Run daily by default. The owner can pause the routine.

1. Collect a document with the audit collector skill and run `snapshot`.
2. On the first run, run `baseline set`. Later, run `diff` against the latest baseline.
3. Run `findings` and `recommend`. Their priorities are decided by the module: high-severity rules have high priority, other rules and visibility findings have low priority. Do not change those priorities.
4. Run `report build` with the `snapshotId`, `reviewRequired` set according to the owner's review preference, and the `announcements` array saved from the service's `check_updates` result. Use `reviewRequired: false` when no report review is required, or `true` when the owner requires a person to review each report. If there are no saved service announcements, omit the field. Never write announcement text yourself. The module keeps only each announcement's `id`, `priority` and `title`, unchanged; it validates the list, keeps the first entry per id, orders high before low and keeps at most ten. Read `data.next`.
5. Write the page with the audit page skill, using `data.payload` so it shows the same announcements and priorities as the report. When `next.kind` is `waitForReview`, stop until a person has looked at the page, then `report mark` with state `reviewed`.
6. When `next.kind` is `send`, call the service's `send_report` tool with `data.payload` only if the platform confirms that the owner's approval covers the call. The owner may pre-approve this tool once for the daily routine. If the platform cannot confirm that approval covers the call, send nothing. Tool approval is separate from report review: a pre-approval never bypasses a required review. Do not send a payload other than the one `report build` returned.
7. If the service accepts the report, `report mark` with state `sent` and then `acked`. If the call fails or times out, `report mark` with state `failed` and follow `next` again. Use the same `reportId` and stored payload on every retry. A same-id rebuild returns the original stored payload, even if the saved announcements have changed. Stop when `next.kind` is `gaveUp` or `delivered`.

`at` on each mark is the UTC time of that step. The module performs no network calls; the bot obtains updates and sends reports with the service's tools.
