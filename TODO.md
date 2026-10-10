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

- [ ] **Standardize useful output from a fast model.**
  Define a structured response contract and a consistent iMessage presentation:
  what we understand, the relevant verified option, the next action, its status,
  and at most one or two necessary questions. Show only the parts that matter for
  that turn. Preserve amounts, deadlines, source references, uncertainty, and
  action status across model choices. Build examples and evaluation cases for
  payment plans, assistance, disputes, old notices, and multiple bills; tune the
  prompts and assess model fine-tuning if needed and supported. Measure latency
  and usefulness together so fast responses remain specific and actionable.

- [ ] **Make the tone helpful, eager, and focused on resolving the issue.**
  Acknowledge the user's situation briefly, use clear conversational language,
  offer a concrete next step, and take ownership of work the agent can perform.
  Prefer “I’ve prepared an email you can edit and send” once that form is
  available. Give concise progress updates and distinguish a proposed action,
  a sent request, and an agreement confirmed by the biller. Avoid repetitive
  disclaimers, generic advice, and promises unsupported by actual actions.
