---
name: send-feedback
description: "Build a send_feedback document with ambitious-audit and hand it to the service after the customer approves the send."
---

# Send feedback

Ask the customer what they want to say, or take a note the bot itself needs to send. Run:

```text
ambitious-audit feedback build --in feedback.json
```

`feedback.json` is `{ "text": "...", "from": "customer" }` or `"from": "bot"`. Add `reportId` when the note is about one report. Leave it out for general feedback; feedback without a report id is valid. `text` is at most 4000 characters.

The command prints `data.payload`. Send that object with the service's `send_feedback` tool. The platform must confirm that the owner's approval covers the feedback call; otherwise send nothing. Approval for `send_report` does not cover `send_feedback`. Do not put an organisation id in the payload; the service takes that from the caller.
