---
name: audit-page
description: "Turn an ambitious-audit report into a page showing findings, recommendations and service announcements by priority. The module does not render the page."
---

# Audit page

After `report build`, write a page in the bot's own page tool from `data.payload`. The module stores no rendered document.

Show high-priority items before low-priority items and label each as a finding, recommendation or announcement according to its array. Within each priority, lead with recommendation titles, at most three overall, each followed by its `why` and the evidence text for its evidence ids. Then list rule findings that did not become recommendations and service announcements. Use the priorities returned by the module; do not assign or rewrite them.

Show each announcement's title verbatim and keep its id with the item. Announcements come only from the saved service `check_updates` result passed to `report build`. Do not create, summarize or expand announcement text. When `announcements` is empty, there are no announcements to show.

When `accountKind` is `unknown` (or `mode` is `partial` in the analysis commands), say near the top that the bot does not know its role on the account, so advice that depends on the role is held back. Show each finding marked `withheld` as a fact, without advice, and say that telling the bot the role lets the next audit give that advice. Do not guess the role. Recommendations the module did return in partial mode are shown as usual: advice about the bot's own connectors, such as signing one in again, does not depend on the role.

End with what the audit does not cover: every visibility entry whose `seen` is false, with its `why`. The findings of kind `visibility` name the same gaps and have low priority; list each gap once.

Show a count that is `null` as "not observed". Never show it as 0. When displaying a stored version 1 or version 2 report, say its priorities and announcements were not recorded; do not invent them or change the stored report.

Keep the page short. Do not paste a transcript. Do not add a recommendation the module did not return.
