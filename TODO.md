# MoreTime TODO

The Gemini bill-reading and iMessage conversation flow is working. The next stage
is to help users call their biller or send a request by email.

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

- [ ] **Add internet research for the specific biller and location.**
  Find billing-office phone numbers and email addresses from official sources.
  Retrieve current company policies, assistance programs, payment-plan terms, and
  applicable local rules using the biller and the ZIP code submitted with the
  user's phone number. Confirm the relevant service location or jurisdiction
  when needed. Save source links, retrieval dates, and supporting excerpts with
  the case. Produce specific next steps grounded in those sources, ask for any
  missing eligibility details, and explain when a contact or policy cannot be
  verified. Keep website content separate from agent instructions.

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
