# MoreTime TODO

The Gemini bill-reading and iMessage conversation flow is working. The next stage
is to help users call their biller or send a request by email.

- [x] **Add approved proactive follow-ups and optional Gmail linking on the landing page.**
  After phone verification, users can approve a first check-in and weekly iMessage
  follow-ups for up to 90 days. They can snooze or pause these in Messages. Optional
  read-only Gmail OAuth monitors possible new payment notices while approval is
  active. Google OAuth credentials must be configured before Gmail is usable.
  See `more-time/docs/follow-ups-and-email.md` for setup and operating limits.

- [ ] **Add case-specific, deadline-aware follow-ups.**
  Use confirmed deadlines, planned calls, and expected response dates to offer
  relevant schedules. The current worker sends a general case check-in on the
  schedule approved by the user.

- [ ] **Offer a prefilled email form if the call doesn’t help or the user prefers email.**
  Give the user a verified billing-office number and a short call script first.
  If they report that the call didn’t produce a clear answer or useful next step,
  or they would rather email, open a simple contact-style form. Prefill the
  biller’s email address, subject, and message using verified contact information,
  the bill details, and any call outcome. Let the user review and edit the email,
  and enter their own email address for replies. Send only when they click Send.
  Show whether the send succeeded or failed and prevent duplicate submissions.
  Keep this to one outgoing email; receiving replies, managing threads, and
  automatic follow-ups are out of scope.

- [x] **Add public internet research for biller contacts and local questions.**
  Gemini Google Search supplies attributed excerpts and source links for contact,
  policy, assistance and legal-term questions. Structured synthesis preserves case
  memory, validates cited contacts, and gives an honest fallback when research fails.

- [ ] **Persist full research evidence and broaden source-quality evaluation.**
  Replies retain source links and checked dates; complete excerpts and grounding
  metadata remain transient. Evaluate jurisdiction, source authority, freshness,
  contact department and applicability across more cases.

- [x] **Implement a structured prompt and response contract for the fast model.**
  Versioned extraction/chat instructions, separate statement records, source
  quotes, persistent case memory and a consistent iMessage formatter now provide
  a direct answer, concrete next step, who to contact and at most one necessary
  question. The backend calculates installment counts, suppresses known questions,
  distinguishes printed from verified contacts and handles common action-status
  questions from application state. Tests and a live fictional evaluation cover
  payment plans, assistance, disputes, insurance, corrections, old notices and
  multiple bills. See [the implementation guide](more-time/docs/structured-prompt-engine.md).

- [ ] **Evaluate and tune model quality on a broader set of consented samples.**
  Compare fast models with `npm run gemini:eval`, inspect factual grounding and
  usefulness as well as latency, add real-world edge cases, and assess weight
  fine-tuning if needed and supported. Prompt tuning is implemented; trained model
  weights and a production accuracy benchmark are not.

- [x] **Add a reassuring, practical tone to the prompt and formatter.**
  Briefly acknowledge the situation, answer directly, offer specific next steps
  and use drafts to make progress. Avoid shame, repetitive filler and promises
  unsupported by tools. Keep improving tone through the evaluation work above.
  Once the email form exists, prefer “I’ve prepared an email you can edit and send.”
  Distinguish proposed actions, sent requests and confirmed biller agreements.
