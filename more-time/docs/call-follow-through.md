# Call follow-through in iMessage

This feature turns a billing call into a persistent next action, with a separate, explicitly approved one-time reminder. It works without Gemini after the bill has been analyzed.

## Try it

1. Upload a bill, then send `CALL`. MoreTime gives a script using the selected balance and your saved monthly budget, if available. Contact details printed on a bill are labeled as unverified; ask the existing research assistant to find the official number when needed.
2. Send `CALLED They offered $75 a month starting November 1 and said they would email the terms in two days.`
3. Review the exact note. Send `CONFIRM CALL`, or `CALLED` followed by a corrected note.
4. Send `REMIND IN 2 MINUTES` for a demo, or `REMIND IN 2 DAYS` for a realistic follow-up. Approval schedules exactly one contextual check-in. It does not enable recurring check-ins or Gmail monitoring.
5. Keep the backend running. The existing worker checks each minute and sends a message referencing your call report, asking whether written confirmation arrived. Send `CALL STATUS` to see the outcome and next check-in.

`REMIND OFF` cancels the call reminder. `SNOOZE 7` defers an outstanding call reminder by seven days and also snoozes recurring check-ins when enabled. `FOLLOWUPS OFF` or `RESOLVED` cancels it alongside other follow-ups. `STOP` removes the call records. A new valid uploaded document also clears the old call action so its terms cannot be applied to another bill. A corrected call report cancels the old reminder and requires fresh confirmation and approval.

## Guarantees and limits

- Raw notes and explicit user confirmation preserve what was actually reported. Dates and offers are not silently parsed or treated as independent biller confirmation. A reported agreement never changes the original bill balance or printed deadlines.
- Full notes are retained in a case-specific SQLite record; up to 500 characters of confirmed notes are supplied as user-reported case memory to subsequent Gemini conversations.
- A call plan does not place a telephone call or accept terms. Multiple statements require a selected statement; EOBs do not become payable bills.
- Commands and replies commit together. Duplicate inbound messages and restarts cannot reset a newer report or extend an approved reminder. Queues are reserved atomically across workers sharing SQLite.
- Delivery statuses distinguish scheduled, sending, sent, uncertain and cancelled. A crash or ambiguous send leaves an unconfirmed attempt, with no automatic duplicate. Sent means Photon returned an outgoing message, not that the recipient read it.
- Reminders use elapsed time (minutes/hours/24-hour days), from one minute through 30 days. Confirmation displays America/New_York time explicitly. They are one-time: missed downtime results in one delayed check-in, never a backlog. The server must stay running.
- This tracks the currently selected call action, not a complete archive of every past billing call. Plain natural-language messages continue to the existing assistant; use the commands above to create actions explicitly.
